/* ============================================================================
   sqa-data.js — KPI Supabase 共通データ層（SQA Operation Review Analytics）
   - PostgREST 共通fetch、データ鮮度、既定月(直近完全月)フォールバック、月レンジ。
   - 新規タブ(inquiry.js / dashboard.js)が共有。volume.jsは当面自前のまま(段階移行)。
   公開: window.SQAData
   ============================================================================ */
(function () {
  const KPI_URL = 'https://teovwpuubkefbvuuxzvo.supabase.co';
  const KPI_KEY = 'sb_publishable_9EbMAos5C2RzaBt6iFNSXg_eR7Lx0dX';

  // 完全月判定に使う「遅れて入るチャネル」。これらが揃う最新月を既定月にする。
  // IVRy は 2026-03 で停止した旧ソースなので除外。
  const LAGGING = ['freshdesk', 'SBCalls', 'CallConnect'];
  const SRC_LABEL = { 'AI Call': 'AI電話', 'CallConnect': '電話', 'freshdesk': 'メール', 'SBCalls': 'ビデオ', 'IVRy': 'IVRy(旧)' };

  let _freshness = null;

  async function fetchView(view, opts) {
    opts = opts || {};
    let url = `${KPI_URL}/rest/v1/${encodeURIComponent(view)}?select=${opts.select || '*'}`;
    if (opts.filters) url += '&' + opts.filters;     // 例: "contact_date=gte.2026-05-01&contact_date=lte.2026-05-31"
    if (opts.order) url += `&order=${opts.order}`;
    url += `&limit=${opts.limit || 5000}`;
    const res = await fetch(url, {
      headers: { apikey: KPI_KEY, Authorization: `Bearer ${KPI_KEY}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function freshness() {
    if (_freshness) return _freshness;
    _freshness = await fetchView('v_source_freshness', { select: 'source,latest,is_live,rows_total', order: 'latest.desc' });
    return _freshness;
  }

  // 既定月 = 「遅れて入るチャネル」が存在する最新日付の月（= 多チャネルが揃っている直近月）。
  async function defaultMonth() {
    const f = await freshness();
    const latests = f.filter(r => LAGGING.includes(r.source) && r.latest).map(r => r.latest).sort();
    const latest = latests[latests.length - 1];
    if (latest) return latest.slice(0, 7);
    // フォールバック: 当月(JST)
    return new Date().toISOString().slice(0, 7);
  }

  // 鮮度バナー用テキスト（source別の最新日）
  async function freshnessText() {
    const f = await freshness();
    return f.filter(r => r.source !== 'IVRy')
      .map(r => `${SRC_LABEL[r.source] || r.source}=${r.latest}`)
      .join(' / ');
  }

  // 指定月が部分月(=遅れチャネルが月末まで未取込)か判定。
  // いずれかの遅れチャネルの最新が月末に達していなければ部分とみなす。
  async function isPartialMonth(month) {
    const f = await freshness();
    const end = monthRange(month).end;
    return f.filter(r => LAGGING.includes(r.source)).some(r => !r.latest || r.latest < end);
  }

  function monthRange(month) {
    const [y, m] = month.split('-').map(Number);
    const dim = new Date(y, m, 0).getDate();
    return { start: `${month}-01`, end: `${month}-${String(dim).padStart(2, '0')}` };
  }
  function prevMonth(month) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 2, 1); // m-2 = 前月(0-indexed)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  window.SQAData = {
    KPI_URL, KPI_KEY, LAGGING, SRC_LABEL,
    fetchView, freshness, defaultMonth, freshnessText, isPartialMonth,
    monthRange, prevMonth,
  };
})();
