/* ============================================================================
   inquiry.js — お問い合わせ分析（SQA Operation Review Analytics 柱②）
   - 概況サマリ(inquiry-overview): 月のKPIカード＋チャネル別内訳＋前月比。
   - 時間別(inquiry-hourly): 日×時間／曜日×時間のボリュームヒート。
   データ源: public.v_staffing_volume_hourly / v_inquiry_channel_daily（SQAData経由）。
   起動時CSV不要(Supabase直読み)。月は ShiftApp.state.month に連動。
   公開: window.InquiryAnalysis
   ============================================================================ */
(function () {
  const SD = () => window.SQAData;
  const SRC_LABEL = { 'AI Call': 'AI電話', 'CallConnect': '電話', 'freshdesk': 'メール', 'SBCalls': 'ビデオ', 'IVRy': 'IVRy(旧)' };
  const SRC_ORDER = ['SBCalls', 'AI Call', 'CallConnect', 'freshdesk', 'IVRy'];
  const hourCache = {};   // month -> byDate{date:{hour:{total,demand,missed,mail}}}
  const chanCache = {};   // month -> rows

  function month() { return (window.ShiftApp && window.ShiftApp.state && window.ShiftApp.state.month) || new Date().toISOString().slice(0, 7); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function hourBandClass(h) {
    if (h >= 4 && h < 7) return 'band-04';
    if (h >= 7 && h < 12) return 'band-07';
    if (h >= 12 && h < 16) return 'band-12';
    if (h >= 16 && h < 21) return 'band-16';
    return 'band-21';
  }

  // ---- fetch ----
  async function loadHourly(m) {
    if (hourCache[m]) return hourCache[m];
    const r = SD().monthRange(m);
    const rows = await SD().fetchView('v_staffing_volume_hourly', {
      select: 'contact_date,contact_hour,total_vol,demand_vol,missed,mail_vol',
      filters: `contact_date=gte.${r.start}&contact_date=lte.${r.end}`,
      order: 'contact_date,contact_hour',
    });
    const byDate = {};
    for (const x of rows) {
      (byDate[x.contact_date] ||= {})[+x.contact_hour] = { total: +x.total_vol, demand: +x.demand_vol, missed: +x.missed, mail: +x.mail_vol };
    }
    hourCache[m] = byDate;
    return byDate;
  }
  async function loadChannel(m) {
    if (chanCache[m]) return chanCache[m];
    const r = SD().monthRange(m);
    const rows = await SD().fetchView('v_inquiry_channel_daily', {
      select: 'contact_date,source,channel,total,non_auto,missed',
      filters: `contact_date=gte.${r.start}&contact_date=lte.${r.end}`,
    });
    chanCache[m] = rows;
    return rows;
  }

  // 完全日(メール取込済)の集合。部分日(mail=0)は薄表示。
  function completeDates(byDate) {
    const set = new Set();
    for (const d in byDate) {
      let mail = 0; for (const h in byDate[d]) mail += byDate[d][h].mail || 0;
      if (mail > 0) set.add(d);
    }
    return set;
  }

  // ===== 概況サマリ =====
  async function renderOverview() {
    const m = month();
    const status = document.getElementById('iq-ov-status');
    const cards = document.getElementById('iq-ov-cards');
    const body = document.getElementById('iq-ov-body');
    status.textContent = '読込中…';
    cards.innerHTML = ''; body.innerHTML = '';

    let rows, prevRows, partial;
    try {
      rows = await loadChannel(m);
      prevRows = await loadChannel(SD().prevMonth(m)).catch(() => []);
      partial = await SD().isPartialMonth(m);
    } catch (e) {
      status.innerHTML = `<span style="color:#c0392b">取得失敗: ${esc(String(e.message || e))}</span>`;
      return;
    }
    if (!rows.length) { status.innerHTML = `<span style="color:#c0392b">${m} のデータがありません。</span>`; return; }

    const agg = aggChannel(rows);
    const pAgg = aggChannel(prevRows);
    const days = new Set(rows.map(r => r.contact_date)).size;
    status.innerHTML = `対象月: <b>${m}</b> ／ 取込日数 ${days}日` + (partial ? ' ／ <span style="color:#b8860b">部分月（メール等が未取込の日あり・概況は取込済分のみ）</span>' : '');

    const delta = (cur, prev) => prev ? `<span class="iq-delta ${cur >= prev ? 'up' : 'dn'}">${cur >= prev ? '▲' : '▼'}${Math.abs(cur - prev).toLocaleString()} (${prev ? ((cur - prev) / prev * 100).toFixed(0) : '—'}%)</span>` : '';
    const card = (n, l, d) => `<div class="card"><div class="big-number">${n}</div><h3>${l}</h3>${d || ''}</div>`;
    cards.innerHTML =
      card(agg.live.toLocaleString(), 'ライブ接触(電話＋ビデオ)', delta(agg.live, pAgg.live))
      + card(agg.demand.toLocaleString(), '要対応(AI自動除く)', '')
      + card(agg.missed.toLocaleString(), 'Missed', delta(agg.missed, pAgg.missed))
      + card((agg.demand ? (agg.missed / agg.demand * 100).toFixed(1) : '0') + '%', 'Miss率(対要対応)', '')
      + card(agg.mail.toLocaleString(), 'メール(非同期)', delta(agg.mail, pAgg.mail));

    // チャネル別内訳バー
    const bySrc = agg.bySrc;
    const maxV = Math.max(1, ...Object.values(bySrc).map(v => v.total));
    const ordered = SRC_ORDER.filter(s => bySrc[s]);
    body.innerHTML = `
      <div class="card" style="margin-top:16px">
        <h3>チャネル別ボリューム (${m})</h3>
        <table class="data-table" style="width:auto">
          <thead><tr><th>チャネル</th><th>件数</th><th>うち要対応</th><th>Missed</th><th></th></tr></thead>
          <tbody>${ordered.map(s => {
            const v = bySrc[s];
            const w = Math.round(v.total / maxV * 100);
            return `<tr><td>${SRC_LABEL[s] || s}</td><td style="text-align:right">${v.total.toLocaleString()}</td><td style="text-align:right">${v.non_auto.toLocaleString()}</td><td style="text-align:right">${v.missed.toLocaleString()}</td><td style="width:160px"><div style="background:#3498db;height:12px;width:${w}%;border-radius:3px"></div></td></tr>`;
          }).join('')}</tbody>
        </table>
        <p class="hint">メールはMissed概念なし(非同期)。CallConnect(電話)はstatus欠落のためMissedに算入されない。率系の厳密値はダッシュボード(kpi_daily系)を参照。</p>
      </div>`;
  }

  function aggChannel(rows) {
    const a = { live: 0, demand: 0, missed: 0, mail: 0, bySrc: {} };
    for (const r of rows) {
      const t = +r.total, na = +r.non_auto, ms = +r.missed;
      (a.bySrc[r.source] ||= { total: 0, non_auto: 0, missed: 0 });
      a.bySrc[r.source].total += t; a.bySrc[r.source].non_auto += na; a.bySrc[r.source].missed += ms;
      if (r.channel === 'Mail') a.mail += t;
      else { a.live += t; a.demand += na; a.missed += ms; }
    }
    return a;
  }

  // ===== 時間別 =====
  function hrMetric() { return document.getElementById('iq-hr-metric')?.value || 'total'; }
  function cellVal(c, metric) {
    if (!c) return null;
    if (metric === 'total') return c.total;
    if (metric === 'demand') return c.demand;
    if (metric === 'missed') return c.missed;
    if (metric === 'missedRate') return c.demand > 0 ? c.missed / c.demand : 0;
    return null;
  }
  function cellStyle(metric, v, incomplete) {
    if (v == null) return '';
    if (incomplete) return 'background:#f1f3f5;color:#aab2bd';
    if (metric === 'missed') return v > 0 ? `background:rgba(192,57,43,${0.12 + Math.min(1, v / 15) * 0.7})` : '';
    if (metric === 'missedRate') return v > 0 ? `background:rgba(192,57,43,${0.1 + Math.min(1, v / 0.15) * 0.7})` : '';
    return `background:rgba(52,152,219,${0.06 + Math.min(1, v / 120) * 0.6})`;
  }
  function cellText(metric, v, incomplete) {
    if (v == null) return '';
    if (metric === 'missedRate') return `${(v * 100).toFixed(0)}%`;
    return `${v}`;
  }

  async function renderHourly() {
    const m = month();
    const status = document.getElementById('iq-hr-status');
    const dailyWrap = document.getElementById('iq-hr-daily');
    const dowWrap = document.getElementById('iq-hr-dow');
    status.textContent = '読込中…';
    dailyWrap.innerHTML = ''; dowWrap.innerHTML = '';

    let byDate;
    try { byDate = await loadHourly(m); } catch (e) { status.innerHTML = `<span style="color:#c0392b">取得失敗: ${esc(String(e.message || e))}</span>`; return; }
    const dates = Object.keys(byDate).sort();
    if (!dates.length) { status.innerHTML = `<span style="color:#c0392b">${m} のデータがありません。</span>`; return; }

    const complete = completeDates(byDate);
    const incCount = dates.length - complete.size;
    const metric = hrMetric();
    status.innerHTML = `対象月: <b>${m}</b> ／ ${dates.length}日` + (incCount ? ` ／ <span style="color:#b8860b">部分データ ${incCount}日(薄色)</span>` : '');

    const dow = ['日', '月', '火', '水', '木', '金', '土'];
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const head = `<thead><tr><th>日付</th>${hours.map(h => `<th class="${hourBandClass(h)}">${h}</th>`).join('')}</tr></thead>`;

    // 日別
    let html = `<table class="heatmap sf-heatmap">${head}<tbody>`;
    for (const d of dates) {
      const inc = !complete.has(d);
      const dy = parseInt(d.slice(-2), 10);
      const w = new Date(d + 'T00:00:00').getDay();
      html += `<tr><td class="date-cell">${dy}(${dow[w]})</td>` + hours.map(h => {
        const c = byDate[d][h];
        const v = cellVal(c, metric);
        const title = c ? `総${c.total} / 要対応${c.demand} / Missed${c.missed}${inc ? ' ⚠部分' : ''}` : 'データなし';
        return `<td class="sf-cell" style="${cellStyle(metric, v, inc)}" title="${esc(title)}">${cellText(metric, v, inc)}${inc && c ? '<span class="sf-partial">部</span>' : ''}</td>`;
      }).join('') + `</tr>`;
    }
    html += `</tbody></table>`;
    dailyWrap.innerHTML = html;

    // 曜日別平均(完全日のみ)
    const acc = {}; for (let w = 0; w < 7; w++) { acc[w] = {}; for (const h of hours) acc[w][h] = { total: 0, demand: 0, missed: 0, n: 0 }; }
    for (const d of dates) {
      if (!complete.has(d)) continue;
      const w = new Date(d + 'T00:00:00').getDay();
      for (const h of hours) { const c = byDate[d][h]; if (!c) continue; const a = acc[w][h]; a.total += c.total; a.demand += c.demand; a.missed += c.missed; a.n++; }
    }
    let dh = `<table class="heatmap sf-heatmap">${head.replace('日付', '曜日')}<tbody>`;
    for (let w = 0; w < 7; w++) {
      dh += `<tr><td class="date-cell">${dow[w]}</td>` + hours.map(h => {
        const a = acc[w][h];
        if (!a.n) return `<td class="sf-cell"></td>`;
        const cell = { total: a.total / a.n, demand: a.demand / a.n, missed: a.missed / a.n };
        const v = cellVal(cell, metric);
        const disp = metric === 'missedRate' ? `${(v * 100).toFixed(0)}%` : (Math.round(v * 10) / 10).toFixed(1);
        const title = `平均 総${cell.total.toFixed(1)}/要対応${cell.demand.toFixed(1)}/Missed${cell.missed.toFixed(1)}`;
        return `<td class="sf-cell" style="${cellStyle(metric, v, false)}" title="${esc(title)}">${disp}</td>`;
      }).join('') + `</tr>`;
    }
    dh += `</tbody></table>`;
    dowWrap.innerHTML = dh;
  }

  // ---- API ----
  function render(tab) {
    if (tab === 'inquiry-overview') renderOverview();
    else if (tab === 'inquiry-hourly') renderHourly();
  }
  function bind() {
    document.getElementById('iq-hr-metric')?.addEventListener('change', renderHourly);
    document.getElementById('iq-hr-reload')?.addEventListener('click', () => { delete hourCache[month()]; renderHourly(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();

  window.InquiryAnalysis = { render };
})();
