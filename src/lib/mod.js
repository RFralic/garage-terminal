// mod.js: sysop-only helpers.
//
//   moderate(action, params)  calls the `moderate` Cloud Function, which checks
//                             the caller is sysop, makes the change and logs it.
//   load*() / count*()        read data for the /mod dashboard. The Firestore
//                             rules only let the sysop read these.

import { httpsCallable } from 'firebase/functions';
import {
  collection, collectionGroup, doc, documentId, getCountFromServer, getDoc, getDocs,
  limit, orderBy, query, Timestamp, where,
} from 'firebase/firestore';
import { db, functions } from './firebase.js';

const callModerate = httpsCallable(functions, 'moderate');

/** Run a moderation action. Throws an Error with a readable message on failure. */
export async function moderate(action, params = {}) {
  try {
    const res = await callModerate({ action, ...params });
    return res.data;
  } catch (err) {
    // Functions errors carry the message the function threw (e.g. "That handle is taken").
    throw new Error(err?.message?.replace(/^.*?: /, '') || 'That didn’t work. Try again.');
  }
}

/** Ask for a reason (optional) with the browser's prompt. Returns null if cancelled. */
export function askReason(label) {
  const answer = window.prompt(`${label}\nReason (optional, shown in the mod log):`, '');
  return answer === null ? null : answer.trim().slice(0, 300);
}

// ---------- dashboard counts ---------------------------------------------------

const countOf = async (q) => (await getCountFromServer(q)).data().count;

export async function loadCounts() {
  const weekAgo = Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const [openReports, newMembers, postsToday] = await Promise.all([
    countOf(query(collection(db, 'reports'), where('status', '==', 'open'))),
    countOf(query(collection(db, 'users'), where('createdAt', '>=', weekAgo))),
    countOf(query(collectionGroup(db, 'posts'), where('createdAt', '>=', Timestamp.fromDate(midnight)))),
  ]);
  return { openReports, newMembers, postsToday };
}

// ---------- reports & held items -------------------------------------------------

/** Open reports, newest first, each with the reported post (if it still exists). */
export async function loadOpenReports() {
  const snap = await getDocs(query(collection(db, 'reports'), where('status', '==', 'open'), orderBy('createdAt', 'desc'), limit(50)));
  return Promise.all(snap.docs.map(async (d) => {
    const r = { id: d.id, ...d.data() };
    const post = await getDoc(doc(db, 'threads', r.threadId, 'posts', r.postId));
    r.post = post.exists() ? { id: post.id, ...post.data() } : null;
    return r;
  }));
}

/** Threads and replies the word filter is holding for review. */
export async function loadHeld() {
  const [threads, posts] = await Promise.all([
    getDocs(query(collection(db, 'threads'), where('held', '==', true), limit(50))),
    getDocs(query(collectionGroup(db, 'posts'), where('held', '==', true), limit(50))),
  ]);
  const heldThreads = await Promise.all(threads.docs.map(async (t) => {
    const op = await getDoc(doc(db, 'threads', t.id, 'posts', 'op'));
    return { kind: 'thread', id: t.id, threadId: t.id, ...t.data(), body: op.data()?.body ?? '' };
  }));
  const heldPosts = posts.docs.map((p) => ({ kind: 'post', id: p.id, threadId: p.ref.parent.parent.id, ...p.data() }));
  return [...heldThreads, ...heldPosts];
}

// ---------- members ----------------------------------------------------------------

/** Newest members first. */
export async function loadRecentMembers() {
  const snap = await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(20)));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

/** Members whose handle starts with `text` (ignores capitals). */
export async function searchMembers(text) {
  const prefix = text.trim().toLowerCase();
  if (!prefix) return loadRecentMembers();
  const handles = await getDocs(query(
    collection(db, 'handles'),
    where(documentId(), '>=', prefix),
    where(documentId(), '<', prefix + ''),
    limit(20),
  ));
  const users = await Promise.all(handles.docs.map((h) => getDoc(doc(db, 'users', h.data().uid))));
  return users.filter((u) => u.exists()).map((u) => ({ uid: u.id, ...u.data() }));
}

/** One member: public profile, private info (email, ban reason) and recent posts. */
export async function loadMember(uid) {
  const [user, priv, posts] = await Promise.all([
    getDoc(doc(db, 'users', uid)),
    getDoc(doc(db, 'private', uid)),
    getDocs(query(collectionGroup(db, 'posts'), where('authorUid', '==', uid), orderBy('createdAt', 'desc'), limit(25))),
  ]);
  if (!user.exists()) return null;
  return {
    uid,
    ...user.data(),
    email: priv.data()?.email ?? '',
    bannedReason: priv.data()?.bannedReason ?? '',
    posts: posts.docs.map((p) => ({ id: p.id, threadId: p.ref.parent.parent.id, ...p.data() })),
  };
}

// ---------- mod log --------------------------------------------------------------------

export async function loadModLog() {
  const snap = await getDocs(query(collection(db, 'modlog'), orderBy('createdAt', 'desc'), limit(100)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
