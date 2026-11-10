// firebase.js: starts Firebase once and hands out `auth` and `db` to every page.
//
// Where the config comes from:
//  - On the live site (Firebase Hosting), from /__/firebase/init.json, which
//    Hosting serves automatically for this project. Nothing to paste or keep in sync.
//  - In local development (`npm run dev`), a fake "demo" project that talks to the
//    Firebase emulators on this computer, so testing never touches real data.
//
// authDomain is set to the site's own address. Phones finish Google sign-in by
// redirecting back to {site}/__/auth/handler, and iPhone Safari only allows that
// when it's the same address as the page. (That address must be listed under
// "Authorized redirect URIs" on the OAuth client in Google Cloud Console.)

import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { getStorage, connectStorageEmulator } from 'firebase/storage';

const isLocal = import.meta.env.DEV;

// Bot protection (App Check): proves requests come from this website, using a
// reCAPTCHA v3 *site* key. The site key is public by design (every browser gets
// it). The matching *secret* key lives only in the Firebase console.
// Empty = App Check switched off. Enforcement is turned on in the Firebase
// console (App Check -> APIs) once real visits show as verified.
const APP_CHECK_SITE_KEY = '';

async function loadConfig() {
  if (isLocal) {
    return {
      apiKey: 'demo-key',
      projectId: 'demo-garage-terminal',
      authDomain: location.host,
      storageBucket: 'demo-garage-terminal.appspot.com',
    };
  }
  const res = await fetch('/__/firebase/init.json');
  if (!res.ok) throw new Error('Could not load Firebase config');
  const config = await res.json();
  config.authDomain = location.host;
  return config;
}

const app = initializeApp(await loadConfig());

// Must start before the database or storage are used.
if (!isLocal && APP_CHECK_SITE_KEY) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);
export const db = getFirestore(app);
// Cloud Functions live in us-east1 (same as the database); see functions/index.js.
export const functions = getFunctions(app, 'us-east1');
// Library files (PDFs, ebooks...). Access is controlled by storage.rules.
export const storage = getStorage(app);

if (isLocal) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8080);
  connectFunctionsEmulator(functions, 'localhost', 5001);
  connectStorageEmulator(storage, 'localhost', 9199);
}
