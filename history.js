/* ============================================================================
   history.js — SCOPE AIアシスタント（キャパシティ＆人員配置の予測/相談）
   - ローカルのシフト在席(state.shift/employees) × KPI Supabase のお問い合わせ実績
     を時間帯×曜日でコンパクトに集計し、/api/ai-query (Claude Opus 4.8) に渡す。
   - 「これから来月どう配置する？」等を、根拠データ付きで相談できる。
   - 会話は複数ターン保持。
   - 「今月のシフトを確定」は任意機能（Supabase shift_records への保存。未設定なら無効）。
   ============================================================================ */
(function () {
  const TABLE = 'shift_records';
  const KPI_URL = 'https://teovwpuubkefbvuuxzvo.supabase.co';
  const KPI_KEY = 'sb_publishable_9EbMAos5C2RzaBt6iFNSXg_eR7Lx0dX';
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];

  const chatHistory = [];   // {role:'user'|'assistant', content}

  function ready() { return !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY); }
  function sbHeaders(extra) {
    return Object.assign({
      apikey: window.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${window.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    }, extra || {});
  }

  // ---- (任意) 今月のシフトを Supabase に確定 ----
  async function confirmShift() {
    const state = window.ShiftApp?.state;
    if (!state) throw new Error('アプリが初期化されていません');
    const month = state.month;
    const rows = [];
    for (const [date, dayShifts] of Object.entries(state.shift || {})) {
      if (!date.startsWith(month)) continue;
      for (const [empId, cell] of Object.entries(dayShifts)) {
        if (cell.status !== 'work') continue;   // STATUS.WORK は小文字 'work'
        const emp = state.employees.find(e => e.id === empId);
        if (!emp) continue;
        rows.push({
          month, date, employee_id: empId, employee_name: emp.name,
          role: (emp.roles || [])[0] || '', nationality: emp.nationality || '',
          start_time: cell.start || '', end_time: cell.end || '', break_min: cell.breakMin || 0,
        });
      }
    }
    if (rows.length === 0) throw new Error('確定するWORKシフトが見つかりません');
    const res = await fetch(`${window.SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`Supabase: ${await res.text()}`);
    return rows.length;
  }

  // ---- KPI Supabase: 時間帯別ボリューム ----
  async function fetchBands(month) {
    const [y, m] = month.split('-').map(Number);
    const dim = new Date(y, m, 0).getDate();
    const start = `${month}-01`, end = `${month}-${String(dim).padStart(2, '0')}`;
    const url = `${KPI_URL}/rest/v1/v_staffing_volume_bands`
      + `?select=contact_date,band_id,total_vol,demand_vol,missed`
      + `&contact_date=gte.${start}&contact_date=lte.${end}&limit=3000`;
    const res = await fetch(url, { headers: { apikey: KPI_KEY, Authorization: `Bearer ${KPI_KEY}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    return res.json();
  }

  // ---- ローカル在席（DE除く＝お問い合わせ対応可能人数） ----
  function staffedExclDE(date, band) {
    const emps = window.ShiftApp.staffedEmployeesInBand(date, band);
    return emps.filter(e => { const r = e.roles || []; return !r.length || !r.every(x => x === 'DE'); }).length;
  }
  function monthsWithShift() {
    const A = window.ShiftApp;
    const set = new Set();
    for (const d in (A.state.shift || {})) {
      if (Object.values(A.state.shift[d] || {}).some(c => c && c.status === 'work')) set.add(d.slice(0, 7));
    }
    if (A.state.month) set.add(A.state.month);   // 現在の対象月も含める
    return [...set].sort();
  }

  // ---- AIに渡すコンパクトな文脈テキストを構築 ----
  async function buildContextText() {
    const A = window.ShiftApp;
    const bands = A.TIME_BANDS;
    const months = monthsWithShift();
    const today = new Date().toISOString().slice(0, 10);
    const emps = A.state.employees || [];

    const byNat = {}, roleCount = {};
    for (const e of emps) {
      const k = `${e.nationality || '?'}/${e.employment || '?'}`;
      byNat[k] = (byNat[k] || 0) + 1;
      for (const r of (e.roles || [])) roleCount[r] = (roleCount[r] || 0) + 1;
    }

    const L = [];
    L.push(`今日: ${today} / 現在の対象月: ${A.state.month}`);
    L.push(`オペレーター名簿: 計${emps.length}名 (${Object.entries(byNat).map(([k, v]) => `${k}:${v}`).join(', ')})`);
    L.push(`役割内訳(在席対応): ${Object.entries(roleCount).map(([k, v]) => `${k}:${v}`).join(', ')} ※DEはお問い合わせ非対応`);
    L.push(`時間帯: ${bands.map(b => `${b.id}(${b.label})`).join(' / ')}`);
    L.push('');

    for (const month of months) {
      // 在席（ローカルシフト）
      const sBand = {}, sDowBand = {};
      for (const b of bands) sBand[b.id] = { sum: 0, n: 0 };
      const [y, m] = month.split('-').map(Number);
      const dim = new Date(y, m, 0).getDate();
      let shiftDays = 0;
      for (let day = 1; day <= dim; day++) {
        const date = `${month}-${String(day).padStart(2, '0')}`;
        const ds = A.state.shift[date];
        if (!ds || !Object.values(ds).some(c => c && c.status === 'work')) continue;
        shiftDays++;
        const dow = A.getDow(date);
        for (const b of bands) {
          const st = staffedExclDE(date, b);
          sBand[b.id].sum += st; sBand[b.id].n++;
          const k = dow + '|' + b.id;
          (sDowBand[k] ||= { sum: 0, n: 0 }); sDowBand[k].sum += st; sDowBand[k].n++;
        }
      }

      // 実績（Supabase）
      const vBand = {}, vDowBand = {}, dowDays = {};
      for (const b of bands) vBand[b.id] = { demand: 0, missed: 0, total: 0 };
      let volDays = 0, volErr = null;
      try {
        const rows = await fetchBands(month);
        const dateSet = new Set();
        for (const r of rows) {
          const bid = r.band_id;
          (vBand[bid] ||= { demand: 0, missed: 0, total: 0 });
          vBand[bid].demand += (+r.demand_vol || 0);
          vBand[bid].missed += (+r.missed || 0);
          vBand[bid].total += (+r.total_vol || 0);
          dateSet.add(r.contact_date);
          const dow = A.getDow(r.contact_date), k = dow + '|' + bid;
          (vDowBand[k] ||= { demand: 0, missed: 0 });
          vDowBand[k].demand += (+r.demand_vol || 0);
          vDowBand[k].missed += (+r.missed || 0);
        }
        volDays = dateSet.size;
        for (const d of dateSet) { const dw = A.getDow(d); dowDays[dw] = (dowDays[dw] || 0) + 1; }
      } catch (e) { volErr = e.message; }

      L.push(`# ${month}  (シフト${shiftDays}日 / 実績${volDays}日)`);
      if (shiftDays === 0) L.push('（この月のシフト在席データなし）');
      if (volErr) L.push(`（お問い合わせ実績の取得に失敗: ${volErr}）`);
      else if (volDays === 0) L.push('（この月のお問い合わせ実績なし＝範囲外/未取込）');

      // 時間帯別の平均
      L.push('時間帯 | 平均在席/日(DE除) | 平均要対応/日 | 平均Missed/日 | Missed率');
      for (const b of bands) {
        const st = sBand[b.id].n ? sBand[b.id].sum / sBand[b.id].n : 0;
        const dv = volDays ? (vBand[b.id]?.demand || 0) / volDays : 0;
        const mv = volDays ? (vBand[b.id]?.missed || 0) / volDays : 0;
        const mr = (vBand[b.id]?.demand) ? (vBand[b.id].missed / vBand[b.id].demand * 100) : 0;
        L.push(`${b.id} | ${st.toFixed(1)} | ${dv.toFixed(0)} | ${mv.toFixed(1)} | ${mr.toFixed(1)}%`);
      }

      // 取りこぼし(曜日×時間帯)の上位＝増員候補
      if (volDays) {
        const combos = [];
        for (const k in vDowBand) {
          const [dw, bid] = k.split('|');
          const d = dowDays[dw] || 1;
          const avgMiss = vDowBand[k].missed / d;
          const avgDem = vDowBand[k].demand / d;
          const s = sDowBand[k];
          const avgStaff = s && s.n ? s.sum / s.n : 0;
          if (avgMiss > 0) combos.push({ dw: +dw, bid, avgMiss, avgDem, avgStaff });
        }
        combos.sort((a, b) => b.avgMiss - a.avgMiss);
        if (combos.length) {
          L.push('取りこぼし上位(曜日×時間帯, Missed/日 降順):');
          for (const c of combos.slice(0, 6)) {
            L.push(`  ${DOW[c.dw]}曜 ${c.bid}: Missed${c.avgMiss.toFixed(1)}/日, 要対応${c.avgDem.toFixed(0)}/日, 在席${c.avgStaff.toFixed(1)}`);
          }
        }
      }
      L.push('');
    }

    // ---- 予約(onhand): 新規予約数=予約ボリューム / 販売数=稼働(売れた部屋数) ----
    const bk = A.state.bookings || {};
    const bkMonths = [...new Set(Object.keys(bk).map(d => d.slice(0, 7)))].sort();
    if (bkMonths.length) {
      const todayM = today.slice(0, 7);
      L.push('# 予約(onhand) — 新規予約数=その日に入った予約(予約ボリューム) / 販売数=稼働(売れた部屋数)');
      L.push('月 | 新規予約 平均/日 (計) | 販売(稼働) 平均/日');
      for (const m of bkMonths) {
        let res = 0, sold = 0, dres = 0, dsold = 0;
        for (const d in bk) {
          if (d.slice(0, 7) !== m) continue;
          const b = bk[d];
          if (b.res > 0) { res += b.res; dres++; }
          if (b.sold > 0) { sold += b.sold; dsold++; }
        }
        const tag = m > todayM ? ' (来月以降=オンザブック/予約済み)' : (m === todayM ? ' (当月)' : '');
        L.push(`${m}${tag} | ${dres ? Math.round(res / dres) : 0} (計${res}) | ${dsold ? Math.round(sold / dsold) : 0}`);
      }
      L.push('※来月以降の販売(稼働)は既に入っている予約(オンザブック)。新規予約・稼働が多い月/曜日ほどお問い合わせも増える前提で、来月の必要人員を考える。');
      L.push('');
    }
    return L.join('\n');
  }

  // ---- Chat UI ----
  function addMsg(log, role, text) {
    const d = document.createElement('div');
    d.className = `chat-msg chat-${role}`;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function init() {
    const confirmBtn = document.getElementById('btn-confirm-shift');
    const sendBtn = document.getElementById('history-chat-send');
    const input = document.getElementById('history-chat-input');
    const log = document.getElementById('history-chat-log');
    if (!sendBtn || !input || !log) return;

    // 任意: Supabase 確定ボタン（未設定なら案内のみ）
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        if (!ready()) { alert('Supabase未設定のためスキップ可。AI相談は設定不要で使えます。'); return; }
        const month = window.ShiftApp?.state?.month || '';
        if (!confirm(`${month} のシフト(WORKのみ)を Supabase に確定しますか？`)) return;
        confirmBtn.disabled = true; confirmBtn.textContent = '保存中…';
        try {
          const n = await confirmShift();
          addMsg(log, 'system', `✅ ${month} のシフト ${n} 件を確定しました。`);
        } catch (e) {
          addMsg(log, 'error', '❌ 確定失敗: ' + e.message);
        } finally { confirmBtn.disabled = false; confirmBtn.textContent = '今月のシフトを確定'; }
      });
    }

    async function send(q0) {
      const q = (q0 != null ? q0 : input.value).trim();
      if (!q) return;
      input.value = '';
      addMsg(log, 'user', q);
      const thinking = addMsg(log, 'assistant', '考え中…（実績データを集計して Claude に問い合わせています）');
      sendBtn.disabled = true;
      try {
        const contextText = await buildContextText();
        const res = await fetch('/api/ai-query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, contextText, history: chatHistory.slice(-8) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data.error || 'AI query failed') + (data.detail ? `: ${data.detail}` : ''));
        thinking.textContent = data.answer;
        thinking.classList.add('done');
        chatHistory.push({ role: 'user', content: q });
        chatHistory.push({ role: 'assistant', content: data.answer });
      } catch (e) {
        thinking.textContent = '❌ ' + e.message;
        thinking.classList.add('error');
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    sendBtn.addEventListener('click', () => send());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    // 例: 質問チップ
    document.querySelectorAll('#history-example-chips [data-q]').forEach(el => {
      el.addEventListener('click', () => send(el.dataset.q));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SCOPEAssistant = { buildContextText };
})();
