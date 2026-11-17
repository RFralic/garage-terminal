// data.js: boards, threads, posts, files and "last visit" marks for the BBS.
// firestore.rules / storage.rules decide what's allowed; this just reads and writes.

import {
  collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp,
  setDoc, updateDoc, where, writeBatch, Timestamp,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref as sref, uploadBytesResumable } from 'firebase/storage';
import { db, storage } from '../lib/firebase.js';
import { shrinkPhoto } from '../lib/photo.js';

const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const newId = () => doc(collection(db, 'bbsThreads')).id;
const ms = (ts) => (ts?.toMillis ? ts.toMillis() : 0);

// ---------- boards ----------------------------------------------------------------------

export const watchBoards = (cb, onError) =>
  onSnapshot(collection(db, 'bbsBoards'), (s) => cb(rows(s).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))), onError);
export const boardNo = (b) => `#${String(b.order).padStart(2, '0')}`;

// ---------- threads -----------------------------------------------------------------------

/** Recent threads across the BBS (for the home grid's latest line and NEW counts). */
export const watchRecentThreads = (cb, onError) =>
  onSnapshot(query(collection(db, 'bbsThreads'), orderBy('lastAt', 'desc'), limit(200)), (s) => cb(rows(s)), onError);
export const watchBoardThreads = (boardId, cb, onError) =>
  onSnapshot(query(collection(db, 'bbsThreads'), where('boardId', '==', boardId), orderBy('lastAt', 'desc'), limit(200)), (s) => cb(rows(s)), onError);
export const watchThread = (id, cb, onError) =>
  onSnapshot(doc(db, 'bbsThreads', id), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null), onError);
export const watchPosts = (threadId, cb, onError) =>
  onSnapshot(query(collection(db, 'bbsThreads', threadId, 'posts'), orderBy('createdAt', 'asc')), (s) => cb(rows(s)), onError);

/** Upload a shrunk photo to bbs/posts/{uid}/… and return { path, w, h }. */
export async function uploadPostPhoto(uid, file, onProgress) {
  const { blob, w, h } = await shrinkPhoto(file);
  const path = `bbs/posts/${uid}/${newId()}.jpg`;
  await put(path, blob, 'image/jpeg', onProgress);
  return { path, w, h };
}

function put(path, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(sref(storage, path), blob, { contentType });
    task.on('state_changed', (s) => onProgress?.(s.bytesTransferred / s.totalBytes), reject, resolve);
  });
}

/**
 * New thread + its opening post, in one write. `extra` lets Shop Talk saves add
 * `saved` details. Returns the thread id.
 */
export async function createThread({ uid, handle, boardId, title, body, photo, saved }) {
  const id = newId();
  const b = writeBatch(db);
  b.set(doc(db, 'bbsThreads', id), {
    boardId, title, authorUid: uid, authorHandle: handle, createdAt: serverTimestamp(), lastAt: serverTimestamp(),
    lastBy: handle, replyCount: 0, pinned: false, locked: false, ...(saved ? { saved: true } : {}),
  });
  b.set(doc(db, 'bbsThreads', id, 'posts', 'op'), {
    authorUid: uid, authorHandle: handle, body, createdAt: serverTimestamp(), ...(photo ? { photo } : {}), ...(saved ? { saved } : {}),
  });
  await b.commit();
  return id;
}

export const addReply = ({ uid, handle, threadId, body, photo }) =>
  setDoc(doc(collection(db, 'bbsThreads', threadId, 'posts')), {
    authorUid: uid, authorHandle: handle, body, createdAt: serverTimestamp(), ...(photo ? { photo } : {}),
  });
export const editPost = (threadId, postId, body) => updateDoc(doc(db, 'bbsThreads', threadId, 'posts', postId), { body, editedAt: serverTimestamp() });
export const deletePost = (threadId, postId) => deleteDoc(doc(db, 'bbsThreads', threadId, 'posts', postId));
export const deleteThread = (threadId) => deleteDoc(doc(db, 'bbsThreads', threadId));
export const setThreadFlags = (threadId, flags) => updateDoc(doc(db, 'bbsThreads', threadId), flags);

const urlCache = new Map();
/** A download address for a BBS upload (cached for the visit). */
export function fileUrl(path) {
  if (!urlCache.has(path)) urlCache.set(path, getDownloadURL(sref(storage, path)).catch((e) => { urlCache.delete(path); throw e; }));
  return urlCache.get(path);
}

// ---------- last visits ("N NEW") ------------------------------------------------------------

let reads = null;
export async function getReads(uid) {
  if (!reads) reads = (await getDoc(doc(db, 'bbsReads', uid)).catch(() => null))?.data() ?? {};
  return reads;
}
/** Remember "I've seen this board (or the file cabinet) now". */
export async function markRead(uid, what) {
  const r = await getReads(uid);
  const now = Timestamp.now();
  // 'files' and 'chat' are single marks; anything else is a board id.
  const single = what === 'files' || what === 'chat';
  if (single) r[what] = now;
  else r.boards = { ...(r.boards || {}), [what]: now };
  await setDoc(doc(db, 'bbsReads', uid), single ? { [what]: serverTimestamp() } : { boards: { [what]: serverTimestamp() } }, { merge: true }).catch(() => {});
}
/** Threads with activity after my last visit to their board. */
export const isNewThread = (t, r, handle) => ms(t.lastAt) > ms(r?.boards?.[t.boardId]) && t.lastBy !== handle;

// ---------- the file cabinet -------------------------------------------------------------------

export const CABINET_TYPES = {
  pdf: ['PDF', 'application/pdf'], jpg: ['IMG', 'image/jpeg'], jpeg: ['IMG', 'image/jpeg'], png: ['IMG', 'image/png'], gif: ['IMG', 'image/gif'],
  webp: ['IMG', 'image/webp'], heic: ['IMG', 'image/heic'], zip: ['ZIP', 'application/zip'], txt: ['TXT', 'text/plain'], csv: ['CSV', 'text/csv'],
  md: ['TXT', 'text/markdown'], rtf: ['DOC', 'application/rtf'], doc: ['DOC', 'application/msword'],
  docx: ['DOC', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['XLS', 'application/vnd.ms-excel'], xlsx: ['XLS', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['PPT', 'application/vnd.ms-powerpoint'], pptx: ['PPT', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  odt: ['DOC', 'application/vnd.oasis.opendocument.text'], ods: ['XLS', 'application/vnd.oasis.opendocument.spreadsheet'],
};
export const MAX_FILE = 25 * 1024 * 1024;
export const fileKind = (name) => CABINET_TYPES[String(name).toLowerCase().split('.').pop()] || null;
export const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const watchFiles = (cb, onError) =>
  onSnapshot(query(collection(db, 'bbsFiles'), orderBy('createdAt', 'desc'), limit(300)), (s) => cb(rows(s)), onError);

/** Upload to bbs/files/{uid}/{id}/{name}, then list it. */
export async function addFile({ uid, handle, file, title, note, onProgress }) {
  const kind = fileKind(file.name);
  if (!kind) throw new Error('That type of file isn’t allowed. PDF, photos, ZIP, text and office documents only.');
  if (file.size > MAX_FILE) throw new Error('That file is over 25 MB.');
  const id = doc(collection(db, 'bbsFiles')).id;
  const name = file.name.replace(/[/\\]/g, '_').slice(-200);
  const path = `bbs/files/${uid}/${id}/${name}`;
  await put(path, file, kind[1], onProgress);
  try {
    await setDoc(doc(db, 'bbsFiles', id), {
      title, titleLower: title.toLowerCase(), note, name, type: kind[0], size: file.size, contentType: kind[1], path,
      byUid: uid, byHandle: handle, createdAt: serverTimestamp(),
    });
  } catch (err) {
    await deleteObject(sref(storage, path)).catch(() => {});
    throw err;
  }
  return id;
}
export const deleteFile = (id) => deleteDoc(doc(db, 'bbsFiles', id));

// ---------- Shop Talk ---------------------------------------------------------------------------

export const watchChat = (n, cb, onError) =>
  onSnapshot(query(collection(db, 'bbsChat'), orderBy('createdAt', 'desc'), limit(n)), (s) => cb(rows(s).reverse(), s.size), onError);

/** Send a message. `photoFile` is shrunk and uploaded to bbs/chat/{uid}/ first. */
export async function sendChat({ uid, handle, text, photoFile, reply, onProgress }) {
  const ref = doc(collection(db, 'bbsChat'));
  let photo = null;
  if (photoFile) {
    const { blob, w, h } = await shrinkPhoto(photoFile, 1280);
    photo = { path: `bbs/chat/${uid}/${ref.id}.jpg`, w, h };
    await put(photo.path, blob, 'image/jpeg', onProgress);
  }
  const link = (text.match(/https?:\/\/[^\s<>"]+/i) || [])[0];
  await setDoc(ref, {
    uid, handle, kind: 'msg', text, createdAt: serverTimestamp(),
    ...(photo ? { photo } : {}), ...(link ? { link: link.slice(0, 500) } : {}), ...(reply ? { reply } : {}),
  });
}
/** "[handle] walked into the shop" */
export const sayJoined = (uid, handle) => setDoc(doc(collection(db, 'bbsChat')), { uid, handle, kind: 'join', text: '', createdAt: serverTimestamp() });
export const deleteChat = (id) => deleteDoc(doc(db, 'bbsChat', id));
export const setTyping = (uid, handle) => setDoc(doc(db, 'bbsTyping', uid), { handle, at: serverTimestamp() }).catch(() => {});
export const watchTyping = (cb, onError) => onSnapshot(collection(db, 'bbsTyping'), cb, onError);
