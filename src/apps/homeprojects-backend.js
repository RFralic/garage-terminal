// homeprojects-backend.js: gives Home Projects (apps/home-projects) its storage
// on this site.
//
// The app was built on claude.ai, where it asks for storage through
// window.claude.use("db" | "user" | "assets"). The page defines a small
// window.claude stand-in that waits for this module; here those three are
// provided with the site's own Google sign-in, Firestore and Storage:
//
//   use("user")    -> the signed-in member's id (null for guests)
//   use("db")      -> their projects: Firestore homeprojects/{uid}/projects/{projectId}
//                     (null for guests, so the app keeps projects in this browser)
//   use("assets")  -> their photos: Storage homeprojects/{uid}/photos/{photoId}
//
// Only the member can read or write their own projects and photos (see the
// HOME PROJECTS sections of firestore.rules and storage.rules).
//
// Projects made on this device before signing in (kept in the browser under
// "hp-local") are added to the account the first time someone signs in here.

import { collection, deleteDoc, doc, getDocs, onSnapshot, setDoc } from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { db, storage } from '../lib/firebase.js';
import { watchSession } from '../lib/session.js';

const LOCAL_KEY = 'hp-local';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------- status line at the top of the page --------------------------------

function status(text, state = 'wait', link = null) {
  const el = document.getElementById('gtSync');
  if (!el) return;
  el.dataset.state = state;
  el.replaceChildren(text);
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    el.append(' ', a);
  }
}

// ---------- photos ----------------------------------------------------------------
// The app shows photos with <img data-gtphoto="{id}">. Their addresses are
// looked up once (the Storage rules are checked then) and filled in.

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const photoUrls = new Map(); // id -> url | Promise
let photoUid = null;

function photoRef(uid, id) {
  return ref(storage, `homeprojects/${uid}/photos/${id}`);
}

/** Used by the page when drawing a photo: returns its address if known, else a blank. */
window.__gtPhoto = (id) => {
  const known = photoUrls.get(id);
  if (typeof known === 'string') return known;
  if (!known && photoUid && ID.test(String(id))) {
    photoUrls.set(id, getDownloadURL(photoRef(photoUid, id)).then((url) => {
      photoUrls.set(id, url);
      document.querySelectorAll(`img[data-gtphoto="${CSS.escape(String(id))}"]`).forEach((img) => { img.src = url; });
      return url;
    }).catch(() => { photoUrls.delete(id); }));
  }
  return BLANK;
};

function assetsFor(uid) {
  return {
    async upload(blob) {
      if (!blob || !/^image\//.test(blob.type || 'image/jpeg')) {
        throw Object.assign(new Error('unsupported'), { code: 'unsupported_type' });
      }
      const id = newId();
      await uploadBytes(photoRef(uid, id), blob, { contentType: blob.type || 'image/jpeg' });
      return { id };
    },
    async delete(id) {
      if (!ID.test(String(id))) return;
      photoUrls.delete(id);
      try { await deleteObject(photoRef(uid, id)); } catch (err) {
        if (err.code !== 'storage/object-not-found') throw err;
      }
    },
  };
}

// ---------- projects ----------------------------------------------------------------
// Same shape the app uses on claude.ai: collection(...).doc(id).set/delete and
// onSnapshot(snap => snap.docs[i].id / .data()).

function projectsFor(uid) {
  const col = collection(db, 'homeprojects', uid, 'projects');
  return {
    doc: (id) => ({
      set: (data) => setDoc(doc(col, String(id)), data),
      delete: () => deleteDoc(doc(col, String(id))),
    }),
    onSnapshot: (next, error) => onSnapshot(col, (snap) => next({ docs: snap.docs.map((d) => ({ id: d.id, data: () => d.data() })) }), error),
  };
}

/** First sign-in on a device: add projects kept in this browser to the account. */
async function moveLocalProjects(uid) {
  let local = [];
  try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { local = []; }
  if (!Array.isArray(local) || !local.length) return 0;
  const col = collection(db, 'homeprojects', uid, 'projects');
  const existing = new Set((await getDocs(col)).docs.map((d) => d.id));
  let moved = 0;
  for (const p of local) {
    if (!p || !ID.test(String(p.id)) || existing.has(String(p.id))) continue;
    const { id, ...data } = p;
    await setDoc(doc(col, String(id)), JSON.parse(JSON.stringify(data)));
    moved++;
  }
  try { localStorage.removeItem(LOCAL_KEY); } catch { /* storage unavailable */ }
  return moved;
}

// ---------- hand the app its storage once we know who's here --------------------------

let handled = false;
watchSession(async (s) => {
  if (s.state === 'loading' || handled) return;
  handled = true;

  if (s.state === 'guest') {
    status('Saved in this browser.', 'wait', { href: '/join?next=%2Fapps%2Fhome-projects', label: 'Sign in to sync' });
    window.__gtReady({ use: async () => null });
    return;
  }

  const uid = s.user.uid;
  photoUid = uid;
  status('Syncing…');
  let moved = 0;
  try { moved = await moveLocalProjects(uid); } catch (err) { console.error('Home Projects: could not move local projects', err); }
  window.__gtReady({
    use: async (name) => {
      if (name === 'user') return { id: async () => uid };
      if (name === 'db') return { collection: () => projectsFor(uid) };
      if (name === 'assets') return assetsFor(uid);
      return null;
    },
  });
  const who = s.state === 'member' ? s.profile.handle : 'your account';
  status(moved ? `Synced to ${who} · added ${moved} project${moved === 1 ? '' : 's'} from this browser` : `Synced to ${who}`, 'ok');
});
