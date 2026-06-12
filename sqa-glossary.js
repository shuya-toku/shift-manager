/* ============================================================================
   sqa-glossary.js — 用語の唯一の正(SoT)（SQA Operation Review Analytics）
   コードが用語定義を参照するのはこのファイルだけ。厳密な指標定義は
   docs/SQA-ORA-redesign.md §4.1 を一次とし、本ファイルはその平易版（一方向同期）。
   公開: window.SQAGlossary { TERMS, METRIC_DESC, tip, legendHTML, attach }
   UX-P1: データ＋ヘルパの提供のみ（凡例バー/?チップの全タブ展開は UX-P5）。
   ============================================================================ */
(function () {
  // key -> { label, def }（defはSQAマネージャー向けの平易な説明）
  const TERMS = {
    live: { label: 'ライブ接触', def: 'お客様が今まさにつながってきた件数。電話＋ビデオ。メールは含めない。' },
    mail: { label: 'メール(非同期)', def: 'あとから順次返信するもの。リアルタイムでないので「Missed(取りこぼし)」概念なし。' },
    demand: { label: '要対応', def: 'ライブ接触のうち、人が対応する必要があった件数（AI自動完了を除く）。' },
    missed: { label: 'Missed(取りこぼし)', def: '要対応のうち、人が出られず取りこぼした件数。' },
    missedRate: { label: 'Miss率', def: 'Missed ÷ 要対応。母数は総量ではなく「要対応」。' },
    staffed: { label: '在席', def: 'その時間にシフトで入っていた対応者の人数（DE/Mgrは除外可）。' },
    capacity: { label: 'キャパ(件/人)', def: '在席1人がその時間に普段こなせる件数の目安。データが揃った日から自動推定。' },
    required: { label: '必要人数', def: '要対応をさばくのに要る人数の目安（要対応÷キャパ）。平均ベース。' },
    gap: { label: '過不足ギャップ', def: '在席 − 必要人数。マイナス＝人手不足、プラス＝余裕。' },
    staffedMissed: { label: '有人Missed', def: '在席がいたのにMissedが出た時間。人員不足/配置ミスマッチの疑い。' },
    partial: { label: '部分データ', def: 'その日/月でメール・電話・ビデオが未取込で数字が欠ける状態。AI電話だけ先に入る日が多い。' },
    freshness: { label: 'データ鮮度', def: 'チャネルごとの「いつまで取り込めているか」。' },
  };

  // 人員整合性ヒートの表示メトリクスごとの1行説明（sf-metric セレクト連動・UX-P5で配線）
  const METRIC_DESC = {
    staffed: '色が濃いほど在席が多い。',
    missed: '色が濃いほど取りこぼしが多い（赤）。',
    missedRate: '色が濃いほど取りこぼし率が高い（赤）。母数は要対応。',
    volume: '色が濃いほどライブ総量が多い（青）。',
    demand: '色が濃いほど要対応が多い（青）。AI自動完了は除く。',
    gap: '赤＝人手不足／青＝余裕／緑＝ちょうど。在席−必要人数。',
  };

  function tip(term) { return TERMS[term] ? `${TERMS[term].label}：${TERMS[term].def}` : ''; }

  // ヒートマップ凡例バーHTML（UX-P5で volume.render 末尾から挿入予定）
  function legendHTML(metric) {
    const colorNote = metric === 'gap'
      ? '赤=人手不足 / 青=余裕 / 緑=ちょうど'
      : '色が濃いほど〈選択中の指標〉が大きい';
    return `<div class="sf-legend">`
      + `<span>${colorNote}</span>`
      + `<span><b style="color:var(--danger,#c0392b)">●</b> 有人なのにMissed</span>`
      + `<span><b>部</b> 部分データ(集計外)</span>`
      + `<span>·数字 在席のみ(問い合わせ無し)</span>`
      + `<span><b style="color:var(--danger,#c0392b)">✗</b>数字 平均Missed/日(曜日表)</span>`
      + `<span>セルにカーソルで内訳・クリックで取りこぼし理由</span>`
      + `</div>`;
  }

  // root内の .gloss[data-term] に軽量ツールチップを配線（UX-P5で各タブから呼ぶ）
  function attach(root) {
    (root || document).querySelectorAll('.gloss[data-term]').forEach(el => {
      if (el._glossBound) return;
      el._glossBound = true;
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', tip(el.dataset.term));
      el.title = tip(el.dataset.term); // P1は title フォールバック。div方式はP5。
    });
  }

  window.SQAGlossary = { TERMS, METRIC_DESC, tip, legendHTML, attach };
})();
