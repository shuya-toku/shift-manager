# SQA Operation Review Analytics — UX/IA 再設計ドキュメント（分かりづらさの解消・最終版）

> 旧 Shift Manager のUX/IA再設計。4担当のUX設計案（Month-Model / Context-Empty-States / IA-Navigation / Orientation-FirstRun）を統合し、矛盾を解消した単一の確定仕様。本書は批判レビューの全指摘（高3・中4・低3）を反映した**最終版**。
> 対象: `github.com/shuya-toku/shift-manager`（ローカル正本 `SQA AI Agent Team/Shift Management`、origin/main 最新）。基準日 **2026-06-12**。
> 既存の製品全体設計は `docs/SQA-ORA-redesign.md`。本書はその上に乗る「UXの分かりづらさ」専用の実装可能な指針。
> 前提: バニラJS継続。既存 `window.ShiftApp` / `SQANav` / `SQAData` / `InquiryAnalysis` / `StaffingFit` と `switchTab`(app.js:343) を壊さず、**表示層の追加**で解決する。

> ### ⚠️ 実装の大前提（全フェーズ共通・load-bearing）
> このリポは **root を正本として編集**し、`build.js` が `public/` へ手動コピーしてVercelへデプロイする二重管理構成である（`build.js:8-12` の `files` 配列が**固定リスト**）。
> - **編集するのは常に root のファイル。`public/` は build 生成物なので直接触らない。**
> - **新規 `.js` を追加したら、必ず同じコミットで `build.js` の `files` 配列に追記する。** これを怠るとローカル（root配信）では動くがVercel（`public/`配信）で新ファイルが404になり、`SQAContext` undefined で全タブが壊れる（レビューH1）。
> - 本書 §8 の各フェーズ「変更ファイル」では、新規jsを足すフェーズに必ず `build.js` を明記している。

---

## 1. 問題の要約（分かりづらさの正体）

SQAマネージャー（非エンジニア・日本語）の指摘を、コードの実装事実に照らして再定義する。

| # | 表面の症状 | 本当の原因 | 設計上の含意 |
|---|---|---|---|
| 1 | 月セレクタ（`#month-input`, index.html:27）が「編集する月」と「分析する月」を兼ねていて意味が二重 | 月は1つ（`state.month` 単一グローバル）で正しい。問題は**同じ月がタブによって出所/鮮度の違うデータを指す**のに画面が説明しないこと | 月は分離しない。「いま見ている月に・どの種類のデータが・どの状態で入っているか」を常時可視化する |
| 2 | 4月に切替→人員整合性は在席0、シフト表は空。「壊れた」ように見える | バグではなく「4月のシフトは未取込」。`anyStaff===false`(volume.js:253) の理由が status 行の一文に埋もれ、本体テーブルは無言で空になる | 空は「理由＋次の一手」で能動的に説明する。本体を空のまま見せない |
| 3 | お問い合わせは即表示、シフトはCSV取込が要る。同じ月セレクタなのに挙動が違う | お問い合わせ=Supabase全月直読み、シフト=ローカル/その月だけ取込、という**データの出所が構造的に違う**（P2のシフトSupabase永続化まで残る制約） | 出所の違いを常時1か所で明示。P2後に文言が自然に役目を終える前方互換設計に |
| 4 | 在席/要対応/ライブ負荷/キャパ/有人Missed/過不足ギャップ等の専門語が説明なしで密 | 用語の唯一の正（SoT）が無く、定義が index.html / volume.js / inquiry.js に散在。ヒートマップの記号（●/部/·/✗/色）の意味も散文に埋もれる | 用語SoTを1ファイルに集約。見出しに `?`、ヒート直上に常設凡例 |
| 5 | 総じて「今どの月の・何のデータを・どの状態で見ているか」が常に分かる仕掛けが無い | 鮮度バッジ(index.html:24)は source別最新日が生のまま密で、選択月との関係を示さない | 月セレクタ直下に**常設の文脈ヘッダー**を1本置き、5つの不満すべての説明責任を一手に担わせる |

**結論**: 指摘1〜5は「月を2つに割る」では解決しない（むしろ単一stateの綺麗な配管を壊し、"5月の問い合わせを見ながら5月のシフトを直す"という同月往復のメンタルモデルを断つ）。解くべきは**状態の可視化**であり、追加するのは読む専用の表示層だけ。

---

## 2. UX原則（このツールの使い心地の指針）

このプロダクトのすべての画面・文言・色はこの6原則に従う。

1. **月は1つ、見方は複数（Single month, multiple lenses）**
   `state.month` は唯一のグローバルな真実。月を割らない。「1つの月を、シフト・お問い合わせ・整合性の3つのレンズで見る」をメンタルモデルとする。
2. **常に現在地が分かる（Always orient）**
   「今どの月の・何のデータを・どの状態で見ているか」を、どのタブにいても画面上部の固定帯で即答する。
3. **空は説明する、無言で空にしない（Empty states explain）**
   データが0/部分のとき、本体を空白で放置しない。必ず「なぜ空か（バグでなく未取込/対象外）＋次の一手ボタン」を出す。
4. **色＝意味は全画面で不変（Consistent semantics）**
   赤＝取りこぼし/要注意、橙＝部分/暫定、緑＝良好/充足、青(accent)＝中立の操作・リンク。画面ごとに赤の意味を変えない。
5. **用語は初出で噛み砕く、ラベルは短く（Plain words, terse labels）**
   サイドバーのラベルは短く保ち、専門語の解説は `?`ツールチップ・グループ説明・凡例に逃がす。SoTは1ファイル。
6. **段階導入・前方互換（Ship small, P2-safe）**
   各ステップ単体で価値が出る粒度で入れる。P2（シフトSupabase永続化）後に判定ロジックを差し替えるだけでUI契約が変わらない設計にする。

---

## 3. 月モデルの決定（状態セマンティクスとUI）

### 3.1 決定：案C（文脈スコープ）を採用 — 月は1つのまま

3案を比較し、**案C**を確定採用する。

- **案A（分析月が主・シフトが追従）**: 1つの月に統合する点はCと同じだが「追従」を名乗っても未取込月で空になる理由を説明する責務は残る。Cの劣化版。
- **案B（分析月とシフト編集月を別UI）**: `state.month` を2変数化し、`inquiry.js`/`volume.js`/`app.js` の `state.month` 参照（20箇所超）を全分岐する大改修。しかも主作業は同月往復なので2セレクタは取り違えを生む。**不採用**。
- **案C（文脈スコープ）★採用**: `state.month` 単一のまま据え置き。月セレクタを「対象月」と明示し、その直下に**常設の文脈ヘッダー**を置いて「選択月に何がどの状態で入っているか」を常時表示。空タブは統一エンプティステートで理由を出す。既存の `renderAll`＋分析タブ再render（app.js:287-296）/ `monthRange` をそのまま使え、追加は表示層だけ。P1思想（表示層で価値）とP2（シフト永続化でチップが自動で●化）に無矛盾。

### 3.2 データ可用性モデル（薄い純関数を1つ追加）— ★重要：2系統の役割分離

レビューH2への対応として、**「鮮度由来の状態」と「実データ由来の空判定」を明確に分離する**。両者は別ビューを参照するため一致しない場合があり、これを暗黙に同一視すると「チップは『取込済』なのに本体は空」という新たな不整合（指摘2の再発）を生む。

| 系統 | 参照ソース | 役割 | 駆動するUI |
|---|---|---|---|
| **鮮度由来** | `v_source_freshness`（source別の最新日） | コンテキストバーの**説明文の出し分け専用** | 上部チップ（💬お問い合わせ）の `●/◐/○` と文言 |
| **実データ由来** | `v_inquiry_channel_daily`(inquiry) / `v_staffing_volume_hourly`(volume) の実クエリ結果（`rows.length` / `byDate`） | **本体の空判定（emptyState発火）専用** | 各タブ本体の表示 or emptyState |

**食い違い時の優先規約（必ず実装に明記）**:
> emptyStateの発火は**常に各タブの実データ結果**（`rows`/`byDate`）で判定する。`monthAvailability()` はチップの説明文だけに使う。両者が食い違った場合（鮮度上は `partial` なのに当該ビューに行が無い等）は**本体結果を優先**し、emptyState の `reason` に鮮度由来の補足（例「鮮度上は●日まで到達と表示されますが、このビューには該当月の明細がありません」）を添える。

```js
// sqa-data.js に追加（window.SQAData に公開）
// 注意：これは「コンテキストバーの説明文」専用。本体の空判定には使わない（実データ結果で判定する）
// お問い合わせ(Supabase)側の可用性: none / partial / complete
//   + 全チャネル揃い境界日(coverDay) と 先行チャネル到達日(leadDay)
async function monthAvailability(month) {
  const f = await freshness();
  const { start, end } = monthRange(month);
  const lag = f.filter(r => LAGGING.includes(r.source));     // freshdesk/SBCalls/CallConnect
  const inMonth = lag.filter(r => r.latest && r.latest >= start);
  const hasAny  = inMonth.length > 0;
  const complete = hasAny && lag.every(r => r.latest && r.latest >= end);
  // H3対応：揃い境界＝「最も遅れているチャネルの到達日」（全チャネルが揃う保証日）
  const clamp = d => (d > end ? end : d);
  const coverLatest = hasAny
    ? lag.map(r => r.latest && r.latest >= start ? clamp(r.latest) : start).sort()[0]
    : null;
  // 先行チャネル（最速で入るAI電話）の到達日。揃い境界より先まで入っている分の注記用
  const leadLatest = hasAny
    ? inMonth.map(r => clamp(r.latest)).sort().slice(-1)[0]
    : null;
  return {
    inquiry: hasAny ? (complete ? 'complete' : 'partial') : 'none',
    coverDay: coverLatest ? new Date(coverLatest).getDate() : 0,  // 全チャネル揃い境界
    leadDay:  leadLatest  ? new Date(leadLatest).getDate()  : 0,  // 先行チャネル到達
  };
}
```

シフト側はSupabase鮮度では分からない（ローカルstate）。`app.js` に判定を1関数公開する。**`anyStaff`(volume.js:253) と同じ "work在席あり" 判定に寄せて二重定義を避ける**。

```js
// app.js（window.ShiftApp に hasShiftData を公開）
function hasShiftData(month = state.month) {
  return Object.keys(state.shift || {}).some(d =>
    d.slice(0, 7) === month &&
    Object.values(state.shift[d] || {}).some(c => c.status === 'work'));
}
```

### 3.3 月の状態セマンティクス（3値＋色）

| 状態 | 記号/色 | お問い合わせ（Supabase全月） | シフト（ローカル/P2でSupabase） |
|---|---|---|---|
| 取込済・完全 | ●緑 | 遅れチャネルが月末まで全て到達（例 2026-04） | その月にworkセルあり |
| 部分 | ◐橙 | 月内に実績はあるが**全チャネルは月末まで未到達**（例 2026-05=AI電話のみ先行） | （シフトは部分概念なし。原則 ●か○） |
| なし/未取込 | ○グレー | 実績が1日も無い／対象外（〜2026-01） | その月のworkセルが無い |

**月跨ぎの挙動**: 月セレクタ change で `state.month` 更新→`renderAll`→表示中分析タブ再render（既存）→**末尾で文脈ヘッダーを1回更新**する1行だけ追加。`monthRange`/`prevMonth` は触らない。分析タブは従来どおり `state.month` を読むだけ。文脈ヘッダーは読む専用なので既存配管に副作用なし。

---

## 4. 文脈ヘッダー＆空/部分状態の仕様（タブ別の表示と文言）

### 4.0 命名の統一（担当案の矛盾解消）

3担当がそれぞれ別名（`#month-context` / `#context-bar`+`SQAContext` / `#state-bar`+`SQANav.renderStateBar`）で同じ帯を提案していた。**以下に一本化する**。

- 要素ID: **`#context-bar`**（topbar直下、`.layout` の前に挿入）
- 名前空間: **`window.SQAContext`**（新規 `context-bar.js` に集約）。理由＝app.js肥大化を避け、状態表示ロジック（Supabase可用性＋shift可用性＋空状態）を1ファイルにまとめると保守と段階導入が楽。`SQANav` は純粋にナビ（折りたたみ/バッジ/アクション表示）に専念させ責務を分離する。
- 更新API: **`SQAContext.refresh(tab)`** を1本だけ公開。`switchTab`(app.js:351付近) 末尾と month-input change（app.js:295の後）の両方から呼ぶ。
- 空状態API: **`SQAContext.emptyState(el, {...})`**（同ファイルに同梱）。各タブのrenderから呼ぶ。`SQANav.emptyState` は作らない（命名競合の解消）。

### 4.1 文脈ヘッダー（コンテキストバー）＝常時表示

#### チップ構成：**3チップに確定**（Month-Modelの2チップ案を拡張採用）

「対象月」を独立チップにすると、月セレクタ（topbar内・右寄り）と視覚的に離れていても「今どの月か」が本文直上で再確認でき、原則2（Always orient）に最も効く。データ状態2チップ＋月チップ＝3つ。

```
[📅 対象月 2026-05]   💬 お問い合わせ ◐部分（全チャネル揃い〜20日／以降AI電話のみ）   🗓 シフト ●取込済
                                                          ※ 薄色セル＝未取込日（集計外）
```

#### HTML（index.html: `</header>` 直後、`<div class="layout">` の前）

```html
<div id="context-bar" class="context-bar">
  <span class="ctx-chip ctx-month">📅 対象月 <b id="ctx-month">—</b></span>
  <span class="ctx-chip" id="ctx-inquiry" title="お問い合わせ実績=Supabase(全月)。電話/メール/ビデオは月次手動取込のため当月〜月末は未取込になりがち。AI電話だけ先に入ります。">💬 お問い合わせ <span class="ctx-val">…</span></span>
  <span class="ctx-chip" id="ctx-shift" title="シフト=この月に取込したローカルCSV（P2でSupabase永続化予定）。">🗓 シフト <span class="ctx-val">…</span></span>
  <span class="ctx-note" id="ctx-note"></span>
</div>
```

#### 確定文言（基準日 2026-06-12）— ★H3対応：部分月は「全チャネル揃い境界」基準

お問い合わせチップ（`SQAData.monthAvailability(month)` の `inquiry`/`coverDay`/`leadDay` で出し分け）。**「最も進んだチャネル」ではなく「最も遅れている遅れチャネルの到達日（＝全チャネルが揃う保証日）」を主表示**にする。先行チャネル(AI電話)だけが進んでいる分は副次表示にし、「N日まで全部揃っている」という誤った安心を防ぐ（レビューH3）。

- complete: `💬 お問い合わせ ●取込済（完全・月末まで）` 緑（記号＋語を常にセット）
- partial（`coverDay < leadDay`）: `💬 お問い合わせ ◐部分（全チャネル揃い〜{coverDay}日／以降はAI電話のみ）` 橙
- partial（`coverDay === leadDay`、単に月途中まで一律）: `💬 お問い合わせ ◐部分（〜{coverDay}日まで／以降未取込）` 橙
- none: `💬 お問い合わせ ○データなし（実績は2026-02以降）` グレー

シフトチップ（`ShiftApp.hasShiftData(month)`）:
- あり: `🗓 シフト ●取込済` 緑
- なし: `🗓 シフト ○未取込（CSV読込が必要）` グレー

ctx-note（部分月や注意の一言・右寄せ）:
- 部分月のとき: `※ 薄色セル＝未取込日。集計から除外。確定値はダッシュボード(kpi_daily系)参照。`

**hover補足（title属性）が「同じ月セレクタなのに挙動が違う」の常設説明**になる（指摘3）。

> **記号の表示規約（レビューL3対応）**: チップは**常に「記号＋語」をセット**で出す（`◐部分`/`●取込済`/`○データなし`）。`◐` と `●` は12px相当のチップでは色覚・小画面で判別しづらいため、**記号単独で意味を負わせない**。ナビバッジ（§5.3）も語を優先する。

#### 鮮度バッジの扱い（担当案の矛盾解消・P1で従属化を必ず同時実施）

担当間で「撤去 vs 残す」が割れた。**確定：鮮度バッジ(index.html:24)は残すが従属化**する。コンテキストバーが「選択月に対する状態」を担い、鮮度バッジは「source別の生の取込最新日」という別レイヤの情報なので役割が重複しない。ただし視覚的主役はコンテキストバーに譲り、鮮度バッジは小さく/淡く（情報は title 中心）。
**この従属化は UX-P1 で必ず同時実施する**（後回しにしない）。理由＝鮮度バッジの `freshnessText` は4チャネル連結で長く、topbar の wrap 要因になる（§7.3・M2）。従属化（淡色・短縮）を先にやることでコンテキストバー追加時の二段sticky崩れリスクも下がる。完全撤去はUX-P3で利用実態を見て再評価。

### 4.2 統一エンプティステート（空の理由を見せる）

#### 共通関数 `SQAContext.emptyState(el, {icon, title, reason, actions})`

`<div class="empty-state">` を生成。`actions` は `{label, onClick}` または `{label, tab}`（後者は `switchTab(tab)` を呼ぶボタン）。本体テーブルが空/在席0のとき、テーブルの代わりにこれを描画する。
**発火条件は §3.2 の規約どおり「実データ結果」で判定する**（`monthAvailability` の鮮度由来状態では発火させない）。

```js
SQAContext.emptyState(el, {
  icon: '🗓', title: 'この月のシフトは未取込です',
  reason: '2026-04 のシフトはまだ読み込まれていません（シフトは現状ローカル保存・月ごとに取込が必要です）。',
  actions: [
    { label: 'CSVを読み込む', onClick: () => document.getElementById('btn-csv-import').click() },
    { label: 'お問い合わせ分析を見る', tab: 'inquiry-overview' },
  ],
});
```

#### タブ別の表示内容・文言（確定）

| タブ | 条件（実データ由来） | アイコン/title / reason / 次の一手 |
|---|---|---|
| **ダッシュボード** | シフト下書きなし | 🗓「今月のシフト下書きがありません」/「必要人員を入力し『自動アサイン』で下書きを作成すると、不足枠がここに出ます」/ [必要人員へ][自動アサイン] |
| **人員整合性** | volume `byDate` 空 | 📭「2026-04 のボリュームデータがありません」/「実績の取込範囲は2026-02〜。範囲外か未取込です」/ [対象月を2026-05に] |
| 〃 | 問い合わせ有・シフト未取込（`anyStaff===false`, volume.js:253） | ⚖️「この月のシフトが未取込のため在席が0です」/「ボリューム(取りこぼし)は表示中。突合には在席が必要です」/ [CSV読込][シフト表へ]（※ヒートは表示し、在席列だけ薄グレー＋注記） |
| 〃 | 部分月 | パネルでなく上部の細い注意帯: ⚠「部分月：未取込日(◯日)は曜日平均から除外・薄色表示」 |
| **シフト表/必要人員/時間帯別人数** | `hasShiftData===false` | 🗓「2026-04 のシフトはまだありません」/「CSVを読み込むか、必要人員を設定して自動アサインしてください」/ [CSV読込][必要人員へ][自動アサイン] |
| **お問い合わせ概況/時間別** | `rows.length === 0` | 📭「2026-01 のお問い合わせ実績がありません」/「取込範囲は2026-02〜。当月分はAI電話以外が遅れて入ります」/ [対象月を切替] |
| 〃 | 部分月 | パネル不要。コンテキストバー＋既存status行の橙注記で情報提供のみ（本体は出る） |

> P2との関係（レビューM4対応）：シフト系emptyStateの文言にはあえて「CSV読込が必要」等の**P2前提の文言とCSV導線ボタン**が入る。P2（シフトSupabase永続化）後は全月 `hasShiftData===true` となり**このemptyState自体が発火しなくなる**。したがってCSV導線ボタンはP2後にユーザーの目に触れなくなる（残置しても害はないが、P2着手時に導線の要否を1行で確認する）。詳細は §8 末尾参照。

#### 既存コードの置換ポイント（差分）

- inquiry.js:81 `${m} のデータがありません。` → `SQAContext.emptyState(body, {...})`。status は対象月表示のみに簡略化。発火は従来どおり `!rows.length`。
- inquiry.js:162（時間別）同様。
- volume.js:201-202 ボリュームなし（`Object.keys(data.byDate).length === 0`）→ emptyState。
- volume.js:255-256 シフト未取込のインライン赤文字（`anyStaff===false`）→ コンテキストバーのシフトチップ＋在席列の薄表示注記に格上げ（文言をチップと統一）。
- シフト系3タブ（`renderShift`/`renderDemand`/`renderVisualize`）冒頭: `hasShiftData===false` のとき該当 `*-wrap` に emptyState（現状は空テーブルが出るだけ）。

#### 部分月注記の集約（重複の解消）

現状の部分月注記は3か所でバラバラ（volume.js:255「部分データ N日を除外（AI Call以外が未取込）」／ inquiry.js:86「部分月（メール等が未取込…）」／ inquiry.js:167「部分データ N日(薄色)」）。**コンテキストバーの ctx-note に説明の出所を一本化**し、タブ内は「N日除外/薄色」の事実だけを簡潔に残す（説明はバーへ集約・タブ内は重複文を撤去）。

---

## 5. IA/ナビの改善（サイドバー・ダッシュボード入口）

### 5.1 サイドバーの並べ替え（橋渡しの物理配置）

現状は `dashboard` / `staffing-fit` がフラットなトップ、その後2グループ、最後 `history`（index.html:46-64）。「⚖️人員整合性」がダッシュボードと同格の単独項目に見え、"2本柱の橋渡し"という役割が消えている。

**確定する縦順**（`.sidebar` 内の並べ替え）:

```
📊 ダッシュボード              ← 入口（単独）
──────────────────
🗓 シフト管理                  ← 柱A（グループ＋1行説明）
   予定をつくる・編集する（社内シフト）
   └ シフト表 / 必要人員 / 時間帯別 在席数 / 従業員 / 祝日
💬 お問い合わせ分析            ← 柱B（グループ＋1行説明）
   実際に来た問い合わせ実績（自動連携）
   └ 概況サマリ / 時間帯ヒート
──────────────────
⚖️ 人員整合性                  ← 橋渡し（2本柱の直後に独立行）
   シフト予定 × 問い合わせ実績の過不足を突合
──────────────────
🤖 履歴・AI
```

**人員整合性を2本柱の直後**に置くと「シフト(柱A)とお問い合わせ(柱B)を見た上で、その2つを突き合わせる場所」という因果が縦読みで伝わる（現状の柱より上＝前提なしで浮く、を解消）。物理的近接＝意味的橋渡し。区切り線で柱と分ける。

> **`SHIFT_TABS` との関係（未決事項に追加・レビューM1）**: 並べ替え自体はDOM順なので動くが、`nav.js:9` の `SHIFT_TABS` に `staffing-fit` が含まれており、これが topbar アクション（自動アサイン/CSV/リセット）の表示可否を駆動する。新IAでは人員整合性＝「見る（閲覧主体）」場所なので、**`staffing-fit` を `SHIFT_TABS` から外す（＝編集アクションを出さない）方が一貫する**が、これは現状動作の変更になる。意図的判断として §9-10 の未決に明記し、UX-P3着手時に決める。

### 5.2 グループ見出しに1行説明（最小で効く）

`nav-group-head` 直下に薄いキャプションを1行追加。「つくる(予定)」vs「来た(実績)」の対比語で、月セレクタの二重の意味（編集する月/分析する月）の正体を言語化する。専門語はラベルに足さずここで噛み砕く。

```html
<div class="nav-group" data-pillar="shift">
  <div class="nav-group-head">🗓 シフト管理</div>
  <div class="nav-group-cap">予定をつくる・編集する（社内シフト）</div>
  ...
</div>
```

### 5.3 ナビ上のデータ状態バッジ（クリック前に空の理由を示す）

最大の不満（4月に切替→空・理由不明）は、**クリック前にナビ項目側で状態を示す**のが正攻法。`switchTab` を変えず、月変更時に各 nav-item へバッジを付与する。**4.0で `SQAContext` に状態判定を集約したので、バッジ描画も `SQAContext.refresh()` の一部として行い、`SQANav` には DOM 操作ヘルパだけ置く**（判定ロジックの二重実装を防ぐ）。

- シフト系（shift/demand/visualize/employees/holidays）: `ShiftApp.hasShiftData(month)` で 入済/`○未取込`。
- お問い合わせ系（inquiry-overview/inquiry-hourly）: `monthAvailability.inquiry` で complete=無印 / partial=`部分` / none=`○`。
- 人員整合性: 上記2つのANDで「両方そろう/片方欠け」。

バッジは淡い橙チップ（`.nav-badge`）。**記号単独でなく語を優先**（`○未取込`/`部分`、L3対応）。

> **冗長性の判断条件（レビューL2対応）**: 同じ「シフト未取込」が鮮度バッジ・シフトチップ・ナビバッジ・emptyStateの4箇所に同時に出る瞬間があり、情報過多リスクがある。したがって**ナビバッジ（本節）は UX-P3 で「コンテキストバーで足りなければ追加」とし、冗長と判断したら入れない**。判定基準＝「P1運用後、利用者がナビをクリックする前に状態を知りたがる頻度が高い／コンテキストバーだけでは見落とすという声が出た場合のみ追加」。

**P2でシフト永続化後は `hasShiftData` が全月trueを返し、シフト系バッジが自然消滅**（UX矛盾なし）。

### 5.4 ダッシュボードを「運用レビューの玄関」にする

現状ダッシュボード（index.html:69-105）はシフト編集KPI（従業員数/勤務日数/未充足/NG）＋シフト手順のみで、お問い合わせ・人員整合性への導線が皆無。**3段構成に作り替える**（新規view不要、既存カードグリッド流用）。

**A. ヒーロー帯**（1行で現在地）: `SQA運用レビュー｜対象月 2026-05（部分月）` + 一言説明。`SQAData.defaultMonth()`/`isPartialMonth()` 既存APIで取得。

**B. 「今月の運用ひと目」カード4枚**（Supabase直読み＝CSV不要で必ず埋まる）: ライブ総量 / 要対応 / Missed / Miss率（前月比は既存 `prevMonth()`）。各カードに `data-tab` を持たせクリックで該当分析タブへ（例: Missed→`switchTab('inquiry-hourly')`）。

> **集計ロジックの再利用には公開APIの追加が要る（レビューL1）**: `aggChannel`(inquiry.js:116) は IIFE クロージャ内の内部関数で、`inquiry.js:223` は `window.InquiryAnalysis = { render }` しか公開していない。重複実装を避けるため、**`InquiryAnalysis` に `aggChannel`（または玄関用に `overviewTotals(month)`）を公開APIとして追加**してから玄関カードで呼ぶ。「再利用」は無コストではなく、この公開の小改修を伴う。

既存のシフトKPIカードは "シフト管理" 文脈へ降格表示。

**C. 推奨フロー（3ステップ・横並びカード）**: シフト手順の `ol`(index.html:98-103) を運用レビュー導線に置換。
```
① 概況をつかむ      → 概況サマリへ
② 時間帯の山を見る  → 時間帯ヒートへ
③ 人員と突合する    → 人員整合性へ（※シフト取込が必要）
```
③にだけ「シフトCSVが要る」注記を付け、不揃い（指摘3）を"想定通り"と理解させる。

### 5.5 ラベル/アイコンの微修正（用語の裸を緩和）

- ラベルは短く維持（折返し回避）。解説は §5.2 キャプションと title へ。
- 紛らわしさ解消: お問い合わせ側「時間別」→**「時間帯ヒート」**、シフト側「時間帯別人数」→**「時間帯別 在席数」**。柱の違いが出る。
- 「履歴・AI」は title で「シフト確定＋過去シフトのAI質問」を補足。

---

## 6. 用語・凡例・ヒートマップの読み方ガイド

### 6.1 用語SoTを1ファイルに集約：`sqa-glossary.js`（`window.SQAGlossary`）

`sqa-data.js` の後に読込。`{ TERMS, METRIC_DESC, tip(term), legendHTML(metric), attach(root) }` を公開。

> **唯一のSoTの所在を一方向に固定する（レビューM3対応）**: コードが参照するのは `sqa-glossary.js` **だけ**であり、これが**実装上の唯一のSoT**。`docs/SQA-ORA-redesign.md` の厳密定義との同期責任は **`sqa-glossary.js` 側のコメントが redesign.md の該当節をリンク参照する**形（一方向依存）で持つ。「併記」という対称表現は使わない（2ファイルに定義が分散して乖離に気付けなくなるのを防ぐ）。redesign.md を直すときは glossary を更新する、という向きを固定する。

| key | 表示名 | 定義（ツールチップ本文・SQAマネージャー向け） |
|---|---|---|
| `live` | ライブ接触 | お客様が今まさにつながってきた件数。電話＋ビデオ。**メールは含めない** |
| `mail` | メール(非同期) | あとから順次返信。リアルタイムでないので「Missed」概念なし |
| `demand` | 要対応 | ライブ接触のうち人が対応する必要があった件数（AI自動完了を除く） |
| `missed` | Missed(取りこぼし) | 要対応のうち人が出られず取りこぼした件数 |
| `missedRate` | Miss率 | Missed ÷ **要対応**（母数は総量でなく要対応） |
| `staffed` | 在席 | その時間にシフトで入っていた対応者の人数（DE/Mgrは除外可） |
| `capacity` | キャパ(件/人) | 在席1人がその時間に普段こなせる件数の目安。揃った日から自動推定 |
| `required` | 必要人数 | 要対応をさばくのに要る人数の目安（要対応÷キャパ）。平均ベース |
| `gap` | 過不足ギャップ | 在席 − 必要人数。マイナス＝人手不足、プラス＝余裕 |
| `staffedMissed` | 有人Missed | 在席がいたのにMissedが出た時間。人員不足/配置ミスマッチの疑い |
| `partial` | 部分データ | その日/月でメール・電話・ビデオが未取込で数字が欠ける状態。AI電話だけ先に入る日が多い |
| `freshness` | データ鮮度 | チャネルごとの「いつまで取り込めているか」 |

**既存コードと整合する固定定義**（用語集の定義文に織り込む）: Miss率の母数は要対応(demand)（volume.js makeCell / inquiry.js:94 と一致）、ライブはメール除外（inquiry.js:122-123）、メールにMissedなし、CallConnect(電話)はstatus欠落でMissed未算入（inquiry.js:112 hint既出）。

### 6.2 ヒートマップ「読み方」凡例バー（最優先・人員整合性タブ）

現状 index.html:240-244 の散文と volume.js:385-401 のサマリに意味が埋もれている。`#sf-table-wrap` の直前（index.html:246 の `<h3>日別 × 時間` 直後）に**常設の凡例バー**を出す。記号の意味（volume.js実装と一致）:

- `●`（赤・右肩）= 有人Missed（在席がいたのにMissed発生）。buildDailyTable
- `部`（黄土）= 部分データのセル（メール等未取込で除外集計）
- `·12`（淡灰・先頭ドット）= ボリュームは無いが在席だけある時間。cellText
- `✗0.5`（赤小）= 曜日別平均セルの「平均Missed/日」。buildDowTable
- **色の濃さ＝選択中メトリクスの大小**。メトリクス別に意味が変わる（重要）: `gap`は赤=不足/青=過剰/緑=ちょうど、`missed`/`missedRate`は赤が濃いほど多い、`volume`/`demand`は青、`staffed`は緑（cellStyle）。
- グレー無地セル = ボリュームデータなし。

**凡例バー確定文言**（記号には必ず語を併記・L3）:
> 色が濃いほど〈選択中の指標〉が大きい。 ● 有人なのにMissed ／ 部 部分データ(集計外) ／ ·数字 在席のみ(問い合わせ無し) ／ ✗数字 平均Missed/日(曜日表)。セルにカーソルで内訳。クリックで取りこぼし理由。

メトリクスが `gap` のときだけ色凡例を「赤=人手不足 / 青=余裕 / 緑=ちょうど」に動的差し替え（render内で `getMetric()` を見て切替）。`volume.render()` 末尾で `wrap.insertAdjacentHTML('beforebegin', SQAGlossary.legendHTML(metric))` 的に毎回更新。inquiry時間別にも簡易版を出す。

### 6.3 初出 `?` ヘルプチップ（見出し横）

各タブの `<h2>`/コントロールラベル横に `<span class="gloss" data-term="...">?</span>` を置き、hover/tapで用語集本文を出す。

- 人員整合性 h2(index.html:217)横: gap/staffed/required/capacity をまとめた「この画面の言葉」チップ。
- `sf-metric` セレクト横に現在選択メトリクスの1行説明 `<span id="sf-metric-desc">`（change で `SQAGlossary.METRIC_DESC[v]` を表示）。
- お問い合わせ概況カード見出し（ライブ接触/要対応/Missed/Miss率/メール）に小さく `?`。inquiry.js:89 の `card()` を `card(n,l,d,term)` に拡張し data-term を付与。

**ツールチップ方式の確定**: CSSの title属性は複数行＋例＋スタイルが出せないので、**軽量divツールチップ**（`.gloss` に mouseover/focus で固定divを出す。既存 `#sf-detail-panel` と同系の作り、スマホ用に click トグル）を新規実装する。既存セルの title（cellTitle 等の内訳表示）はそのまま残し、用語"説明"だけ gloss に寄せる。

### 6.4 部分データ/鮮度の統一文言

§4.1 の ctx-note を一次の出所とし、セル/在席ゼロのインライン補足も同じ語彙で統一:
- 日セルの「部」title: `部分データ：この日はメール/電話/ビデオが未取込（AI電話のみ）。集計から除外。`
- 在席ゼロ（シフト未取込）: §4.2 の人員整合性エンプティステートへ集約。

---

## 7. 初見オリエンテーション／視覚言語の一貫ルール

### 7.1 オンボーディングは「常設の仕掛け」で代替（重いツアーを入れない）

ステップ式プロダクトツアー（オーバーレイ順送り）・初回フラグ（localStorage seenTour）は**入れない**。理由＝コンテキストバー＋玄関ダッシュボード＋エンプティステートは毎回有用で、出しっぱなしが最良のオリエンテーションになるため。新任マネージャーは以下で自然に方向付けされる:

1. **玄関ダッシュボード**（§5.4）で「今月の運用ひと目＋次に見る場所」を提示。
2. **コンテキストバー**（§4.1）で常に「今どの月・何のデータ・どの状態か」。
3. **エンプティステート**（§4.2）が「壊れていない・想定通り・次はこれ」を空の瞬間に教える＝ツアーの代替。

### 7.2 視覚言語の一貫ルール（全画面共通）

**色＝意味（原則4の具体化）**。既存CSS変数（styles.css: `--danger #dc2626` / `--warning #f59e0b` / `--green #16a34a` / `--accent`）を流用し、意味を固定する。

| 色 | 意味 | 使う場所 |
|---|---|---|
| 赤 (`--danger`) | 取りこぼし／要注意（Missed・有人Missed・取得失敗） | ヒート赤、●、エラー文 |
| 橙 (`--warning`) | 部分・暫定（部分月・部分データ日・未取込バッジ） | コンテキストバー◐、partial注記、nav-badge |
| 緑 (`--green`) | 良好／充足（完全月・在席充足・取込済●） | コンテキストバー●、gap緑 |
| 青 (`--accent`) | 中立の操作・リンク・ボリューム量 | ボタン、ジャンプカード、volume/demandヒート |

**状態記号の固定**: ●=取込済/完全、◐=部分、○=なし/未取込。コンテキストバー・ナビバッジ・凡例で同一記号を使う。**ただし記号は常に語とセット**（L3）。

**エンプティステートは橙基調**（赤=故障に見せない）。取得失敗だけ赤。これで「空＝壊れた」という初見の誤解（指摘2）を色でも打ち消す。

### 7.3 共通CSS（styles.css 追記・既存変数を使用）＋ topbar高さの実測（P1で同時実施）

> **sticky 二段重ねは固定値で妥協しない（レビューM2）**: topbar は brand＋鮮度バッジ（可変長 `freshnessText`）＋月ピッカー＋user-info＋cloud-indicator＋4ボタンと既に高密度で、鮮度バッジが伸びれば狭幅でなくとも wrap する。"崩れたら直す"はP1の趣旨に反するため、**UX-P1着手時に topbar 実高さを測って CSS変数 `--topbar-h` に流し込む数行を最初から入れる**。`.context-bar` の `top` はこの変数を参照する。鮮度バッジ従属化（§4.1）も同じP1で先に効かせる。

```js
// context-bar.js / app.js 初期化時。リサイズ時も再計測
function syncTopbarHeight() {
  const h = document.querySelector('.topbar').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--topbar-h', h + 'px');
}
window.addEventListener('resize', syncTopbarHeight);
syncTopbarHeight();
```

```css
.context-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:6px 16px;background:var(--row-alt);border-bottom:1px solid var(--border);
  position:sticky;top:var(--topbar-h,48px);z-index:90;font-size:12px;}
.ctx-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;
  border:1px solid var(--border);border-radius:999px;background:var(--panel);}
.ctx-chip.ok{border-color:#bbf7d0;background:#f0fdf4;color:#15803d;}
.ctx-chip.warn{border-color:#fde68a;background:#fffbeb;color:#b45309;}
.ctx-chip.muted{color:var(--muted);}
.ctx-month b{color:var(--accent);}
.ctx-note{color:var(--muted);margin-left:auto;}

.empty-state{display:flex;flex-direction:column;align-items:center;gap:8px;
  text-align:center;padding:40px 20px;border:1px dashed var(--border);
  border-radius:10px;background:var(--panel);color:var(--muted);margin:8px 0;}
.empty-state .es-icon{font-size:32px;}
.empty-state .es-title{font-size:15px;font-weight:600;color:var(--text);}
.empty-state .es-reason{max-width:520px;line-height:1.6;}
.empty-state .es-actions{display:flex;gap:8px;margin-top:6px;}
.empty-state .es-actions button{padding:6px 14px;border:1px solid var(--border);
  border-radius:6px;background:var(--panel);cursor:pointer;}
.empty-state .es-actions button.primary{background:var(--accent);color:#fff;border-color:var(--accent);}

.nav-group-cap,.nav-item-cap{font-size:10px;color:#94a3b8;padding:0 10px 4px;line-height:1.3;}
.nav-item-cap{padding-left:14px;margin-top:-2px;}
.nav-group.collapsed .nav-group-cap{display:none;}
.nav-badge{float:right;font-size:9px;color:#b45309;background:#fef3c7;border-radius:5px;padding:0 5px;margin-top:2px;}

/* 鮮度バッジ従属化（P1で同時実施） */
.freshness-badge{font-size:10px;color:var(--muted);opacity:.75;max-width:220px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

.gloss{display:inline-flex;width:15px;height:15px;border-radius:50%;background:#cbd5e1;color:#fff;
  font-size:10px;align-items:center;justify-content:center;cursor:help;margin-left:4px;}
.sf-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#5b6b7b;background:#f8fafc;
  border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin:6px 0;}
.sf-legend .sw{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:3px;}
```

---

## 8. 段階的実装計画（UX-P1 → UX-Pn）

各フェーズ単体で価値が出る粒度。P2（シフトSupabase永続化）と無矛盾な順序。**新規jsを追加する全フェーズで `build.js` の `files` 配列追記を必須タスクに含める**（レビューH1）。

### UX-P1 — 文脈ヘッダー（最小・効果最大）★最小で効く範囲
**指摘1,2,5の核を即解消。** 「今どの月・何のデータ・どの状態か」が常時分かる。

**このP1のスコープ＝「文脈ヘッダー＋空状態＋月モデル＋用語ガイドの最小実装」**。下記の変更ファイルと手順で完結する。

| # | 変更ファイル | 具体的な変更 |
|---|---|---|
| 1 | **新規 `context-bar.js`** | `window.SQAContext = { refresh(tab), emptyState(el,opt) }` を実装。`refresh` は §4.1 の3チップ描画＋ctx-note更新（`SQAData.monthAvailability`＋`ShiftApp.hasShiftData` を読む）。`emptyState` は §4.2 の共通関数。先頭で `syncTopbarHeight()`（§7.3）を実行・resize登録。 |
| 2 | **新規 `sqa-glossary.js`** | `window.SQAGlossary`（§6.1 の `TERMS`/`METRIC_DESC`/`tip`/`legendHTML`/`attach`）。**P1では用語集データ本体＋ chip/legend 描画ヘルパの提供のみ**（凡例バーや`?`の全タブ展開はUX-P5）。コメント冒頭に redesign.md 該当節へのリンク参照（M3の一方向依存）。 |
| 3 | `sqa-data.js` | `monthAvailability(month)`（§3.2）を追加し `window.SQAData` に公開。**鮮度由来＝チップ説明専用**であることをコメント明記。`LAGGING` 定数（freshdesk/SBCalls/CallConnect）を定義。 |
| 4 | `app.js` | (a) `hasShiftData(month)`（§3.2）を `window.ShiftApp` に公開。(b) month-input change ハンドラ末尾（app.js:295の後）に `SQAContext.refresh(state.activeTab)` を1行追加。(c) `switchTab`(app.js:351付近) 末尾に `SQAContext.refresh(tab)` を1行追加。 |
| 5 | `index.html` | (a) `</header>` 直後・`<div class="layout">` 前に §4.1 の `#context-bar` を挿入。(b) `</body>` 前のスクリプト読込に **`sqa-data.js` の後に `sqa-glossary.js`、最後に `context-bar.js`** を追加。(c) `#freshness-badge` の従属化はCSSのみ（DOMは触らない）。 |
| 6 | `styles.css` | §7.3 の `.context-bar` 系・`.empty-state` 系・`.freshness-badge` 従属化・`.gloss`/`.sf-legend` を追記。 |
| 7 | **`build.js`** | `files` 配列に **`'sqa-glossary.js'` と `'context-bar.js'` を追記**（H1・必須）。 |

**実装手順（順序）**:
1. `build.js` の `files` に2つの新規jsを先に追記（追加し忘れ防止）。
2. `sqa-data.js` に `monthAvailability`＋`LAGGING` を追加。
3. `sqa-glossary.js` を新規作成（データ＋ヘルパのみ）。
4. `context-bar.js` を新規作成（`refresh`/`emptyState`/`syncTopbarHeight`）。
5. `index.html` に `#context-bar` と script 読込を追加。
6. `styles.css` を追記（鮮度バッジ従属化を含む）。
7. `app.js` に `hasShiftData` 公開と `refresh()` 呼び出し2箇所を追加。
8. ローカル（root配信）で月切替→チップ更新を確認。`node build.js` 後 `public/` 配信でも `SQAContext` が定義され全タブ動作することを確認（H1の回帰確認）。

**P1の粒度**: 鮮度バッジは従属化（残す・§4.1）。チップは hover説明のみ・非クリック。emptyState関数は実装するが**呼び出しはUX-P2uで配線**（P1ではコンテキストバー＋月モデル＋用語データ基盤＋空状態関数の土台まで）。

### UX-P2u — 統一エンプティステート（空状態の配線）
**指摘2,3を完全解消。** 空の本体を無言にしない。**発火は実データ結果で判定**（§3.2 規約）。
- 変更: `inquiry.js:81,162` を `SQAContext.emptyState` に置換、`volume.js:201-202,255-256` を置換、シフト系3タブ（`renderShift`/`renderDemand`/`renderVisualize`）冒頭に `hasShiftData===false` 分岐で emptyState。`styles.css` は P1 で投入済みのため追加なし。新規jsが無いので **`build.js` 変更は不要**（既存jsの編集のみ）。

### UX-P3 — IA/ナビ改善
**指摘1,2,3,5を構造で補強。**
- 変更: `index.html`（サイドバー並べ替え＋グループキャプション＋区切り線＋ラベル改名）、`nav.js`（バッジDOMヘルパ。判定は `SQAContext` から呼ぶ／`SHIFT_TABS` から `staffing-fit` を外すか §9-10 で決定）、`styles.css`（`.nav-group-cap`/`.nav-item-cap`/`.nav-badge`）。
- ナビバッジは §5.3 の条件で「冗長なら入れない」を判断（L2）。

### UX-P4 — ダッシュボード玄関化
- 変更: `index.html`（ダッシュボードsection を ヒーロー＋運用カード＋推奨フローに書換、`data-tab`付きジャンプカード）、`inquiry.js`（**`aggChannel`/`overviewTotals` を `window.InquiryAnalysis` に公開追加**＝L1）、`app.js`（玄関カードでそれを呼び集計、クリックで `switchTab`）。

### UX-P5 — 用語・凡例・読み方ガイド（全タブ展開）
**指摘4を解消。** 着手順: ①volume凡例バー＋メトリクス説明（効果最大）→ ②統一部分データ文言 → ③見出し`?`チップ → ④inquiry側展開。
- 変更: `volume.js`（render末尾で `SQAGlossary.legendHTML(metric)` 挿入＋`sf-metric-desc`）、`inquiry.js:89`（`card()` を `card(n,l,d,term)` に拡張）、`index.html`（`?`チップ・凡例挿入先）、`styles.css`（追加分があれば）。`sqa-glossary.js` は P1 で投入済みなので **`build.js` 変更は不要**。

### P2（シフトSupabase永続化）との関係 — ★M4対応で主張を訂正
- UX-P1〜P5 はすべて **`hasShiftData(month)` の判定実装を差し替えるだけ**でP2に追従する。P2後は `hasShiftData` をローカルstate判定→鮮度判定に変えるだけで、シフトチップ/ナビバッジが全月「●取込済」になり、指摘3が自然消滅。
- **訂正（M4）**: 「文言は不変」は不正確。正しくは——**P2後はシフト系emptyStateが発火しなくなり（全月 `hasShiftData===true`）、内包する「CSV読込が必要」等のP2前提文言とCSV導線ボタンは自然に役目を終える**。判定差し替えだけで挙動が正しくなるのは事実だが、"文言不変"ではなく**"文言が無効化される"**が正確。P2着手時に「シフト系emptyStateのCSV導線ボタンがP2後に残らない（or 残しても害がない）こと」を1行で確認する。UI契約・CSSは不変。

---

## 9. 未決事項と推奨デフォルト

| # | 論点 | 選択肢 | 推奨デフォルト |
|---|---|---|---|
| 1 | コンテキストバーのチップをクリック可能にするか | hover説明のみ / クリックでショートカット（未取込→CSV読込、なし→取込済月へジャンプ） | **UX-P1ではhover説明のみ・非クリック**。クリック動作はUX-P4のジャンプカードと役割が被るため後回し |
| 2 | お問い合わせ「取込状態」の基準 | 最も進んだ遅れチャネル基準 / **全チャネルが揃う最遅到達日基準** / チャネル毎(電話/メール/ビデオ)に分割表示 | **全チャネルが揃う最遅到達日基準（＝coverDay）を主表示**（H3で反転）。先行チャネル(AI電話)の到達は副次注記。チャネル毎分割は利用実態を見て検討 |
| 3 | 鮮度バッジ(index.html:24) | 撤去してコンテキストバーに一本化 / **従属化して残す（P1で実施）** | **従属化して残す**（source別生最新日は別レイヤ）。**P1で淡色・短縮を同時実施**（M2）。完全撤去はUX-P3で利用実態を見て再評価 |
| 4 | コンテキストバーの sticky 二段重ね | top:48px固定 / **JSで topbar 実高さ測定（P1で実施）** | **P1着手時に `--topbar-h` 実測を最初から入れる**（M2）。"後で微調整"を残さない |
| 5 | コンテキストバーを全タブ常駐にするか | 全タブ / ダッシュボード＋分析系のみ（シフト編集中は煩い懸念） | **全タブ常駐**（原則2 Always orient を優先）。煩雑との声が出たら高さを詰める |
| 6 | 人員整合性の配置 | 2本柱の直後の独立行（採用） / お問い合わせグループ末尾の子 | **2本柱の直後の独立行**。実利用で「シフト寄り/お問い合わせ寄りどちらの文脈で開くか」を確認し最適化 |
| 7 | 用語ツールチップの実装 | CSS title で妥協 / 軽量divツールチップ新規 | **軽量div方式**（複数行＋例＋スタイルが要るため）。コード量増は許容 |
| 8 | 用語集の全件一覧（ヘルプモーダル） | 出す / 出さない | **当面出さない**。需要が出れば `SQAGlossary.TERMS` から自動生成可 |
| 9 | 用語定義の文言 | redesign.md の指標定義流用 / SQAマネージャー向け平易化 | **平易化版（§6.1）を採用**。**SoTは `sqa-glossary.js` のみ**、redesign.md とは一方向リンクで同期（M3。"併記"はしない） |
| 10 | `staffing-fit` を `SHIFT_TABS`(nav.js:9) に残すか | 残す（編集アクションを出す・現状） / 外す（閲覧主体に） | **UX-P3で決定**。橋渡し＝閲覧主体の新IAとは「外す」が一貫するが現状動作変更になるため意図的判断として明記（M1） |
| 11 | ナビバッジ(§5.3)を入れるか | 入れる / コンテキストバーで足りれば入れない | **UX-P3で「冗長なら入れない」を判断**（L2）。上部レイヤ3層＋4箇所重複の情報過多を避ける |
| 12 | コンテキストバーと本体の状態が食い違ったとき | チップ優先 / 本体（実データ）優先 | **本体（実データ）優先**。emptyStateのreasonに鮮度由来の補足を添える（H2 規約） |

---

## レビュー指摘と対応

批判レビューの全10指摘（高3・中4・低3）への対応を一覧化する。すべて本文へ織り込み済み。

| 指摘 | 重大度 | 内容（要約） | 本最終版での対応 | 反映箇所 |
|---|---|---|---|---|
| **H1** | 高 | `public/` 二重管理。新規js（`context-bar.js`/`sqa-glossary.js`）を `build.js:8-12` の固定 `files` 配列に追記しないとVercelで404し全タブ崩壊 | 冒頭に「root編集・public非直接・build.js追記必須」の大前提ブロックを新設。§8 の新規jsを足す全フェーズ（P1/該当なしのP2u・P5は不要と明記）の変更ファイルに `build.js` を明示。P1手順1で先に追記＋手順8で `public/` 配信回帰確認 | 冒頭⚠ブロック / §8 各フェーズ / §8-P1表#7・手順1,8 |
| **H2** | 高 | 鮮度ビュー由来の `monthAvailability` と、実データビュー(`rows`/`byDate`)由来の空判定が別物。同一視するとチップ「取込済」なのに本体空の不整合 | §3.2 に2系統の役割分離表＋食い違い時の「本体優先・reasonに鮮度補足」規約を新設。`monthAvailability` のコメントに「チップ説明専用」明記。emptyStateは実データ結果で発火と全箇所統一 | §3.2 / §4.2 / §9-12 |
| **H3** | 高 | 部分月チップの「最も進んだ遅れチャネル基準」はAI電話到達日を表示し「全部揃っている」と誤った安心を与える | 基準を**「最も遅れているチャネルの到達日＝全チャネル揃い境界(coverDay)」へ反転**。`monthAvailability` を coverDay/leadDay 返却に修正。文言を `◐部分（全チャネル揃い〜N日／以降はAI電話のみ）` に変更 | §3.2 関数 / §3.3 / §4.1 文言 / §9-2 |
| **M1** | 中 | サイドバー並べ替えと `SHIFT_TABS`(nav.js:9) のアクション表示の絡みが未記載。人員整合性=閲覧なのに編集アクションが出る矛盾 | §5.1 に `SHIFT_TABS` との関係を追記し「`staffing-fit` を外すか」を未決化。§9-10 に意図的判断としてUX-P3で決定と明記 | §5.1 / §9-10 / §8-P3 |
| **M2** | 中 | `top:48px` sticky は未検証。topbar高密度＋可変長鮮度バッジでwrapしP1初回から二段崩れ確率が高い | `--topbar-h` 実測JS（`getBoundingClientRect`）をP1で最初から投入。`.context-bar` の top を変数参照に。鮮度バッジ従属化（淡色・短縮CSS）もP1で同時実施 | §7.3 / §4.1 鮮度バッジ / §9-3,4 / §8-P1 |
| **M3** | 中 | 用語が `sqa-glossary.js` と redesign.md の二重ソースになり乖離検知不能 | 「コードが読むのは `sqa-glossary.js` のみ＝唯一のSoT。redesign.md とは glossary コメントからの**一方向リンク参照**で同期」と明記。"併記"の対称表現を削除 | §6.1 / §9-9 / §8-P1表#2 |
| **M4** | 中 | 「P2後も文言不変」は不正確。シフト系emptyStateはP2前提文言とCSV導線を内包し、P2後に陳腐化 | 主張を訂正：「P2後はシフト系emptyStateが発火しなくなり文言は自然に役目を終える＝"文言不変"でなく"文言が無効化される"」。CSV導線ボタンがP2後に残らない確認を1行追加 | §8 P2関係 / §4.2 注記 |
| **L1** | 低 | `aggChannel`(inquiry.js:116) はIIFE内部関数で `InquiryAnalysis = { render }` のみ公開。「再利用」は公開API追加の小改修が要る | §5.4-B に「`InquiryAnalysis` に `aggChannel`(or `overviewTotals(month)`) を公開APIとして追加」を明記。§8-P4 の変更ファイルに反映 | §5.4-B / §8-P4 |
| **L2** | 低 | 鮮度バッジ＋3チップ＋ctx-note＋ナビバッジ＋emptyStateで上部3層・同状態4箇所の情報過多 | §5.3 に「ナビバッジはUX-P3で『コンテキストバーで足りなければ追加』、冗長なら入れない」の判断条件を明記。§9-11 に未決追加。鮮度バッジ従属化をP1で実施し主役をバーへ集中 | §5.3 / §9-11 / §4.1 |
| **L3** | 低 | `●`(完全)と`◐`(部分)は12pxチップで色覚・小画面で判別困難 | 「チップ・バッジ・凡例は常に記号＋語をセット、記号単独で意味を負わせない」規約を全箇所に明記 | §4.1 記号規約 / §5.3 / §6.2 凡例文言 / §7.2 |

### 検証メモ（最終版で再確認した実装事実）
- `build.js:8-12` の `files` 配列は固定リスト（`index.html`/`sqa-data.js`/`app.js`/`cloud.js`/`history.js`/`volume.js`/`inquiry.js`/`nav.js`/`styles.css`/`firebase-config.js`/`supabase-config.js`）。新規jsはここに足さない限り `public/` に出ない → H1は実在。
- `inquiry.js:223` は `window.InquiryAnalysis = { render };` のみ。`aggChannel`(inquiry.js:116) は非公開 → L1は実在。
- `inquiry.js:81` の空判定は `!rows.length`、`volume.js:201` は `Object.keys(data.byDate).length === 0` で、ともに実データクエリ結果由来。`volume.js:202` のハードコード文言 `contact_facts は 2026-02 〜 2026-06-05` がAI電話先行・他チャネル遅延の傍証 → H2/H3は実在。
- topbar(index.html:22-42) は brand＋`#freshness-badge`＋月ピッカー＋`#user-info`＋`#cloud-indicator`＋4ボタンの高密度構成 → M2は実在。
- 追加する `monthAvailability`/`hasShiftData` は既存層（`SQAData.freshness/monthRange`、`state.shift`）の上に乗る副作用なしの薄い表示層であることを再確認。
