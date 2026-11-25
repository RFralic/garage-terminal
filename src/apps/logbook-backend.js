// logbook-backend.js: gives the Engine & Vehicle Logbook (apps/logbook) and the
// Job_Board (apps/job-board, was the Project Tracker) their sign-in and storage on this site.
//
// Both pages were first built for their own Firebase project. They wait for
// window.fbReady, which this module fills with the same small API they had
// there, now backed by this site's Google sign-in and Firestore:
//
//   onAuth(cb), signIn(), signInRedirect(), signOut()
//   records(uid)   Logbook: engines, vehicles and parts
//                  -> Firestore logbook/{uid}/records/{recordId}
//   receipts(uid)  Logbook: receipt photos / PDFs on parts, one per doc,
//                  read only when opened or printed
//                  -> Firestore logbook/{uid}/receipts/{receiptId}
//   forUser(uid)   Project Tracker:
//                    projects/{id}  -> logbook/{uid}/projects/{id}
//                    settings/{x}   -> logbook/{uid}/trackerSettings/{x}  (counter, shop)
//                    records        -> logbook/{uid}/records (inventory check)
//                    shop/info      -> shops/{owner}: the team, for Assigned to / Done by
//
// Only the member can read or write their own records (see the LOGBOOK section
// of firestore.rules). The pages turn on the offline cache
// (window.__gtOfflineCache) so they keep working without a signal.

import { onAuthStateChanged, signOut, signInWithRedirect, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { auth, db, isPreviewSite } from '../lib/firebase.js';
import { finishRedirectSignIn, signInWithGoogle, watchSession } from '../lib/session.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const safeId = (id) => {
  const s = String(id);
  if (!ID.test(s)) throw new Error('Unsupported record id');
  return s;
};

// ---------- status line at the top of the page --------------------------------

function status(text, state = 'wait') {
  const el = document.getElementById('gtSync');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

watchSession((s) => {
  if (s.state === 'member') status(`Signed in as ${s.profile.handle}`, 'ok');
  else if (s.state === 'needs-handle') status('Signed in', 'ok');
  else status('');
});

// ---------- storage -------------------------------------------------------------

// Shop app, signed in as an employee of someone else's shop: the shop app (/shop) saves
// {member, owner} in localStorage gt-shop-of, and these pages, when opened inside it (?shop=1),
// open the owner's data instead of the member's own. firestore.rules decide what the member may
// do (shops/{owner}/members). Opened on their own, the Logbook and Job_Board stay the member's own.
const SHOP_OF = (() => {
  try {
    if (new URLSearchParams(location.search).get('shop') !== '1') return null;
    const v = JSON.parse(localStorage.getItem('gt-shop-of') || 'null');
    return v && typeof v.member === 'string' && typeof v.owner === 'string' && ID.test(v.owner) ? v : null;
  } catch { return null; }
})();
const dataUid = (uid) => (SHOP_OF && SHOP_OF.member === uid ? SHOP_OF.owner : uid);
const userCol = (uid, name) => collection(db, 'logbook', dataUid(uid), name);

/** Logbook: same shape as before, doc(id).set/delete and a live listener. */
function records(uid) {
  const col = userCol(uid, 'records');
  return {
    doc: (id) => ({
      set: (data) => setDoc(doc(col, safeId(id)), data),
      delete: () => deleteDoc(doc(col, safeId(id))),
    }),
    onSnapshot: (next, err) => onSnapshot(col, { includeMetadataChanges: true }, next, err),
  };
}

/** Logbook receipts: set(id, data), get(id) -> data or null, delete(id). */
function receipts(uid) {
  const col = userCol(uid, 'receipts');
  return {
    set: (id, data) => setDoc(doc(col, safeId(id)), data),
    get: async (id) => {
      const s = await getDoc(doc(col, safeId(id)));
      return s.exists() ? s.data() : null;
    },
    delete: (id) => deleteDoc(doc(col, safeId(id))),
  };
}

/** Project Tracker: db.doc(path), db.collection('projects'), db.records. */
function forUser(uid) {
  const snap = (s) => ({ id: s.id, exists: s.exists(), data: () => s.data() });
  const ref = (path) => {
    const [a, b, extra] = String(path).split('/');
    if (extra === undefined && b) {
      if (a === 'projects') return doc(userCol(uid, 'projects'), safeId(b));
      if (a === 'settings') return doc(userCol(uid, 'trackerSettings'), safeId(b));
      if (a === 'shop' && b === 'info') return doc(db, 'shops', dataUid(uid)); // the team (employees), read only
    }
    throw new Error('Unknown path ' + path);
  };
  const recs = userCol(uid, 'records');
  return {
    doc: (path) => ({
      set: (data) => setDoc(ref(path), data),
      delete: () => deleteDoc(ref(path)),
      onSnapshot: (next, err) => onSnapshot(ref(path), (s) => next(snap(s)), err),
    }),
    collection: (name) => {
      if (name !== 'projects') throw new Error('Unknown collection ' + name);
      return {
        onSnapshot: (next, err) =>
          onSnapshot(userCol(uid, 'projects'), (q) => next({ docs: q.docs.map(snap) }), err),
      };
    },
    records: {
      onSnapshot: (next, err) =>
        onSnapshot(recs, (q) => next(q.docs.map((d) => ({ id: d.id, ...d.data() }))), err),
      set: (id, data) => setDoc(doc(recs, safeId(id)), data),
      merge: (id, data) => setDoc(doc(recs, safeId(id)), data, { merge: true }),
    },
  };
}

// ---------- sign-in ---------------------------------------------------------------

// Finish a phone sign-in that redirected to Google and back to this page.
finishRedirectSignIn().catch((err) => console.error('Logbook: sign-in did not finish', err));

function signInRedirect() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  // previews: pop-up (see src/lib/firebase.js)
  return isPreviewSite ? signInWithPopup(auth, provider) : signInWithRedirect(auth, provider);
}

window.fbResolve({
  onAuth: (cb) => onAuthStateChanged(auth, cb),
  signIn: () => signInWithGoogle(), // pop-up on computers, full-page redirect on phones and the installed app
  signInRedirect,
  signOut: () => signOut(auth),
  records,
  receipts,
  forUser,
});
