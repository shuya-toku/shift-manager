/* ============================================================================
   Firebase Configuration
   ============================================================================
   セットアップ:
   1. https://console.firebase.google.com で新規プロジェクト作成
   2. Authentication → 始める → Google プロバイダを有効化
   3. Firestore Database → データベースの作成 → テストモードで開始
   4. プロジェクト設定 (歯車) → 全般 → ウェブアプリ追加 (</> アイコン)
   5. 表示される firebaseConfig オブジェクトを以下の CONFIG にコピペ
   6. ALLOWED_DOMAIN を社内のメールドメインに変更

   設定なしのままだとローカル (LocalStorage) モードで動作します。
   ============================================================================ */

window.FIREBASE_CONFIG = null;
// window.FIREBASE_CONFIG = {
//   apiKey: "AIzaSy...",
//   authDomain: "your-project.firebaseapp.com",
//   projectId: "your-project",
//   storageBucket: "your-project.appspot.com",
//   messagingSenderId: "1234567890",
//   appId: "1:1234567890:web:abcdef123456"
// };

// 社内のメールドメインを指定。null なら制限なし
// 例: 'sqa.co.jp' → @sqa.co.jp のアカウントのみログイン可
window.ALLOWED_DOMAIN = null;
// window.ALLOWED_DOMAIN = 'your-company.com';

// Firestore のドキュメントパス (複数チーム/環境を分けたい場合は変更)
window.FIRESTORE_ROOT = 'shiftManager/main';
