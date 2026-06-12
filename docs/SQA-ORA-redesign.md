# SQA Operation Review Analytics — 統合設計ドキュメント（最終版 v2）

> シフト管理（旧 Shift Manager）× お問い合わせ分析の統合再設計。エージェントチーム（IA/Navigation・Data-Persistence・Inquiry-Analysis・KPI-Dashboard・Code-Migration の5観点 → 統合 → 批判レビュー → 確定）が作成。実データ検証済み。
> 対象: `github.com/shuya-toku/shift-manager`（ローカル正本 `SQA AI Agent Team/Shift Management`）。基準日 2026-06-12。KPI Supabase = `teovwpuubkefbvuuxzvo`。

---

## 0. 検証で確定した「動かせない事実」（設計の前提）

| # | 事実 | 設計への影響 |
|---|---|---|
| F1 | `monthly_report`/`monthly_kpi_summary`/`property_master`/`forecast_workforce`/`contact_facts` は**すべて `monthly_kpi` スキーマ**。`fd_ticket_daily`/`kpi_daily_yesterday`/`kpi_daily_video` のみ `public`。 | PostgRESTは既定で`public`のみ公開→`monthly_kpi`系はブラウザ直読み不可→**public ラッパービュー必須**。既存 `v_staffing_*` が読めるのは public ビューで `contact_facts` をラップしているため。 |
| F2 | 2026-06 は**AI Call 793行のみ**。他チャネルは最新 05-24（IVRyは03-31で停止）。 | 当月ダッシュボードは恒常的に空に近い→**既定月を「直近完全月」へフォールバック**。 |
| F3 | `AI_Auto` 保有は**AI Call/IVRyのみ**。freshdesk・SBCalls・CallConnect は0。 | 自動化率はチャネル横断不可→**source限定定義**。 |
| F4 | `Missed` 保有は**AI Call/SBCallsのみ**。freshdesk=0、CallConnectはstatus空。 | demand/missed集計はstatus持ちsourceに限定。CallConnectは総量のみ。 |
| F5 | freshdeskは `SQA_Replied`/`CRS_Replied` のみ＝**Missed概念なし**。 | メールは総量＋内訳のみ。滞留は `fd_ticket_daily` で別管理。 |
| F6 | `cloud.js` は `FIREBASE_CONFIG=null` で完全no-op。フックは `loadOverride`/`saveOverride`/`init({skipLoad})`。 | Firestoreは凍結ではなく**読込順から外すだけ＝移行不要**。 |

---

## 1. 製品ビジョン
**SQA Operation Review Analytics** = シフト作成専用だった Shift Manager を、SQAマネージャーの**オペレーション・レビュー基盤**へ昇格。「人をどう配置し、その配置がお問い合わせ対応にどう効いたか」を一画面で振り返る。

- **統合ダッシュボード**（起動時の既定画面）＋ **柱① シフト管理** ＋ **柱② お問い合わせ分析**。両柱を**人員整合性**が橋渡し（＝差別化の核）。
- 原則: ①「入った状態」最優先（起動時CSV不要、当月は直近完全月へフォールバック）②バニラJS継続・FW移行なし ③既存スキルと役割分担 ④データ鮮度を常時明示 ⑤段階的・各フェーズ単体で価値が出る。

## 2. 情報設計ツリー
```
SQA Operation Review Analytics                ← 表示名のみ変更
├─ 📊 ダッシュボード (統合)        [dashboard]   既定表示（既定月=直近完全月）
├─ ⚖️ 人員整合性 (橋渡し)         [staffing-fit] 既存・準トップへ昇格
├─ 🗓 シフト管理 (柱①)            [section: shift]
│     ├─ シフト表 / 必要人員 / 時間帯別人数   (既存・主役3画面)
│     └─ マスター ▸ 従業員 / 祝日             (既存・折りたたみ)
├─ 💬 お問い合わせ分析 (柱②)      [section: inquiry]
│     ├─ 概況サマリ [inquiry-overview]   (P1)
│     ├─ 時間別     [inquiry-hourly]     (P1)
│     ├─ チャネル/施設別 [inquiry-breakdown] (P4)
│     └─ 推移・比較  [inquiry-trend]      (P4)
└─ 🤖 履歴・AI       [history]            (既存)
```
- ナビ=左2階層サイドバー。既存 `data-tab` の show/hide を流用、`switchTab()` 論理は維持。topbar=ブランド＋グローバル月セレクタ＋鮮度バッジ＋文脈アクション。
- 既存スキルとの分担: 常設タブ=pull/探索、レポートスキル(sqa-weekly等)=push/共有。月次の確定/概算は monthly-actual/forecast が `monthly_kpi` に**書き**、タブはラッパー越しに**読む**。

## 3. データ&永続化アーキ
- **KPI Supabase 1本に集約**。ブラウザは`public`のみ読めるので `monthly_kpi` 系は**public集計ラッパービュー経由**（個票は公開しない＝D4）。
- **お問い合わせ=Supabase直読み**（`volume.js` の月範囲fetch/cacheを流用、`state.month` 共有で月切替）。
- **シフト=Supabase永続化（案A確定）**: 新規 `public.shift_state(month PK, payload jsonb, updated_at, updated_by)`。月単位レコード化で起動時1行ロード。`persist.js` が `cloud.js` を置換し `loadOverride/saveOverride` を実装。保存は800msデバウンス upsert。
  - RLS: select/insert/update許可、**DELETEポリシー無し＝削除禁止**（B3）。`?ro=1` 閲覧専用モード（保存系UI非表示）。
  - localStorageは**読み取りフォールバック専用**（Supabase成功時は書き戻さない＝古いローカルでリモートを汚さない, B2）。`STORAGE_KEY` 不変。
  - 同時編集は**1人運用前提＝楽観ロックなし**、`updated_at` を「最終保存 HH:MM」表示のみ（B5）。
- **データ鮮度/部分データ（最重要・F2）**: `v_source_freshness`（source別 latest/is_live）を起動時読込→**既定月=全期待ソースが揃う最新月**。完全日判定を「freshnessベース」へ一般化し、当月はライブ負荷(Call/Video)のみで数字を出す。全画面に鮮度バナー＋未確定月は薄色「部分」ラベル。
- **CSV再定義**: 利用者操作からCSVを外す。お問い合わせCSVは既存月次パイプラインで `contact_facts` へ（アプリは読むだけ）。シフトCSVは起動時自動ロードに置換、初期移行は**正本1台で1回＋事前JSONバックアップ**。

## 4. 指標定義（一次ソースを単一に固定＝ドリフト防止）
| source | AI_Auto | Missed | demand/missed | 総量 |
|---|---|---|---|---|
| AI Call | ○ | ○ | ○ | ○ |
| IVRy(〜03-31) | ○ | × | △過去のみ | ○ |
| SBCalls(Video) | × | ○ | ○ | ○ |
| CallConnect | × | status空 | **×** | ○のみ |
| freshdesk(Mail) | × | **なし** | × | ○メール総量 |

- AI Call 自動化率/転送率/Miss率 → 一次=**kpi_daily_yesterday**。Video → **kpi_daily_video**。メール=総量＋内訳のみ(Missed概念なし)。
- ライブ負荷=`channel<>'Mail'` の総接触。要対応(demand)=ライブのうちAI_Auto除外・status持ちsourceのみ(CallConnect除外)。
- **率の再計算はkpi系/ monthly系を一次に固定**。contact_facts系(v_staffing_*)はボリューム/時間別ヒート専用。

## 5. 統合ダッシュボード
- 既定月=直近完全月。当月選択時は「AI Callのみ・部分表示」バナー。
- ゾーン0=情報帯（初版は緑/灰の事実提示中心、🔴は確定しきい値のみ段階ON）／ゾーン1=KPIカード4-6枚／ゾーン2=人員整合性の凝縮（`volume.js` の agg/renderSummary 共通化して再利用）／ゾーン3=軽量SVGトレンド3点。
- 性能: `v_dashboard_daily`（日次集計、月範囲フィルタ必須、件数増でマテビュー化）。

## 6. 技術設計・ロードマップ
- バニラJS継続。新タブ=サイドカーIIFE。新規ファイル: `sqa-data.js`(共通fetch/鮮度/既定月/完全日)・`nav.js`・`inquiry.js`・`dashboard.js`・`persist.js`。`build.js` の files 配列に追記、`index.html` 読込順から `cloud.js` 除外。
- 新規SQLビュー: `v_source_freshness`/`v_dashboard_daily`/`v_monthly_report`/`v_monthly_kpi_summary`/`v_inquiry_facility_monthly`/`v_inquiry_channel_daily`（既存 `v_staffing_*` は再利用）。

### ロードマップ（価値先行・リネーム単独フェーズ廃止）
| フェーズ | 成果物（単体で価値） | 主作業 |
|---|---|---|
| **P1: ナビ刷新＋お問い合わせ概況**（2-3日） | 2階層サイドバー＋改称＋**お問い合わせ概況＋時間別ヒート**を同時投入。起動時Supabase直読みで「入った状態」。鮮度バナー＋既定月フォールバック | `v_source_freshness`投入、`sqa-data.js`/`nav.js`/`inquiry.js`、TZ検証(D1) |
| **P2: シフトのSupabase永続化＝入った状態**（2-3日） | 起動時自動ロード/編集→自動upsert/他PC共有/readOnly/過去月横断 | `shift_state`作成、`persist.js`、`supabase-config.js`をKPIへ、月切替ロード、cloud.js除外 |
| **P3: 統合ダッシュボード**（1-2日） | KPIサマリ＋人員整合性凝縮＋トレンド＋HTMLレポートエクスポート導線 | `dashboard.js`、`v_dashboard_daily` |
| **P4(任意): 残りサブタブ・共有・整理** | チャネル/施設別・推移、monthlyラッパー、shift_records移設、監査トリガ、Chart.js必要時 | — |

### P1 着手タスク（要点）
1. `v_source_freshness` を `apply_migration` で投入。
2. `sqa-data.js`: `SQAData.fetch/freshness/defaultMonth/isCompleteDay`（KPI接続を `volume.js` から共通化）。
3. `nav.js`: タブnav→2階層サイドバー（`data-tab` 維持、`inquiry-*` は lazy render）、鮮度バッジ、月セレクタ移設、ブランド改称（表示層のみ）。
4. `inquiry.js`: 概況（量=v_staffing_bands・率=kpi_daily_*・前月比）＋時間別ヒート（既存 v_staffing_volume_hourly 流用）。
5. `build.js`/`index.html` 更新（cloud.js除外）。
- **P1ブロッカー(D1)**: 時間別着手前に `contact_facts.contact_hour` のTZ（JST/UTC）を1クエリ検証し、シフトバンド(JST)へ正規化。

## 7. 未決事項（推奨デフォルト）
KPI目標/危険ライン=仮置きでP3、🔴は段階ON｜同時編集=1人前提｜他チャネル自動ETL化=範囲外（部分表示前提）｜前年比=データ無で非表示｜リポ/Vercel名/STORAGE_KEY=据置（表示名のみ変更）｜チャート=P3まで依存ゼロ、必要時Chart.js CDN1本。

## 8. 批判レビュー対応（抜粋）
A1 monthly_kpi非公開→publicラッパー必須 / A2 IVRy停止→率の一次をkpi固定 / A3 CallConnect status空→総量のみ / A4 当月空→既定月フォールバック / B1 リネーム単独廃止→P1で価値同時投入 / B2 移行正本一本化＋ローカル書戻し禁止 / B3 DELETE禁止＋readOnly / B5 楽観ロック廃止 / C4 指標一次ソース単一化 / D1 TZ検証 / D4 個票非公開。
