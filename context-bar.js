/* ============================================================================
   context-bar.js — 文脈ヘッダー（SQA Operation Review Analytics）
   月セレクタ直下に常設し「今どの月の・お問い合わせ/シフトがどの状態か」を常時表示。
   さらに空状態(emptyState)の共通描画関数を提供。
   - 月は1つ(state.month)のまま。これは「読む専用の表示層」で既存配管に副作用なし。
   - 鮮度由来(monthAvailability)はチップ説明専用。本体の空判定は各タブの実データ結果で行う。
   公開: window.SQAContext { refresh(tab), emptyState(el, opt) }
   ============================================================================ */
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function setChip(el, cls, text) {
    if (!el) return;
    el.classList.remove('ok', 'warn', 'muted');
    el.classList.add(cls);
    const v = el.querySelector('.ctx-val');
    if (v) v.textContent = text;
  }

  // topbar の実高さを測って --topbar-h に反映（コンテキストバーの sticky top に使用）
  function syncTopbarHeight() {
    const tb = document.querySelector('.topbar');
    if (!tb) return;
    document.documentElement.style.setProperty('--topbar-h', Math.round(tb.getBoundingClientRect().height) + 'px');
  }

  async function refresh() {
    const A = window.ShiftApp;
    if (!A || !A.state) return;
    const month = A.state.month;
    const mEl = document.getElementById('ctx-month');
    if (mEl) mEl.textContent = month || '—';

    // シフト（ローカル可用性）
    const shiftChip = document.getElementById('ctx-shift');
    if (shiftChip) {
      const has = A.hasShiftData ? A.hasShiftData(month) : false;
      setChip(shiftChip, has ? 'ok' : 'muted', has ? '●取込済' : '○未取込（CSV読込が必要）');
    }

    // お問い合わせ（Supabase鮮度＝説明専用）
    const iqChip = document.getElementById('ctx-inquiry');
    const note = document.getElementById('ctx-note');
    if (iqChip && window.SQAData && window.SQAData.monthAvailability) {
      try {
        const a = await window.SQAData.monthAvailability(month);
        let cls, txt, partial = false;
        if (a.inquiry === 'complete') { cls = 'ok'; txt = '●取込済（完全・月末まで）'; }
        else if (a.inquiry === 'partial') {
          cls = 'warn'; partial = true;
          if (a.coverDay === 0) txt = '◐部分（AI電話のみ取込／他チャネル未取込）';
          else if (a.coverDay < a.leadDay) txt = `◐部分（全チャネル揃い〜${a.coverDay}日／以降はAI電話のみ）`;
          else txt = `◐部分（〜${a.coverDay}日まで）`;
        } else { cls = 'muted'; txt = '○データなし（実績は2026-02以降）'; }
        setChip(iqChip, cls, txt);
        if (note) note.textContent = partial ? '※ 薄色セル＝未取込日。集計から除外。確定値はダッシュボード(kpi_daily系)参照。' : '';
      } catch (e) {
        setChip(iqChip, 'muted', '取得失敗');
        if (note) note.textContent = '';
      }
    }
  }

  // 統一エンプティステート。actions: [{label, onClick}] または [{label, tab}]
  function emptyState(el, opt) {
    if (!el) return;
    opt = opt || {};
    const actions = opt.actions || [];
    const btns = actions.map((a, i) => `<button class="${i === 0 ? 'primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('');
    el.innerHTML = `<div class="empty-state">
      <div class="es-icon">${opt.icon || '📭'}</div>
      <div class="es-title">${esc(opt.title)}</div>
      <div class="es-reason">${esc(opt.reason)}</div>
      ${btns ? `<div class="es-actions">${btns}</div>` : ''}
    </div>`;
    actions.forEach((a, i) => {
      const btn = el.querySelector(`.es-actions button[data-i="${i}"]`);
      if (!btn) return;
      btn.addEventListener('click', () => {
        if (typeof a.onClick === 'function') a.onClick();
        else if (a.tab && typeof window.switchTab === 'function') window.switchTab(a.tab);
      });
    });
  }

  function start() {
    syncTopbarHeight();
    window.addEventListener('resize', syncTopbarHeight);
    // 初期表示（switchTab からも呼ばれるが、保険で一度実行）
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.SQAContext = { refresh, emptyState, syncTopbarHeight };
})();
