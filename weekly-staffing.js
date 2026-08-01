/* ============================================================================
   weekly-staffing.js — 週次シフト稼働可視化 (TSK-103 / v1・半手動ドラフト)
   - 直近の「完全なMon-Sun週」を自動判定し、時間帯×曜日の 実人数 vs 想定人数 を突合。
   - 翌週は直近4週の同(曜日×バンド)demand_volを4:3:2:1加重平均→想定人数(A案)で理論値化し、
     翌週のシフト予定と比較して手当て候補を抽出。
   - 夜間(21-02+02-04)は 🔴無人Miss / 🟡有人Miss の2段階で検知(閾値=0%＝missed発生で即フラグ)。
   - 祝日/イベント補正メモとアクション台帳は手動入力（ローカル保存・Phase3でSupabase化）。
   依存: window.ShiftApp (TIME_BANDS / staffedEmployeesInBand / staffedEmployeesAtHour)
   根拠: DESIGN_TSK-103.md §8（2026-07-04 Shuya確定）
   ============================================================================ */
(function () {
  const KPI_URL = 'https://teovwpuubkefbvuuxzvo.supabase.co';
  const KPI_KEY = 'sb_publishable_9EbMAos5C2RzaBt6iFNSXg_eR7Lx0dX';
  const A = () => window.ShiftApp;

  const NIGHT_EXTRA_HOURS = [2, 3];          // 21-02バンドに加え、02-04も夜間として補完監視
  const WEEK_LOOKBACK_WEEKS = 9;             // キャパ推定に使う遡り週数(当週含む)
  const LEDGER_KEY = 'sqa-weekly-staffing-ledger-v1';
  const HOLIDAY_KEY = 'sqa-weekly-staffing-holiday-note-v1';
  const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  let rendering = false;

  // ---- 日付ユーティリティ（app.jsと同じくローカルDateで曜日を扱う）----
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayKey() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }
  function dow(ymd) { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
  function mondayOf(ymd) { const w = dow(ymd); return addDays(ymd, w === 0 ? -6 : -(w - 1)); }
  function weekDates(mondayStr) { return Array.from({ length: 7 }, (_, i) => addDays(mondayStr, i)); }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function median(arr) {
    if (!arr || !arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function pct(v) { return v == null ? '—' : `${(v * 100).toFixed(1)}%`; }
  function pctSigned(v) { return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}pt`; }

  // ---- Supabase fetch ----
  async function fetchBandRows(startDate, endDate) {
    const url = `${KPI_URL}/rest/v1/v_staffing_volume_bands?select=contact_date,band_id,total_vol,demand_vol,missed,mail_vol`
      + `&contact_date=gte.${startDate}&contact_date=lte.${endDate}&limit=2000`;
    const res = await fetch(url, { headers: { apikey: KPI_KEY, Authorization: `Bearer ${KPI_KEY}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async function fetchNightHourRows(startDate, endDate) {
    const url = `${KPI_URL}/rest/v1/v_staffing_volume_hourly?select=contact_date,contact_hour,total_vol,demand_vol,missed,mail_vol`
      + `&contact_date=gte.${startDate}&contact_date=lte.${endDate}&contact_hour=in.(${NIGHT_EXTRA_HOURS.join(',')})&limit=2000`;
    const res = await fetch(url, { headers: { apikey: KPI_KEY, Authorization: `Bearer ${KPI_KEY}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // ---- 在席（DE除く固定 — §2定義）----
  function empCounts(emp) {
    const roles = emp.roles || [];
    if (!roles.length) return true;
    return !roles.every(r => r === 'DE');
  }
  // staffedEmployeesInBand は {id,label,startH,endH} のバンド"オブジェクト"を要求するため、
  // バンドID文字列(集計上のキーとして使う)→オブジェクトの対応をrender()内で都度更新して保持する。
  let bandById = {};
  function staffedForBand(date, bandId) { return A().staffedEmployeesInBand(date, bandById[bandId]).filter(empCounts).length; }
  function staffedForHour(date, hour) { return A().staffedEmployeesAtHour(date, hour).filter(empCounts).length; }

  // ---- キャパ自動推定（バンド別、完全な日のdemand/staffed中央値）----
  function estimateCapacity(byDate, bandIds, staffedMap, completeSet) {
    const samples = {};
    for (const date in byDate) {
      if (!completeSet.has(date)) continue;
      for (const b of bandIds) {
        const v = byDate[date][b];
        if (!v || v.demand <= 0) continue;
        const staffed = staffedMap[date]?.[b];
        if (!staffed) continue;
        (samples[b] ||= []).push(v.demand / staffed);
      }
    }
    const cap = {};
    for (const b of bandIds) { cap[b] = median(samples[b]); cap[b + '_n'] = samples[b]?.length || 0; }
    return cap;
  }
  function requiredFor(demand, cap) { return (cap && cap > 0) ? Math.ceil(demand / cap) : null; }

  // ---- localStorage: 祝日補正メモ / アクション台帳 ----
  function loadLedger() { try { return JSON.parse(localStorage.getItem(LEDGER_KEY) || '[]'); } catch (e) { return []; } }
  function saveLedger(rows) { localStorage.setItem(LEDGER_KEY, JSON.stringify(rows)); }
  function loadHolidayNote(weekKey) {
    try { return (JSON.parse(localStorage.getItem(HOLIDAY_KEY) || '{}'))[weekKey] || ''; } catch (e) { return ''; }
  }
  function saveHolidayNote(weekKey, text) {
    let obj = {};
    try { obj = JSON.parse(localStorage.getItem(HOLIDAY_KEY) || '{}'); } catch (e) {}
    obj[weekKey] = text;
    localStorage.setItem(HOLIDAY_KEY, JSON.stringify(obj));
  }

  // ---- メイン ----
  async function render() {
    if (rendering) return;
    rendering = true;
    const A0 = A();
    const status = document.getElementById('ws-status');
    status.textContent = '読込中… (Supabase からボリュームを取得)';

    try {
      const today = todayKey();
      const fetchStart = addDays(today, -90);
      const rows = await fetchBandRows(fetchStart, today);
      if (!rows.length) {
        status.innerHTML = '<span style="color:#c0392b">直近90日のボリュームデータがありません</span>';
        rendering = false; return;
      }
      const byDate = {};
      let lastDataDate = null;
      for (const r of rows) {
        (byDate[r.contact_date] ||= {})[r.band_id] = { total: +r.total_vol, demand: +r.demand_vol, missed: +r.missed, mail: +r.mail_vol };
        if (!lastDataDate || r.contact_date > lastDataDate) lastDataDate = r.contact_date;
      }

      // 当週(直近の完全なMon-Sun) / 翌週 / WoW比較用の前週
      const lastMonday = mondayOf(lastDataDate);
      const lastSunday = addDays(lastMonday, 6);
      const curMonday = (lastDataDate === lastSunday) ? lastMonday : addDays(lastMonday, -7);
      const curSunday = addDays(curMonday, 6);
      const nextMonday = addDays(curMonday, 7);
      const nextSunday = addDays(nextMonday, 6);
      const prevMonday = addDays(curMonday, -7);

      const bandIds = A0.TIME_BANDS.map(b => b.id);
      bandById = {};
      A0.TIME_BANDS.forEach(b => { bandById[b.id] = b; });

      // キャパ推定ウィンドウ
      const capWindowStart = addDays(curMonday, -7 * (WEEK_LOOKBACK_WEEKS - 1));
      const capDates = [];
      for (let d = capWindowStart; d <= curSunday; d = addDays(d, 1)) capDates.push(d);

      const staffedMap = {};
      for (const date of capDates) { staffedMap[date] = {}; for (const b of bandIds) staffedMap[date][b] = staffedForBand(date, b); }

      // 完全な日判定（volume.jsと同ロジック）
      const dayMail = {}, dayTotal = {};
      for (const date of capDates) {
        let m = 0, t = 0;
        for (const b of bandIds) { const v = byDate[date]?.[b]; if (v) { m += v.mail; t += v.total; } }
        dayMail[date] = m; dayTotal[date] = t;
      }
      const hasMail = Object.values(dayMail).some(v => v > 0);
      const completeSet = hasMail
        ? new Set(capDates.filter(d => dayMail[d] > 0))
        : new Set(capDates.filter(d => dayTotal[d] >= (median(Object.values(dayTotal)) || 0) * 0.4));

      const cap = estimateCapacity(byDate, bandIds, staffedMap, completeSet);

      // ---- 当週: バンド×曜日 ギャップ ----
      const curDates = weekDates(curMonday);
      const grid = {};
      let weekDemand = 0, weekMissed = 0, shortageCount = 0;
      for (const date of curDates) {
        grid[date] = {};
        for (const b of bandIds) {
          const v = byDate[date]?.[b];
          const staffed = staffedMap[date]?.[b] ?? staffedForBand(date, b);
          const demand = v?.demand ?? 0;
          const missed = v?.missed ?? 0;
          const required = requiredFor(demand, cap[b]);
          const gap = (required != null) ? staffed - required : null;
          const missedRate = demand > 0 ? missed / demand : (v ? 0 : null);
          grid[date][b] = { demand, missed, staffed, required, gap, missedRate, hasVol: !!v };
          if (v) { weekDemand += demand; weekMissed += missed; }
          if (gap != null && gap < 0) shortageCount++;
        }
      }
      const weekMissRate = weekDemand > 0 ? weekMissed / weekDemand : null;

      let prevDemand = 0, prevMissed = 0;
      for (const date of weekDates(prevMonday)) for (const b of bandIds) { const v = byDate[date]?.[b]; if (v) { prevDemand += v.demand; prevMissed += v.missed; } }
      const prevMissRate = prevDemand > 0 ? prevMissed / prevDemand : null;
      const wowDeltaPt = (weekMissRate != null && prevMissRate != null) ? (weekMissRate - prevMissRate) * 100 : null;

      // ---- 夜間 (21-02 + 02-04) ----
      const nightHourRows = await fetchNightHourRows(curMonday, curSunday);
      const nightHourByDate = {};
      for (const r of nightHourRows) (nightHourByDate[r.contact_date] ||= {})[r.contact_hour] = { demand: +r.demand_vol, missed: +r.missed };

      let nightDemand = 0, nightMissed = 0;
      const nightAlerts = [];
      for (const date of curDates) {
        const bcell = grid[date]['21-02'];
        if (bcell.hasVol) {
          nightDemand += bcell.demand; nightMissed += bcell.missed;
          if (bcell.missed > 0 && bcell.staffed === 0) nightAlerts.push({ date, label: '21-02', level: 'red', missed: bcell.missed, staffed: 0, rate: bcell.missedRate });
          else if (bcell.missed > 0 && bcell.staffed >= 1) nightAlerts.push({ date, label: '21-02', level: 'yellow', missed: bcell.missed, staffed: bcell.staffed, rate: bcell.missedRate });
        }
        for (const h of NIGHT_EXTRA_HOURS) {
          const hv = nightHourByDate[date]?.[h];
          if (!hv) continue;
          nightDemand += hv.demand; nightMissed += hv.missed;
          const staffedH = staffedForHour(date, h);
          const rate = hv.demand > 0 ? hv.missed / hv.demand : null;
          if (hv.missed > 0 && staffedH === 0) nightAlerts.push({ date, label: `${h}時`, level: 'red', missed: hv.missed, staffed: 0, rate });
          else if (hv.missed > 0 && staffedH >= 1) nightAlerts.push({ date, label: `${h}時`, level: 'yellow', missed: hv.missed, staffed: staffedH, rate });
        }
      }
      const nightMissRate = nightDemand > 0 ? nightMissed / nightDemand : null;
      nightAlerts.sort((a, b) => a.date.localeCompare(b.date));

      // ---- 翌週理論値(A案・4:3:2:1加重平均) vs シフト予定 ----
      const nextDates = weekDates(nextMonday);
      const nextGrid = {};
      const shortfalls = [];
      const weights = [4, 3, 2, 1];
      for (const date of nextDates) {
        nextGrid[date] = {};
        for (const b of bandIds) {
          let wsum = 0, vsum = 0;
          for (let k = 1; k <= 4; k++) {
            const v = byDate[addDays(date, -7 * k)]?.[b];
            if (!v) continue;
            wsum += weights[k - 1]; vsum += weights[k - 1] * v.demand;
          }
          const forecastDemand = wsum > 0 ? vsum / wsum : null;
          const requiredNext = (forecastDemand != null) ? requiredFor(forecastDemand, cap[b]) : null;
          const scheduled = staffedForBand(date, b);
          const gapNext = (requiredNext != null) ? scheduled - requiredNext : null;
          nextGrid[date][b] = { forecastDemand, requiredNext, scheduled, gapNext };
          if (gapNext != null && gapNext < 0) shortfalls.push({ date, band: b, gapNext, scheduled, requiredNext });
        }
      }
      shortfalls.sort((a, b) => a.gapNext - b.gapNext);
      const topShortfalls = shortfalls.slice(0, 5);

      // ---- 描画 ----
      renderHeaderKPI({ weekMissRate, wowDeltaPt, nightMissRate, shortageCount, curMonday, curSunday });
      renderHeatmap(curDates, bandIds, grid);
      renderNextWeek(nextDates, bandIds, nextGrid, topShortfalls);
      renderNightAlerts(nightAlerts);
      renderCapacityTable(bandIds, cap);
      renderLedgerAndNote(curMonday);

      status.innerHTML = `当週(振り返り): <b>${curMonday}〜${curSunday}</b> ／ 翌週(プラン): <b>${nextMonday}〜${nextSunday}</b>`
        + ` ／ データ最終取込日: ${lastDataDate} ／ キャパ推定期間: ${capWindowStart}〜${curSunday}`
        + ` ／ <span class="hint">実人数=シフト予定代替・DE除く。詳細はセルにマウスオーバー</span>`;
    } catch (e) {
      status.innerHTML = `<span style="color:#c0392b">取得失敗: ${escapeHtml(String(e.message || e))}</span>`;
    } finally {
      rendering = false;
    }
  }

  // ---- レンダリング: ヘッダKPI ----
  function renderHeaderKPI({ weekMissRate, wowDeltaPt, nightMissRate, shortageCount, curMonday, curSunday }) {
    const el = document.getElementById('ws-header-kpi');
    const prevWeekResults = loadLedger().filter(r => r.week === addDays(curMonday, -7) && r.result);
    const ok = prevWeekResults.filter(r => r.result === '○').length;
    const watch = prevWeekResults.filter(r => r.result === '△').length;
    const ng = prevWeekResults.filter(r => r.result === '×').length;
    const actionSummary = prevWeekResults.length ? `○${ok} △${watch} ×${ng}` : '記録なし';
    el.innerHTML = `
      <div class="card">
        <h3>週次ライブMiss率 (${curMonday}〜${curSunday})</h3>
        <div class="big-number">${pct(weekMissRate)}</div>
        <div class="hint">WoW ${pctSigned(wowDeltaPt)}</div>
      </div>
      <div class="card">
        <h3>夜間Miss率 (21-02+02-04)</h3>
        <div class="big-number" style="${nightMissRate > 0 ? 'color:var(--danger)' : ''}">${pct(nightMissRate)}</div>
        <div class="hint">目標: できる限りゼロ（閾値0%＝missed発生で即フラグ）</div>
      </div>
      <div class="card">
        <h3>人員不足コマ数</h3>
        <div class="big-number">${shortageCount}<span style="font-size:16px;color:var(--muted)"> / 35</span></div>
        <div class="hint">実−想定 &lt; 0 のバンド×曜日</div>
      </div>
      <div class="card">
        <h3>前週打ち手の効果</h3>
        <div class="big-number" style="font-size:20px">${escapeHtml(actionSummary)}</div>
        <div class="hint">下部アクション台帳を参照</div>
      </div>`;
  }

  function gapStyle(gap) {
    if (gap == null) return '';
    if (gap < 0) return `background:rgba(192,57,43,${Math.min(0.85, 0.25 + Math.abs(gap) * 0.18)})`;
    if (gap > 0) return `background:rgba(41,128,185,${Math.min(0.6, 0.12 + gap * 0.1)})`;
    return 'background:rgba(39,174,96,0.18)';
  }

  // ---- レンダリング: 当週ヒートマップ ----
  function renderHeatmap(dates, bandIds, grid) {
    const wrap = document.getElementById('ws-heatmap-wrap');
    const table = document.createElement('table');
    table.className = 'heatmap sf-heatmap';
    table.innerHTML = `<thead><tr><th>時間帯</th>${dates.map(d => `<th>${DOW_LABELS[dow(d)]} ${d.slice(5)}</th>`).join('')}</tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const b of bandIds) {
      const tds = dates.map(d => {
        const c = grid[d][b];
        const warn = (c.missed > 0) ? ' ⚠' : '';
        const text = c.gap == null ? '—' : `${c.gap > 0 ? '+' : ''}${c.gap}`;
        const title = `実${c.staffed} / 想定${c.required ?? '—'} / 要対応${c.demand} / Missed${c.missed}`
          + (c.missedRate != null ? `(${(c.missedRate * 100).toFixed(1)}%)` : '');
        return `<td style="${gapStyle(c.gap)}" title="${title}">${text}${warn}</td>`;
      }).join('');
      tbody.innerHTML += `<tr><td class="type-cell">${b}</td>${tds}</tr>`;
    }
    table.appendChild(tbody);
    wrap.innerHTML = ''; wrap.appendChild(table);
  }

  // ---- レンダリング: 翌週プラン ----
  function renderNextWeek(dates, bandIds, nextGrid, topShortfalls) {
    const wrap = document.getElementById('ws-next-wrap');
    const table = document.createElement('table');
    table.className = 'heatmap sf-heatmap';
    table.innerHTML = `<thead><tr><th>時間帯</th>${dates.map(d => `<th>${DOW_LABELS[dow(d)]} ${d.slice(5)}</th>`).join('')}</tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const b of bandIds) {
      const tds = dates.map(d => {
        const c = nextGrid[d][b];
        const text = c.requiredNext == null ? '—' : `${c.scheduled}/${c.requiredNext}`;
        const title = `シフト予定${c.scheduled} / 理論値${c.requiredNext ?? '—'}（予測需要${c.forecastDemand != null ? c.forecastDemand.toFixed(1) : '—'}） / ギャップ${c.gapNext ?? '—'}`;
        return `<td style="${gapStyle(c.gapNext)}" title="${title}">${text}</td>`;
      }).join('');
      tbody.innerHTML += `<tr><td class="type-cell">${b}</td>${tds}</tr>`;
    }
    table.appendChild(tbody);
    wrap.innerHTML = ''; wrap.appendChild(table);

    const list = document.getElementById('ws-next-list');
    if (!topShortfalls.length) {
      list.innerHTML = `<p class="hint">翌週、理論値を下回るコマはありません。</p>`;
      return;
    }
    list.innerHTML = `<p class="hint">手当て候補（不足が大きい順・上位${topShortfalls.length}件）</p><ul class="sf-bullets">`
      + topShortfalls.map(s => {
        const action = s.band === '21-02' ? 'AI/留守番委譲 or 夜間シフト増員を検討' : 'シフト追加・振替を検討';
        return `<li>${s.date}(${DOW_LABELS[dow(s.date)]}) ${s.band} ： 予定${s.scheduled}人 / 理論値${s.requiredNext}人（${s.gapNext}） — ${action}</li>`;
      }).join('') + '</ul>';
  }

  // ---- レンダリング: 夜間アラート ----
  function renderNightAlerts(alerts) {
    const el = document.getElementById('ws-night-alerts');
    if (!alerts.length) {
      el.innerHTML = `<p style="color:var(--green)">✅ 夜間クリア（当週、夜間帯でのMissedはありませんでした）</p>`;
      return;
    }
    el.innerHTML = '<ul class="sf-bullets">' + alerts.map(a => {
      const icon = a.level === 'red' ? '🔴無人Miss' : '🟡有人Miss';
      const rateTxt = a.rate != null ? `（Miss率${(a.rate * 100).toFixed(1)}%）` : '';
      return `<li>${a.date}(${DOW_LABELS[dow(a.date)]}) ${a.label} — ${icon}：missed${a.missed}件 / 在席${a.staffed}人 ${rateTxt}</li>`;
    }).join('') + '</ul>';
  }

  // ---- レンダリング: キャパ推定値（レビュー用）----
  function renderCapacityTable(bandIds, cap) {
    const wrap = document.getElementById('ws-cap-wrap');
    const table = document.createElement('table');
    table.className = 'data-table sf-cap-table';
    table.innerHTML = `<thead><tr><th>時間帯</th>${bandIds.map(b => `<th>${b}</th>`).join('')}</tr></thead>`
      + `<tbody>`
      + `<tr><td>推定キャパ(件/人)</td>${bandIds.map(b => `<td>${cap[b] != null ? cap[b].toFixed(1) : '—'}</td>`).join('')}</tr>`
      + `<tr><td>サンプル日数(n)</td>${bandIds.map(b => `<td>${cap[b + '_n'] || 0}</td>`).join('')}</tr>`
      + `</tbody>`;
    wrap.innerHTML = ''; wrap.appendChild(table);
  }

  // ---- レンダリング: 補正メモ / アクション台帳（手動）----
  function renderLedgerAndNote(curMonday) {
    const note = document.getElementById('ws-holiday-note');
    note.value = loadHolidayNote(curMonday);
    note.dataset.week = curMonday;
    note.onchange = () => saveHolidayNote(curMonday, note.value);
    renderLedgerTable();
  }

  function renderLedgerTable() {
    const wrap = document.getElementById('ws-ledger-wrap');
    const rows = loadLedger();
    if (!rows.length) {
      wrap.innerHTML = '<p class="hint">台帳はまだありません。「＋ 台帳に行を追加」から記入してください。</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = `<thead><tr><th>対象週(月曜)</th><th>対象コマ</th><th>仮説</th><th>期待効果</th><th>結果</th><th></th></tr></thead>`;
    const tbody = document.createElement('tbody');
    rows.slice().sort((a, b) => b.week.localeCompare(a.week)).forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="text" value="${escapeHtml(row.week)}" data-field="week" placeholder="YYYY-MM-DD" style="width:90px"></td>
        <td><input type="text" value="${escapeHtml(row.slot)}" data-field="slot" placeholder="例:火 21-02" style="width:110px"></td>
        <td><input type="text" value="${escapeHtml(row.hypothesis)}" data-field="hypothesis" placeholder="例:夜間+1名" style="width:180px"></td>
        <td><input type="text" value="${escapeHtml(row.expected)}" data-field="expected" placeholder="例:Miss率-3pt" style="width:150px"></td>
        <td><select data-field="result">
          <option value="" ${row.result === '' ? 'selected' : ''}>—</option>
          <option value="○" ${row.result === '○' ? 'selected' : ''}>○ 継続</option>
          <option value="△" ${row.result === '△' ? 'selected' : ''}>△ 様子見</option>
          <option value="×" ${row.result === '×' ? 'selected' : ''}>× 撤回</option>
        </select></td>
        <td class="actions-cell"><button class="del" data-id="${row.id}">削除</button></td>`;
      tr.querySelectorAll('[data-field]').forEach(input => {
        input.addEventListener('change', () => {
          const rows2 = loadLedger();
          const r = rows2.find(x => x.id === row.id);
          if (r) { r[input.dataset.field] = input.value; saveLedger(rows2); }
        });
      });
      tr.querySelector('.del').addEventListener('click', () => {
        saveLedger(loadLedger().filter(x => x.id !== row.id));
        renderLedgerTable();
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.innerHTML = ''; wrap.appendChild(table);
  }

  // ---- イベント ----
  function bind() {
    document.getElementById('ws-reload')?.addEventListener('click', render);
    document.getElementById('ws-ledger-add')?.addEventListener('click', () => {
      const rows = loadLedger();
      rows.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, week: mondayOf(todayKey()), slot: '', hypothesis: '', expected: '', result: '' });
      saveLedger(rows);
      renderLedgerTable();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.WeeklyStaffing = { render };
})();
