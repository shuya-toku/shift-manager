/* ============================================================================
   volume.js — 人員整合性 (Staffing vs Inquiry Volume)
   - お問い合わせの実ボリューム/Missedを KPI Supabase の集約ビューから取得
       毎時:   public.v_staffing_volume_hourly  (日次×時間 0-23)
       バンド: public.v_staffing_volume_bands    (日次×5時間帯)
   - シフトの在席人数(DE除く)と日×スロットで突合し、過不足・有人取りこぼしを可視化。
   - 曜日×スロットの平均パネルで曜日パターンも確認。
   - キャパ(1人あたり典型処理数)は「完全な日」の demand/staffed 中央値から自動推定。
   依存: window.ShiftApp (state / TIME_BANDS / staffedEmployeesInBand / staffedEmployeesAtHour ...)
   ============================================================================ */
(function () {
  const KPI_URL = 'https://teovwpuubkefbvuuxzvo.supabase.co';
  const KPI_KEY = 'sb_publishable_9EbMAos5C2RzaBt6iFNSXg_eR7Lx0dX';

  const cache = {};   // `${month}|${gran}` -> { byDate: {date:{slotId:{total,demand,missed}}} }
  let rendering = false;

  const A = () => window.ShiftApp;

  // ---- 設定読み取り ----
  function getGran() { return document.getElementById('sf-gran')?.value || 'hour'; }
  function getMetric() { return document.getElementById('sf-metric')?.value || 'staffed'; }
  function excludedRoleSet() {
    const set = new Set();
    if (document.getElementById('sf-exclude-de')?.checked) set.add('DE');
    if (document.getElementById('sf-exclude-mgr')?.checked) set.add('Mgr');
    return set;
  }

  // ---- スロット定義 ----
  function slotsFor(gran) {
    if (gran === 'band') return A().TIME_BANDS.map(b => ({ id: b.id, label: b.label, band: b }));
    return Array.from({ length: 24 }, (_, h) => ({ id: String(h), label: String(h), hour: h }));
  }
  function hourBandClass(h) {
    if (h >= 4 && h < 7) return 'band-04';
    if (h >= 7 && h < 12) return 'band-07';
    if (h >= 12 && h < 16) return 'band-12';
    if (h >= 16 && h < 21) return 'band-16';
    return 'band-21';
  }

  // ---- Supabase fetch ----
  async function fetchRows(gran, startDate, endDate) {
    const view = gran === 'band' ? 'v_staffing_volume_bands' : 'v_staffing_volume_hourly';
    const cols = gran === 'band'
      ? 'contact_date,band_id,total_vol,demand_vol,missed,mail_vol'
      : 'contact_date,contact_hour,total_vol,demand_vol,missed,mail_vol';
    const url = `${KPI_URL}/rest/v1/${view}?select=${cols}`
      + `&contact_date=gte.${startDate}&contact_date=lte.${endDate}&limit=2000`;
    const res = await fetch(url, {
      headers: { apikey: KPI_KEY, Authorization: `Bearer ${KPI_KEY}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    return res.json();
  }
  function monthRange(month) {
    const [y, m] = month.split('-').map(Number);
    const dim = new Date(y, m, 0).getDate();
    return { start: `${month}-01`, end: `${month}-${String(dim).padStart(2, '0')}` };
  }
  async function loadMonth(month, gran) {
    const key = `${month}|${gran}`;
    if (cache[key]) return cache[key];
    const { start, end } = monthRange(month);
    const rows = await fetchRows(gran, start, end);
    const byDate = {};
    for (const r of rows) {
      const slotId = gran === 'band' ? r.band_id : String(r.contact_hour);
      (byDate[r.contact_date] ||= {})[slotId] = { total: +r.total_vol, demand: +r.demand_vol, missed: +r.missed, mail: +r.mail_vol };
    }
    cache[key] = { byDate };
    return cache[key];
  }

  // ---- Staffing ----
  function empCounts(emp, excluded) {
    const roles = emp.roles || [];
    if (!roles.length) return true;
    return !roles.every(r => excluded.has(r));   // 全ロールが除外対象の社員のみ落とす（兼任は残す）
  }
  function staffedForSlot(date, slot, excluded) {
    const emps = slot.hour != null
      ? A().staffedEmployeesAtHour(date, slot.hour)
      : A().staffedEmployeesInBand(date, slot.band);
    return emps.filter(e => empCounts(e, excluded)).length;
  }

  // ---- util ----
  function median(arr) {
    if (!arr || !arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---- キャパ自動推定（完全な日の demand/staffed 中央値）----
  function estimateCapacity(byDate, slots, staffedMap, completeSet) {
    const samples = {};
    for (const date in byDate) {
      if (!completeSet.has(date)) continue;
      for (const s of slots) {
        const v = byDate[date][s.id];
        if (!v || v.demand <= 0) continue;
        const staffed = staffedMap[date][s.id];
        if (staffed <= 0) continue;
        (samples[s.id] ||= []).push(v.demand / staffed);
      }
    }
    const cap = {};
    for (const s of slots) { cap[s.id] = median(samples[s.id]); cap[s.id + '_n'] = samples[s.id]?.length || 0; }
    return cap;
  }

  // ---- セル算出 ----
  function makeCell(v, staffed, cap, incomplete) {
    const cell = {
      total: v?.total ?? null, demand: v?.demand ?? null, missed: v?.missed ?? null,
      staffed, required: null, gap: null,
      missedRate: v && v.demand > 0 ? v.missed / v.demand : (v ? 0 : null),  // 分母=要対応(ライブ)
      staffedMissed: false, hasVol: !!v, incomplete: !!(v && incomplete),
    };
    if (v && !incomplete) {
      if (cap && cap > 0) { cell.required = Math.ceil(v.demand / cap); cell.gap = staffed - cell.required; }
      cell.staffedMissed = staffed > 0 && v.missed > 0;
    }
    return cell;
  }

  // ---- 色・文字 ----
  function cellStyle(metric, cell) {
    if (!cell || !cell.hasVol) return '';
    if (cell.incomplete) return 'background:#f1f3f5;color:#aab2bd';
    let bg = '';
    const val = metricValue(metric, cell);
    if (val == null) return '';
    if (metric === 'gap') {
      if (val < 0) bg = `rgba(192,57,43,${Math.min(0.85, 0.25 + Math.abs(val) * 0.18)})`;
      else if (val > 0) bg = `rgba(41,128,185,${Math.min(0.6, 0.12 + val * 0.1)})`;
      else bg = 'rgba(39,174,96,0.18)';
    } else if (metric === 'missed') {
      if (val > 0) bg = `rgba(192,57,43,${0.15 + Math.min(1, val / 15) * 0.7})`;
    } else if (metric === 'missedRate') {
      if (val > 0) bg = `rgba(192,57,43,${0.1 + Math.min(1, val / 0.15) * 0.7})`;
    } else if (metric === 'volume' || metric === 'demand') {
      bg = `rgba(52,152,219,${0.06 + Math.min(1, val / 120) * 0.6})`;
    } else if (metric === 'staffed') {
      if (val > 0) bg = `rgba(46,204,113,${0.08 + Math.min(1, val / 12) * 0.55})`;
    }
    return bg ? `background:${bg}` : '';
  }
  function metricValue(metric, cell) {
    switch (metric) {
      case 'gap': return cell.gap;
      case 'missed': return cell.missed;
      case 'missedRate': return cell.missedRate;
      case 'volume': return cell.total;
      case 'demand': return cell.demand;
      case 'staffed': return cell.staffed;
    }
    return null;
  }
  function cellText(metric, cell, isAvg) {
    if (!cell || !cell.hasVol) return cell && cell.staffed ? `<span class="sf-novol">·${fmt(cell.staffed, isAvg)}</span>` : '';
    const v = metricValue(metric, cell);
    if (v == null) return '—';
    if (metric === 'missedRate') return `${(v * 100).toFixed(isAvg ? 1 : 1)}%`;
    if (metric === 'gap') return (v > 0 ? '+' : '') + fmt(v, isAvg);
    return fmt(v, isAvg);
  }
  function fmt(n, isAvg) { return isAvg ? (Math.round(n * 10) / 10).toFixed(1) : `${n}`; }
  function cellTitle(cell) {
    if (!cell || !cell.hasVol) return `ボリュームデータなし / 在席${cell ? cell.staffed : 0}人`;
    return `総${cell.total} / 要対応${cell.demand} / Missed${cell.missed} (${(cell.missedRate * 100).toFixed(1)}%)`
      + `\n在席${cell.staffed}人 / 必要${cell.required ?? '—'} / ギャップ${cell.gap ?? '—'}`
      + (cell.incomplete ? '\n⚠ 部分データ（AI Call以外が未取込）' : '');
  }

  // ---- レンダリング ----
  async function render() {
    if (rendering) return;
    rendering = true;
    const A0 = A();
    const month = A0.state.month;
    const gran = getGran();
    const metric = getMetric();
    const status = document.getElementById('sf-status');
    const wrap = document.getElementById('sf-table-wrap');
    const dowWrap = document.getElementById('sf-dow-wrap');
    const summary = document.getElementById('sf-summary');
    status.textContent = '読込中… (Supabase からボリュームを取得)';
    wrap.innerHTML = ''; dowWrap.innerHTML = ''; summary.innerHTML = '';

    let data;
    try { data = await loadMonth(month, gran); }
    catch (e) { status.innerHTML = `<span style="color:#c0392b">取得失敗: ${escapeHtml(String(e.message || e))}</span>`; rendering = false; return; }

    if (Object.keys(data.byDate).length === 0) {
      status.textContent = `対象月: ${month}`;
      dowWrap.innerHTML = ''; summary.innerHTML = '';
      if (window.SQAContext) window.SQAContext.emptyState(wrap, {
        icon: '📭', title: `${month} のボリューム実績がありません`,
        reason: '取込範囲は2026-02以降です。範囲外の月か、まだ取り込まれていません。当月分はAI電話以外が遅れて入ります。',
        actions: [{ label: '対象月を切り替える', onClick: () => document.getElementById('month-input')?.focus() }],
      });
      rendering = false; return;
    }

    const slots = slotsFor(gran);
    const excluded = excludedRoleSet();
    const dates = A0.monthDates();

    // 在席マップ（1回だけ算出）
    const staffedMap = {};
    for (const date of dates) { staffedMap[date] = {}; for (const s of slots) staffedMap[date][s.id] = staffedForSlot(date, s, excluded); }

    // データ完全性: メール/電話/ビデオは月次手動取込のため、未取込日はメールが0になる。
    // メール実績がある月は「メール>0の日」を完全日とする。無い月はライブ総量の中央値40%で代替判定。
    const dayMail = {}, dayTotal = {};
    for (const d in data.byDate) {
      let m = 0, t = 0;
      for (const s of slots) { m += data.byDate[d][s.id]?.mail || 0; t += data.byDate[d][s.id]?.total || 0; }
      dayMail[d] = m; dayTotal[d] = t;
    }
    const hasMail = Object.values(dayMail).some(v => v > 0);
    let completeSet;
    if (hasMail) {
      completeSet = new Set(Object.keys(dayMail).filter(d => dayMail[d] > 0));
    } else {
      const thr = (median(Object.values(dayTotal)) || 0) * 0.4;
      completeSet = new Set(Object.keys(dayTotal).filter(d => dayTotal[d] >= thr));
    }
    const incompleteCount = Object.keys(dayTotal).length - completeSet.size;

    const cap = estimateCapacity(data.byDate, slots, staffedMap, completeSet);

    // グリッド + スロット集計
    const grid = {};
    const agg = {}; for (const s of slots) agg[s.id] = { vol: 0, demand: 0, missed: 0, staffedSum: 0, days: 0, staffedMissedDays: 0, gapSum: 0, gapDays: 0 };
    for (const date of dates) {
      grid[date] = {};
      const inc = !completeSet.has(date);
      for (const s of slots) {
        const cell = makeCell(data.byDate[date]?.[s.id], staffedMap[date][s.id], cap[s.id], inc);
        grid[date][s.id] = cell;
        if (cell.hasVol && !inc) {
          const a = agg[s.id];
          a.vol += cell.total; a.demand += cell.demand; a.missed += cell.missed;
          a.staffedSum += cell.staffed; a.days++;
          if (cell.staffedMissed) a.staffedMissedDays++;
          if (cell.gap != null) { a.gapSum += cell.gap; a.gapDays++; }
        }
      }
    }

    const anyStaff = dates.some(d => slots.some(s => grid[d][s.id].staffed > 0));
    status.innerHTML = `対象: <b>${month}</b>（${gran === 'band' ? '5時間帯' : '毎時24h'}） ／ 取得日数: ${Object.keys(data.byDate).length}日`
      + (incompleteCount ? ` ／ <span style="color:#b8860b">部分データ ${incompleteCount}日を除外（AI Call以外が未取込）</span>` : '')
      + (anyStaff ? '' : ' ／ <span style="color:#c0392b">この月のシフトが未取込です（CSV読込で在席人数が入ります）</span>');

    // クリック→理由パネル用コンテキストを保存
    ctx = { grid, gran, slots, excluded };

    // 日別ヒートマップ
    wrap.appendChild(buildDailyTable(dates, slots, grid, metric, gran));
    wrap.onclick = (e) => {
      const td = e.target.closest('.sf-clickable');
      if (td) openDetail(td.dataset.date, td.dataset.slot);
    };
    // 曜日別平均
    dowWrap.appendChild(buildDowTable(dates, slots, grid, completeSet, metric, gran));
    // サマリー
    summary.innerHTML = renderSummary(agg, cap, slots, completeSet.size, incompleteCount, gran);
    rendering = false;
  }

  function headerCells(slots, gran) {
    return slots.map(s => {
      const cls = gran === 'band' ? '' : hourBandClass(s.hour);
      return `<th class="${cls}">${s.label}</th>`;
    }).join('');
  }

  function buildDailyTable(dates, slots, grid, metric, gran) {
    const A0 = A();
    const table = document.createElement('table');
    table.className = 'heatmap sf-heatmap';
    table.innerHTML = `<thead><tr><th>日付</th>${headerCells(slots, gran)}</tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const date of dates) {
      const dow = A0.getDow(date);
      const day = parseInt(date.slice(-2), 10);
      const rowCls = (dow === 0 || A0.isKHHoliday(date) || A0.isJPHoliday(date)) ? 'sun' : '';
      const tds = slots.map(s => {
        const cell = grid[date][s.id];
        const mark = cell.staffedMissed ? '<span class="sf-dot">●</span>' : (cell.incomplete ? '<span class="sf-partial">部</span>' : '');
        const clk = (cell.missed > 0 && !cell.incomplete) ? ' sf-clickable' : '';
        return `<td class="sf-cell${clk}" data-date="${date}" data-slot="${s.id}" style="${cellStyle(metric, cell)}" title="${escapeHtml(cellTitle(cell))}">${cellText(metric, cell, false)}${mark}</td>`;
      }).join('');
      const r = document.createElement('tr');
      r.className = rowCls;
      r.innerHTML = `<td class="date-cell">${day}(${A0.DOW_LABELS[dow]})</td>${tds}`;
      tbody.appendChild(r);
    }
    table.appendChild(tbody);
    return table;
  }

  // 曜日×スロット平均（完全な日のみ）。avgセル: 在席/ボリューム/要対応/ギャップ=平均, missed=平均件/日, missedRate=合算率
  function buildDowTable(dates, slots, grid, completeSet, metric, gran) {
    const A0 = A();
    const acc = {}; // dow -> slotId -> {staffed,total,demand,missed,gap,gapN,n,smiss}
    for (let dw = 0; dw < 7; dw++) { acc[dw] = {}; for (const s of slots) acc[dw][s.id] = { staffed: 0, total: 0, demand: 0, missed: 0, gap: 0, gapN: 0, n: 0, smiss: 0 }; }
    for (const date of dates) {
      if (!completeSet.has(date)) continue;
      const dw = A0.getDow(date);
      for (const s of slots) {
        const c = grid[date][s.id]; if (!c.hasVol) continue;
        const a = acc[dw][s.id];
        a.staffed += c.staffed; a.total += c.total; a.demand += c.demand; a.missed += c.missed; a.n++;
        if (c.staffedMissed) a.smiss++;
        if (c.gap != null) { a.gap += c.gap; a.gapN++; }
      }
    }
    const table = document.createElement('table');
    table.className = 'heatmap sf-heatmap';
    table.innerHTML = `<thead><tr><th>曜日</th>${headerCells(slots, gran)}</tr></thead>`;
    const tbody = document.createElement('tbody');
    for (let dw = 0; dw < 7; dw++) {
      const rowCls = dw === 0 ? 'sun' : '';
      const tds = slots.map(s => {
        const a = acc[dw][s.id];
        if (!a.n) return `<td class="sf-cell"></td>`;
        const cell = {
          hasVol: true, incomplete: false,
          staffed: a.staffed / a.n, total: a.total / a.n, demand: a.demand / a.n,
          missed: a.missed / a.n, missedRate: a.demand > 0 ? a.missed / a.demand : 0,
          gap: a.gapN ? a.gap / a.gapN : null,
          required: null, staffedMissed: false,
        };
        const title = `平均 在席${cell.staffed.toFixed(1)}人 / 総${cell.total.toFixed(1)} / 要対応${cell.demand.toFixed(1)} / Missed${cell.missed.toFixed(1)}/日 (${(cell.missedRate*100).toFixed(1)}%)\n有人Missed ${a.smiss}/${a.n}日`;
        const dotted = a.smiss >= Math.ceil(a.n / 2) ? '<span class="sf-dot">●</span>' : '';
        // 平均Missed/日を常時表示（Missed系メトリクス選択時は重複するため出さない）
        const avgMiss = a.n ? a.missed / a.n : 0;
        const missTag = (metric !== 'missed' && metric !== 'missedRate' && avgMiss >= 0.5)
          ? `<span class="sf-mini-miss" title="平均Missed/日">✗${avgMiss.toFixed(1)}</span>` : '';
        return `<td class="sf-cell" style="${cellStyle(metric, cell)}" title="${escapeHtml(title)}">${cellText(metric, cell, true)}${dotted}${missTag}</td>`;
      }).join('');
      const r = document.createElement('tr');
      r.className = rowCls;
      r.innerHTML = `<td class="date-cell">${A0.DOW_LABELS[dw]}</td>${tds}`;
      tbody.appendChild(r);
    }
    table.appendChild(tbody);
    return table;
  }

  function renderSummary(agg, cap, slots, completeDays, incompleteCount, gran) {
    const totMissed = slots.reduce((a, s) => a + agg[s.id].missed, 0);
    const totVol = slots.reduce((a, s) => a + agg[s.id].vol, 0);
    const totDemand = slots.reduce((a, s) => a + agg[s.id].demand, 0);
    const rate = id => agg[id].demand ? agg[id].missed / agg[id].demand : 0;  // 分母=要対応(ライブ)
    const avgStaff = id => agg[id].days ? agg[id].staffedSum / agg[id].days : 0;
    // ワーストは低ボリューム帯のノイズを除くため、要対応が最大帯の15%以上ある帯に限定
    const maxDemand = Math.max(0, ...slots.map(s => agg[s.id].demand));
    const ranked = [...slots].filter(s => agg[s.id].demand >= maxDemand * 0.15).sort((a, b) => rate(b.id) - rate(a.id));
    const top = ranked.slice(0, 3);
    const unit = gran === 'band' ? '帯' : '時';
    const fmtPct = id => (rate(id) * 100).toFixed(1) + '%';

    const rows = slots.map(s => {
      const a = agg[s.id];
      const missRate = a.demand ? (a.missed / a.demand * 100).toFixed(1) + '%' : '—';
      const avgGap = a.gapDays ? (a.gapSum / a.gapDays).toFixed(1) : '—';
      return `<tr>
        <td>${s.label}${gran === 'hour' ? '時' : ''}</td>
        <td style="text-align:right">${a.vol.toLocaleString()}</td>
        <td style="text-align:right">${a.demand.toLocaleString()}</td>
        <td style="text-align:right">${a.missed.toLocaleString()} (${missRate})</td>
        <td style="text-align:right">${avgStaff(s.id).toFixed(1)}</td>
        <td style="text-align:right">${cap[s.id] ? cap[s.id].toFixed(1) : '—'}</td>
        <td style="text-align:right">${avgGap}</td>
        <td style="text-align:center">${a.staffedMissedDays}日</td>
      </tr>`;
    }).join('');
    const topMissShare = totMissed && top.length ? Math.round(top.reduce((a, s) => a + agg[s.id].missed, 0) / totMissed * 100) : 0;

    return `
      <div class="card" style="margin-top:16px">
        <h3>サマリー (${A().state.month}) <span class="hint" style="font-weight:400">完全な ${completeDays}日で集計${incompleteCount ? `（部分データ ${incompleteCount}日除外）` : ''}</span></h3>
        <ul class="sf-bullets">
          <li>ライブ接触 <b>${totVol.toLocaleString()}</b> 件 / うち要対応 <b>${totDemand.toLocaleString()}</b> 件 / Missed <b>${totMissed.toLocaleString()}</b> 件 (対要対応 ${totDemand ? (totMissed / totDemand * 100).toFixed(1) : '0'}%)</li>
          <li><b>取りこぼし率ワースト${unit}</b>: ${top.map(s => `${s.label}${gran==='hour'?'時':''} (${fmtPct(s.id)}/在席${avgStaff(s.id).toFixed(1)}人)`).join(' 、') || '—'}</li>
          <li>この上位${top.length}${unit}で月間Missedの <b>${topMissShare}%</b> を占める ← 増員・配置見直しの優先対象</li>
          <li class="hint" style="list-style:none;margin-left:-20px">※「必要/ギャップ」は平均生産性ベースの目安。<span style="color:#c0392b">●</span>=有人なのにMissedした時間。「部」=部分データ。</li>
        </ul>
        <div class="table-wrap">
        <table class="data-table sf-cap-table">
          <thead><tr><th>${gran === 'band' ? '時間帯' : '時'}</th><th>総量</th><th>要対応</th><th>Missed(率)</th><th>平均在席</th><th>キャパ<br>(件/人)</th><th>平均ギャップ</th><th>有人Missed</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        </div>
      </div>`;
  }

  // ---- クリック→取りこぼし理由パネル ----
  let ctx = null;
  const BAND_HOURS = { '04-07': [4, 5, 6], '07-12': [7, 8, 9, 10, 11], '12-16': [12, 13, 14, 15], '16-21': [16, 17, 18, 19, 20], '21-02': [21, 22, 23, 0, 1, 2, 3] };
  const SRC_LABEL = { 'SBCalls': 'ビデオ通話', 'AI Call': 'AI電話(転送/不在)', 'CallConnect': '電話(CallConnect)', 'IVRy': '電話(IVRy)', 'freshdesk': 'メール' };

  async function fetchMissedDetail(date, hours) {
    const url = `${KPI_URL}/rest/v1/v_staffing_missed_detail`
      + `?select=source,channel,property,missed&contact_date=eq.${date}&contact_hour=in.(${hours.join(',')})`;
    const res = await fetch(url, { headers: { apikey: KPI_KEY, Authorization: `Bearer ${KPI_KEY}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    return res.json();
  }

  function panelEl() {
    let p = document.getElementById('sf-detail-panel');
    if (!p) { p = document.createElement('div'); p.id = 'sf-detail-panel'; document.body.appendChild(p); }
    return p;
  }

  async function openDetail(date, slotId) {
    if (!ctx) return;
    const slot = ctx.slots.find(s => s.id === slotId);
    if (!slot) return;
    const cell = ctx.grid[date]?.[slotId];
    const hours = ctx.gran === 'hour' ? [+slotId] : (BAND_HOURS[slotId] || []);
    const slotLabel = ctx.gran === 'hour' ? `${slotId}時台` : `${slot.label} 帯`;
    const A0 = A();
    const dow = A0.DOW_LABELS[A0.getDow(date)];
    const day = parseInt(date.slice(-2), 10);

    const p = panelEl();
    p.innerHTML = `<div class="sfd-head"><span>📍 ${day}日(${dow}) ${slotLabel}</span><button id="sfd-x">✕</button></div><div class="sfd-body">読込中…</div>`;
    p.style.display = 'block';
    document.getElementById('sfd-x').onclick = () => { p.style.display = 'none'; };

    let rows = [];
    try { rows = await fetchMissedDetail(date, hours); } catch (e) { p.querySelector('.sfd-body').innerHTML = `<div style="color:#c0392b">取得失敗</div>`; return; }

    // 集計
    const totMiss = rows.reduce((a, r) => a + (+r.missed), 0);
    const bySrc = {}, byFac = {};
    for (const r of rows) {
      bySrc[r.source] = (bySrc[r.source] || 0) + (+r.missed);
      byFac[r.property] = (byFac[r.property] || 0) + (+r.missed);
    }
    const srcRows = Object.entries(bySrc).sort((a, b) => b[1] - a[1]);
    const facRows = Object.entries(byFac).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // 在席者
    const emps = (ctx.gran === 'hour' ? A0.staffedEmployeesAtHour(date, +slotId) : A0.staffedEmployeesInBand(date, slot.band))
      .filter(e => { const r = e.roles || []; return !r.length || !r.every(x => ctx.excluded.has(x)); });
    const staffed = cell?.staffed ?? emps.length;
    const demand = cell?.demand ?? 0;
    const pp = staffed > 0 ? demand / staffed : null;
    const videoMiss = bySrc['SBCalls'] || 0;

    // 推定理由（ヒューリスティック）
    const reasons = [];
    if (staffed <= 0) reasons.push('🔴 <b>無人時間</b>：この時間に在席なし（シフト外）。');
    else {
      if (pp != null && pp >= 3) reasons.push(`🔴 <b>過負荷</b>：在席${staffed}人に対しライブ要対応${demand}件（1人あたり ${pp.toFixed(1)}件）。`);
      if (videoMiss / (totMiss || 1) >= 0.6) reasons.push(`🟠 <b>ビデオ併発</b>：取りこぼしの${Math.round(videoMiss / totMiss * 100)}%がビデオ通話。同時着信に在席が追いつかず。`);
      if (facRows.length && facRows[0][1] / (totMiss || 1) >= 0.4) reasons.push(`🟠 <b>特定施設に集中</b>：「${facRows[0][0]}」が${facRows[0][1]}件（${Math.round(facRows[0][1] / totMiss * 100)}%）。`);
      if (!reasons.length) reasons.push('🟡 在席はあるが取りこぼし発生。負荷の瞬間的な集中や対応長期化の可能性。');
    }

    const fmtList = (arr, lbl) => arr.map(([k, v]) => `<div class="sfd-row"><span>${lbl(k)}</span><b>${v}件</b></div>`).join('') || '<div class="sfd-empty">なし</div>';
    p.querySelector('.sfd-body').innerHTML = `
      <div class="sfd-kpi"><div>取りこぼし <b>${totMiss}</b>件</div><div>ライブ要対応 <b>${demand}</b>件</div><div>在席 <b>${staffed}</b>人${pp != null ? ` / 1人${pp.toFixed(1)}件` : ''}</div></div>
      <div class="sfd-sec"><div class="sfd-t">推定理由</div>${reasons.map(r => `<div class="sfd-reason">${r}</div>`).join('')}</div>
      <div class="sfd-sec"><div class="sfd-t">チャネル別</div>${fmtList(srcRows, k => SRC_LABEL[k] || k)}</div>
      <div class="sfd-sec"><div class="sfd-t">施設別 (上位5)</div>${fmtList(facRows, k => k)}</div>
      <div class="sfd-sec"><div class="sfd-t">この時間の在席者 (${emps.length}人)</div>${emps.length ? emps.map(e => `<div class="sfd-row"><span>${e.name}</span><span class="sfd-roles">${(e.roles || []).join(',')}</span></div>`).join('') : '<div class="sfd-empty">なし</div>'}</div>`;
  }

  // ---- イベント ----
  function bind() {
    ['sf-gran', 'sf-metric', 'sf-exclude-mgr', 'sf-exclude-de'].forEach(id =>
      document.getElementById(id)?.addEventListener('change', render));
    document.getElementById('sf-reload')?.addEventListener('click', () => {
      delete cache[`${A().state.month}|${getGran()}`];
      render();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.StaffingFit = { render, _cache: cache };
})();
