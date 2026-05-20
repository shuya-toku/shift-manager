# Supabase + AI クエリ セットアップガイド

所要時間: **約15分**。完全無料枠で動きます。

---

## 1. Supabase プロジェクト作成

1. https://supabase.com → 「Start your project」
2. GitHub または Email でサインイン
3. 「New project」→ 名前: `shift-manager` / DB パスワード設定 / Region: **Northeast Asia (Tokyo)**
4. プロジェクト作成まで1〜2分待つ

---

## 2. テーブル作成 (SQL Editor)

左メニュー **「SQL Editor」** → 「New query」に以下を貼り付けて **Run**:

```sql
CREATE TABLE IF NOT EXISTS shift_records (
  id            BIGSERIAL PRIMARY KEY,
  month         TEXT        NOT NULL,
  date          DATE        NOT NULL,
  employee_id   TEXT        NOT NULL,
  employee_name TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT '',
  nationality   TEXT        NOT NULL DEFAULT '',
  start_time    TEXT        NOT NULL,
  end_time      TEXT        NOT NULL,
  break_min     INTEGER     NOT NULL DEFAULT 0,
  confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shift_records_date_emp_uq UNIQUE (date, employee_id)
);

-- RLS: 社内ツールなのでフルアクセス許可
ALTER TABLE shift_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON shift_records FOR ALL USING (true) WITH CHECK (true);
```

---

## 3. 接続情報をコピー

左メニュー **「Project Settings」→「API」**:

| 項目 | コピー先 |
|---|---|
| Project URL | `window.SUPABASE_URL` |
| `anon` `public` キー | `window.SUPABASE_ANON_KEY` |

`supabase-config.js` を開いて貼り付け:

```js
window.SUPABASE_URL      = 'https://xxxx.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGc...';
```

その後 git commit + push → Vercel 自動デプロイ。

---

## 4. Claude API キーを Vercel に設定

1. https://console.anthropic.com → API Keys → Create key
2. Vercel ダッシュボード → shift-manager プロジェクト → **Settings → Environment Variables**
3. 追加:
   - Name: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (コピーしたキー)
   - Environment: Production / Preview / Development すべてチェック
4. 「Save」→ **Deployments → 最新デプロイを Redeploy**

---

## 使い方

1. シフト表を完成させたら **「履歴・AI」タブ** を開く
2. **「今月のシフトを確定」** → Supabase に保存
3. チャット欄に質問を入力:
   - 「4月15日の15時台は誰が働いていた？」
   - 「先月の水曜日の夜間は何人体制だった？」
   - 「4月にOPが一番少なかった時間帯は？」

月を変えたい場合はヘッダーの「対象月」を変更してから質問してください。

---

## 無料枠の目安

| サービス | 無料上限 | 想定使用量 |
|---|---|---|
| Supabase (DB) | 500MB ストレージ, 5GB 転送/月 | 余裕あり |
| Supabase (API) | 無制限リクエスト | — |
| Anthropic (Claude Haiku) | 従量課金 (安価) | 1回の質問 ≈ $0.001 以下 |

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 「Supabase が未設定」アラート | supabase-config.js の URL/KEY を確認 |
| 「ANTHROPIC_API_KEY が未設定」 | Vercel 環境変数 → Redeploy |
| 確定後にチャットで「データなし」 | 先に「今月のシフトを確定」を押してから質問 |
| `CORS` エラー (ローカル) | Vercel にデプロイした URL から使用 (serve.ps1では /api は動かない) |
