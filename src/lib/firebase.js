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
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

const isLocal = import.meta.env.DEV;

async function loadConfig() {
  if (isLocal) {
    return { apiKey: 'demo-key', projectId: 'demo-garage-terminal', authDomain: location.host };
  }
  const res = await fetch('/__/firebase/init.json');
  if (!res.ok) throw new Error('Could not load Firebase config');
  const config = await res.json();
  config.authDomain = location.host;
  return config;
}

const app = initializeApp(await loadConfig());

export const auth = getAuth(app);
export const db = getFirestore(app);

if (isLocal) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8080);
}
