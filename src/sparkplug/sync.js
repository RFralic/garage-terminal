// Spark Plug Finder: "My plugs" in your account, so the list is the same on every device.
// Loaded after the page is up (the finder itself needs no sign-in and works offline).
// Stored at logbook/{uid}/trackerSettings/plugs = { list: [{ p, note, at }], updatedAt }
// (the owner-only settings area the Logbook and Job_Board already use; no rules change).
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '../lib/firebase.js';
import { finishRedirectSignIn, signInWithGoogle } from '../lib/session.js';

export const signIn = () => signInWithGoogle();

let ref = null;
let stopSnap = () => {};

/** Watch sign-in; while signed in, onList(list) gets the account's list (and live changes). */
export function start(onList, onUser) {
  finishRedirectSignIn().catch(() => {}); // back from a phone's sign-in page
  onAuthStateChanged(auth, (u) => {
    stopSnap(); ref = u ? doc(db, 'logbook', u.uid, 'trackerSettings', 'plugs') : null;
    onUser(!!u);
    if (!ref) return;
    stopSnap = onSnapshot(ref, (s) => onList(s.exists() ? (Array.isArray(s.data().list) ? s.data().list : []) : null), () => {});
  });
}

/** Save the whole list to the account (no-op when signed out). */
export async function save(list) {
  if (!ref) return false;
  await setDoc(ref, { list: list.map(({ p, note, at }) => ({ p, note: note || '', at: at || '' })), updatedAt: new Date().toISOString() });
  return true;
}
