/* ============================================================================
   nav.js — サイドバーナビ補助（SQA Operation Review Analytics）
   - グループ折りたたみ、データ鮮度バッジ、タブ文脈に応じたアクション表示。
   - タブのshow/hideは app.js の switchTab を流用（サイドバー項目も class="tab"）。
   公開: window.SQANav
   ============================================================================ */
(function () {
  // シフト管理系のアクション(自動アサイン/CSV/リセット)を出すタブ
  const SHIFT_TABS = ['shift', 'demand', 'visualize', 'employees', 'holidays', 'staffing-fit'];

  function onTab(tab) {
    const act = document.getElementById('shift-actions');
    if (act) act.style.visibility = SHIFT_TABS.includes(tab) ? 'visible' : 'hidden';
    // アクティブなサブ項目を含むグループを開く
    document.querySelectorAll('.nav-group').forEach(g => {
      if (g.querySelector(`.nav-item[data-tab="${tab}"]`)) g.classList.remove('collapsed');
    });
  }

  async function initBadge() {
    const el = document.getElementById('freshness-badge');
    if (!el || !window.SQAData) return;
    try {
      const txt = await window.SQAData.freshnessText();
      const dm = await window.SQAData.defaultMonth();
      el.innerHTML = `鮮度: ${txt}`;
      el.title = `お問い合わせデータの取込最新日 ／ 多チャネルが揃う直近月 = ${dm}`;
    } catch (e) {
      el.textContent = '鮮度: 取得失敗';
    }
  }

  function bindGroups() {
    document.querySelectorAll('.nav-group-head').forEach(h => {
      h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
    });
  }

  function start() {
    bindGroups();
    initBadge();
    // 初期タブ(dashboard)の文脈を反映
    onTab('dashboard');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.SQANav = { onTab };
})();
