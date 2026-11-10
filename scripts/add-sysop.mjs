// add-sysop.mjs: makes an existing member the sysop by creating admins/{uid}.
//
// Run from GitHub: Actions tab -> "Add sysop" -> Run workflow -> paste the User UID
// (from Firebase console -> Authentication -> Users).
//
// Uses the deploy service account (Admin SDK), which is the only way besides
// the Firebase console to write admins/*; the Firestore rules block it from the site.

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const uid = (process.argv[2] || '').trim();
if (!/^[A-Za-z0-9]{20,128}$/.test(uid)) {
  console.error('Usage: node scripts/add-sysop.mjs <User UID>');
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: 'garage-terminal-15499' });

// Make sure this is a real account before granting anything.
const user = await getAuth().getUser(uid); // throws if no such user
const db = getFirestore();
const profile = await db.doc(`users/${uid}`).get();
const handle = profile.exists ? profile.get('handle') : '(no handle yet)';

await db.doc(`admins/${uid}`).set({ addedAt: FieldValue.serverTimestamp() }, { merge: true });

// Print the handle only; never the email (workflow logs are public on a public repo).
console.log(`Done: ${handle} is now sysop. Account created ${user.metadata.creationTime}.`);
