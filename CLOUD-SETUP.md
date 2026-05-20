# クラウド設定ガイド (Firebase + Vercel)

複数人で同時編集できるようにする手順。**所要時間 約20分**、**完全無料** (無料枠内)。

---

## 1. Firebase プロジェクト作成 (5分)

1. https://console.firebase.google.com にアクセス (Googleアカウントでログイン)
2. **「プロジェクトを追加」** をクリック
3. プロジェクト名: `shift-manager` など好きな名前 → 続行
4. Google Analytics: **無効** で OK → プロジェクトを作成
5. 完了したら「続行」

## 2. Authentication (Google ログイン) 有効化 (3分)

1. 左メニュー **「Build」 → 「Authentication」** → 「始める」
2. **Sign-in method タブ** → **Google** を選択
3. 「有効にする」をオン → サポートメールを設定 → 保存

## 3. Firestore Database (DB) 作成 (3分)

1. 左メニュー **「Build」 → 「Firestore Database」** → 「データベースの作成」
2. ロケーション: **`asia-northeast1` (東京)** を選択 → 次へ
3. **テストモードで開始** を選択 → 有効にする
4. (※テストモードは30日後に書き込み禁止になります。後述の「セキュリティルール」で本番設定にします)

## 4. Firebase 設定値をコピー (2分)

1. 左上の **歯車アイコン → 「プロジェクトの設定」**
2. 「マイアプリ」セクションで **`</>` (ウェブアプリ追加)** をクリック
3. アプリ名: `shift-manager-web` などを入力 → 「アプリを登録」
4. 表示される `firebaseConfig` オブジェクトを **コピー**
5. `firebase-config.js` を開いて、貼り付け+コメント解除:

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSy...",
  authDomain: "shift-manager-xxx.firebaseapp.com",
  projectId: "shift-manager-xxx",
  storageBucket: "shift-manager-xxx.appspot.com",
  messagingSenderId: "123...",
  appId: "1:123...:web:..."
};

// 社内のメールドメインを入れる (例: 'sqa.co.jp')
window.ALLOWED_DOMAIN = 'your-company.com';
```

## 5. ローカル動作確認 (2分)

`index.html` をブラウザで開く → ログイン画面が出る → Googleでログイン → 同期開始 ☁️

別のブラウザ/PC で開いて、同じ Google アカウントでログインすると **同じデータ** が見えるはず。

## 6. 公開URLを取得 (5分・GitHub不要)

### 方法 A: Netlify Drop (一番カンタン、推奨)

1. https://app.netlify.com/drop にアクセス
2. このフォルダ (`Shift Management`) をブラウザにドラッグ&ドロップ
3. すぐに URL が生成される (例: `lucky-cat-12345.netlify.app`)
4. その URL をコピー

**無料アカウント作成** (Email/Googleで可・GitHub不要) すると:
- 再デプロイが簡単 (同じドラッグ&ドロップ)
- カスタムドメインや名前変更可能
- 自動 HTTPS

### 方法 B: Cloudflare Pages (Direct Upload)

1. https://dash.cloudflare.com で無料アカウント作成 (Email可・GitHub不要)
2. 左メニュー Workers & Pages → 「Create application」 → 「Pages」 → 「Upload assets」
3. プロジェクト名入力 → このフォルダをアップロード
4. 生成された URL (例: `shift-manager.pages.dev`) をコピー

### 方法 C: ローカル運用 (デプロイなし)

社内ネットワークでだけ動かしたい場合は、デプロイせず `serve.ps1` で同じ機能が使えます (ただしポート開放・固定IPなど社内インフラに依存)。

## 7. Firebase に公開ドメインを許可 (1分)

1. Firebase Console → Authentication → **Settings タブ** → **承認済みドメイン**
2. 「ドメインを追加」 → 上記で取得したURL (例: `lucky-cat-12345.netlify.app`) を貼り付け → 追加

これでその URL から Google ログイン可能になります。

## 8. Firestore セキュリティルール (本番化)

テストモードは30日で書き込み不可になるので、ログイン済みユーザーのみアクセス可能なルールに変更:

1. Firebase Console → Firestore Database → **ルールタブ**
2. 以下に置き換えて「公開」:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /shiftManager/{doc=**} {
      // 認証済み + 指定ドメインのみ
      allow read, write: if request.auth != null
        && request.auth.token.email.matches('.*@your-company\\.com$');
    }
  }
}
```

`your-company\\.com` を **実際の社内ドメイン** に変えてください (バックスラッシュ2つ必須)。

---

## 運用

- チームメンバーに **Vercel の URL を共有** するだけ
- 各自 Google ログイン → 即同期で共同編集
- 誰かが編集した内容は **約500ms 以内** に全員のブラウザに反映 (Firestore real-time)
- 競合: 最後の書き込みが勝つ (LWW)。同時に同じセルを編集した場合は後勝ち

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `FIREBASE_CONFIG not set` (コンソール) | `firebase-config.js` のコメント解除し忘れ |
| ログイン後 `<ドメイン> のアカウントでログインしてください` | `ALLOWED_DOMAIN` を正しく設定 |
| `Missing or insufficient permissions` | Firestore セキュリティルールが厳しすぎ。Step 8 を再確認 |
| `auth/unauthorized-domain` | Step 7 で Vercel ドメインを承認済みドメインに追加 |
| ☁️ が ⚠️ オフラインになる | ネット接続確認 / Firebase 無料枠超過 (50K read/day) |

## 元のローカル運用に戻す

`firebase-config.js` の `FIREBASE_CONFIG = null;` のままにしておくと、Firebase はロードされず LocalStorage モードで動きます (現状の挙動)。

## 無料枠の目安

Firebase Spark プラン (無料):
- Firestore: 1GB ストレージ、50K read/day、20K write/day、20K delete/day
- Authentication: 無制限
- Hosting: 10GB

**30人のチームで月に十分余裕** (1日あたり編集 ~100回想定なら 100 × 30 = 3,000 write/day << 20K)。
