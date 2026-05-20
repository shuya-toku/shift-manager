/* ============================================================================
   cloud.js — Firebase Auth + Firestore real-time sync
   ----------------------------------------------------------------------------
   Behavior:
   - If FIREBASE_CONFIG is null: silently no-op (app runs in LocalStorage mode).
   - If FIREBASE_CONFIG is set: show login overlay → Google sign-in → connect
     Firestore → real-time sync. ALLOWED_DOMAIN restricts to a specific email
     domain if set.
   ============================================================================ */
(function () {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg) {
    // Local mode — app.js handles everything via LocalStorage. Nothing to do.
    console.log('[cloud] FIREBASE_CONFIG not set — running in local (LocalStorage) mode.');
    return;
  }

  // ---- Cloud mode setup ----
  console.log('[cloud] FIREBASE_CONFIG found — initializing Firebase…');

  let app, auth, db;
  try {
    app = firebase.initializeApp(cfg);
    auth = firebase.auth();
    db = firebase.firestore();
  } catch (e) {
    console.error('[cloud] Firebase init failed', e);
    alert('Firebase 初期化に失敗しました: ' + e.message);
    return;
  }

  // Install save override IMMEDIATELY (before app init) so app.js doesn't run
  // local-only init. We'll trigger init from inside the auth callback.
  let suppressNextRemoteApply = false;
  let saveDebounceTimer = null;
  let pendingState = null;

  window.ShiftApp.loadOverride = true; // signal app.js to defer init
  window.ShiftApp.saveOverride = (state) => {
    // Debounce writes (500ms) — avoid hammering Firestore on rapid edits
    pendingState = state;
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(flushPendingSave, 500);
  };

  function flushPendingSave() {
    saveDebounceTimer = null;
    if (!pendingState) return;
    const snapshot = JSON.parse(JSON.stringify(pendingState));
    pendingState = null;
    suppressNextRemoteApply = true;
    setIndicator('syncing');
    db.doc(window.FIRESTORE_ROOT || 'shiftManager/main').set({
      data: snapshot,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: auth.currentUser?.email || 'unknown',
    }).then(() => {
      setIndicator('cloud');
    }).catch(err => {
      console.warn('[cloud] save failed', err);
      setIndicator('offline');
    });
  }

  // ---- UI ----
  const loginOverlay = document.getElementById('login-overlay');
  const userInfo = document.getElementById('user-info');
  const userName = document.getElementById('user-name');
  const indicator = document.getElementById('cloud-indicator');
  const loginError = document.getElementById('login-error');
  const btnSignin = document.getElementById('btn-google-signin');
  const btnSignout = document.getElementById('btn-signout');

  loginOverlay.classList.remove('hidden'); // show until auth completes

  btnSignin.addEventListener('click', () => {
    loginError.textContent = '';
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(err => {
      console.error('[cloud] signin failed', err);
      loginError.textContent = 'ログイン失敗: ' + err.message;
    });
  });

  btnSignout.addEventListener('click', () => {
    auth.signOut();
  });

  function setIndicator(state) {
    indicator.classList.remove('hidden', 'syncing', 'offline');
    if (state === 'cloud') { indicator.textContent = '☁️ 同期中'; }
    else if (state === 'syncing') { indicator.textContent = '⏳ 保存中…'; indicator.classList.add('syncing'); }
    else if (state === 'offline') { indicator.textContent = '⚠️ オフライン'; indicator.classList.add('offline'); }
  }

  // ---- Auth state listener ----
  let unsubscribeSnapshot = null;

  auth.onAuthStateChanged((user) => {
    if (!user) {
      // Not signed in
      loginOverlay.classList.remove('hidden');
      userInfo.classList.add('hidden');
      indicator.classList.add('hidden');
      if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
      return;
    }

    // Domain restriction
    const allowedDomain = window.ALLOWED_DOMAIN;
    if (allowedDomain) {
      const email = user.email || '';
      const domain = email.split('@')[1];
      if (domain !== allowedDomain) {
        loginError.textContent = `${allowedDomain} のアカウントでログインしてください (${email})`;
        auth.signOut();
        return;
      }
    }

    // Signed in OK
    loginOverlay.classList.add('hidden');
    userInfo.classList.remove('hidden');
    userName.textContent = user.displayName || user.email || 'ユーザー';
    setIndicator('cloud');

    // Subscribe to Firestore document
    const docPath = window.FIRESTORE_ROOT || 'shiftManager/main';
    unsubscribeSnapshot = db.doc(docPath).onSnapshot(snap => {
      if (snap.exists) {
        const remote = snap.data().data;
        if (suppressNextRemoteApply) {
          suppressNextRemoteApply = false;
          // Still ensure init has happened on first snapshot
          if (!window._shiftAppInitialized) {
            window._shiftAppInitialized = true;
            window.ShiftApp.init({ skipLoad: true });
          }
        } else if (remote) {
          if (!window._shiftAppInitialized) {
            // First snapshot: apply remote then init (skip local load)
            Object.assign(window.ShiftApp.state, remote);
            window._shiftAppInitialized = true;
            window.ShiftApp.init({ skipLoad: true });
          } else {
            // Subsequent snapshots from other clients: apply + re-render
            window.applyRemoteState(remote);
          }
        }
      } else {
        // No cloud state yet — initialize from defaults + push up
        if (!window._shiftAppInitialized) {
          window._shiftAppInitialized = true;
          window.ShiftApp.init(); // normal init (seeds if no local)
        }
        // First push to cloud
        setTimeout(() => {
          if (window.ShiftApp?.state) window.ShiftApp.saveOverride(window.ShiftApp.state);
        }, 100);
      }
    }, err => {
      console.error('[cloud] snapshot error', err);
      setIndicator('offline');
    });
  });

  // Track online/offline (rough indicator)
  window.addEventListener('online', () => { if (auth.currentUser) setIndicator('cloud'); });
  window.addEventListener('offline', () => setIndicator('offline'));
})();
