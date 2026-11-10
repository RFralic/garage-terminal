// session.js: who is reading the site right now.
//
// watchSession(callback) calls back whenever sign-in state or the member's
// profile changes, with one of:
//   { state: 'loading' }
//   { state: 'guest' }                         not signed in
//   { state: 'needs-handle', user }            signed in with Google, no handle yet
//   { state: 'member', user, profile, isSysop } signed in with a handle
//
// `profile` is the public users/{uid} doc: { handle, status, postCount, createdAt }.
// Pages should show `profile.handle`, never `user.email`.

import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { auth, db } from './firebase.js';

// ---------- handle rules (the same rules are enforced in firestore.rules) ----

export const HANDLE_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
export const RESERVED_HANDLES = ['sysop', 'admin', 'moderator', 'garage', 'terminal'];

/** Returns an error message for a bad handle, or '' if it's well-formed. */
export function handleProblem(handle) {
  if (handle.length < 3) return 'At least 3 characters.';
  if (handle.length > 20) return 'At most 20 characters.';
  if (!HANDLE_PATTERN.test(handle)) return 'Letters, numbers and underscores only.';
  if (RESERVED_HANDLES.includes(handle.toLowerCase())) return 'That handle is reserved.';
  return '';
}

/** True if nobody has claimed this handle yet (ignores capitals). */
export async function isHandleFree(handle) {
  const snap = await getDoc(doc(db, 'handles', handle.toLowerCase()));
  return !snap.exists();
}

/**
 * Claims a handle for the signed-in member. Writes three docs together:
 *   users/{uid}      public profile
 *   handles/{lower}  reservation, so nobody else can take it
 *   private/{uid}    email, readable only by the sysop
 * Throws Error('taken') if someone got there first.
 */
export async function claimHandle(handle) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');

  const handleRef = doc(db, 'handles', handle.toLowerCase());
  await runTransaction(db, async (tx) => {
    if ((await tx.get(handleRef)).exists()) throw new Error('taken');
    tx.set(handleRef, { uid: user.uid });
    tx.set(doc(db, 'users', user.uid), {
      handle,
      createdAt: serverTimestamp(),
      status: 'active',
      postCount: 0,
    });
    tx.set(doc(db, 'private', user.uid), { email: user.email });
  });
}

// ---------- sign in / out ----------------------------------------------------

// Phones and tablets use a full-page redirect to Google (pop-ups are unreliable
// there); desktops use a pop-up so the page doesn't reload.
// When the site runs as an installed app (opened from the home screen, see
// public/manifest.webmanifest), pop-ups open outside the app and sign-in can't
// finish, so installed apps always use the redirect too. Google's page opens
// inside the app and returns to /join on this site.
const usesTouch = window.matchMedia('(pointer: coarse)').matches;
const isInstalledApp = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; // (iOS)

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  if (usesTouch || isInstalledApp()) {
    await signInWithRedirect(auth, provider);
  } else {
    await signInWithPopup(auth, provider);
  }
}

/** Call once on page load to finish a phone redirect sign-in (and surface errors). */
export function finishRedirectSignIn() {
  return getRedirectResult(auth);
}

export function logOff() {
  return signOut(auth);
}

// ---------- watching the session ---------------------------------------------
// One shared listener for the whole page; any number of parts of the page can
// subscribe with watchSession() and get the latest state straight away.

const listeners = new Set();
let current = { state: 'loading' };
let started = false;

function publish(next) {
  current = next;
  for (const cb of listeners) cb(current);
}

function start() {
  started = true;
  let stopProfile = () => {};

  onAuthStateChanged(auth, async (user) => {
    stopProfile();
    if (!user) {
      publish({ state: 'guest' });
      return;
    }

    // Sysop check: allowed to read only our own admins/{uid} doc.
    let isSysop = false;
    try {
      isSysop = (await getDoc(doc(db, 'admins', user.uid))).exists();
    } catch {
      isSysop = false;
    }

    // Live-follow the profile so claiming a handle (or a new post count)
    // updates every part of the page.
    stopProfile = onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        if (snap.exists()) {
          publish({ state: 'member', user, profile: snap.data(), isSysop });
        } else {
          publish({ state: 'needs-handle', user });
        }
      },
      () => publish({ state: 'needs-handle', user }),
    );
  });
}

/** Subscribe to session changes. Returns an unsubscribe function. */
export function watchSession(callback) {
  listeners.add(callback);
  callback(current);
  if (!started) start();
  return () => listeners.delete(callback);
}

/** The latest session state, without subscribing. */
export function currentSession() {
  return current;
}

/** True if this session may post (signed in, has a handle, status active). */
export function canPost(s = current) {
  return s.state === 'member' && s.profile.status === 'active';
}

/**
 * Where to send someone after they join. Only same-site paths are allowed,
 * so a crafted link can't bounce people to another website.
 */
export function safeNextPath(raw) {
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) {
    return raw;
  }
  return '/';
}
