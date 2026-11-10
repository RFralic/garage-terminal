// forum.js: every read and write the forum pages make, in one place.
//
// Data layout (see PLAN.md "Data model"):
//   areas/{areaId}                         [1] General ... [5] Off-Topic
//   threads/{threadId}                     title, area, author, counts, flags
//   threads/{threadId}/posts/op            the opening post
//   threads/{threadId}/posts/{postId}      replies
//   settings/site                          sysopNotice, forumOpen, bannedWords
//
// firestore.rules re-checks everything here; these functions just make the
// writes in the exact shape the rules expect.

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  deleteDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase.js';

export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const BODY_MAX = 10000;
export const POST_GAP_SECONDS = 20; // rate limit, enforced in firestore.rules
export const EDIT_WINDOW_MINUTES = 30; // edit window, enforced in firestore.rules
export const PAGE_SIZE = 50;

// ---------- areas & settings -------------------------------------------------

let areasCache;

/** All message areas, in order. Cached for the page's lifetime. */
export async function getAreas() {
  if (!areasCache) {
    const snap = await getDocs(query(collection(db, 'areas'), orderBy('order')));
    areasCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return areasCache;
}

/** settings/site, or defaults if it doesn't exist yet. */
export async function getSiteSettings() {
  const snap = await getDoc(doc(db, 'settings', 'site'));
  return { sysopNotice: '', forumOpen: true, bannedWords: [], ...(snap.exists() ? snap.data() : {}) };
}

// ---------- reading threads & posts ------------------------------------------

/**
 * One page of the thread list: pinned first, then latest reply first.
 * Pass the `cursor` from the previous page to get the next one.
 * Hidden threads are filtered out (the rules require it), except for the
 * sysop, who passes includeHidden to see them marked as hidden.
 */
export async function listThreads({ areaId = '', cursor = null, includeHidden = false } = {}) {
  const parts = includeHidden ? [] : [where('hidden', '==', false)];
  if (areaId) parts.push(where('areaId', '==', areaId));
  parts.push(orderBy('pinned', 'desc'), orderBy('lastReplyAt', 'desc'), limit(PAGE_SIZE));
  if (cursor) parts.push(startAfter(cursor));

  const snap = await getDocs(query(collection(db, 'threads'), ...parts));
  return {
    threads: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    cursor: snap.docs.length === PAGE_SIZE ? snap.docs[snap.docs.length - 1] : null,
  };
}

/** Live-follow one thread. Calls back with the thread, or null if missing/hidden. */
export function watchThread(threadId, callback) {
  return onSnapshot(
    doc(db, 'threads', threadId),
    (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data({ serverTimestamps: 'estimate' }) } : null),
    () => callback(null),
  );
}

/** Live-follow a thread's posts, oldest first. Hidden ones only for the sysop. */
export function watchPosts(threadId, callback, onError, { includeHidden = false } = {}) {
  const q = includeHidden
    ? query(collection(db, 'threads', threadId, 'posts'), orderBy('createdAt', 'asc'))
    : query(collection(db, 'threads', threadId, 'posts'), where('hidden', '==', false), orderBy('createdAt', 'asc'));
  return onSnapshot(
    q,
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))),
    onError,
  );
}

// ---------- writing ------------------------------------------------------------

/** Author fields the rules expect on every thread and post. */
function authorFields(session) {
  return {
    authorUid: session.user.uid,
    authorHandle: session.profile.handle,
    authorRole: session.isSysop ? 'sysop' : 'member',
  };
}

/** Every new thread or reply also stamps users/{uid}.lastPostAt (rate limit). */
function bumpLastPost(batch, session) {
  batch.update(doc(db, 'users', session.user.uid), { lastPostAt: serverTimestamp() });
}

/**
 * Word filter: true if the text contains one of the sysop's banned words
 * (whole words, ignoring capitals). Mirrors hasBannedWord() in firestore.rules,
 * which is what actually enforces it.
 */
export function hasBannedWord(text, bannedWords = []) {
  if (!bannedWords.length) return false;
  return new RegExp(`\\b(${bannedWords.join('|')})\\b`, 'i').test(text);
}

/** Fields that mark a new item as hidden and held for the sysop's review. */
const heldFields = (held) => (held ? { hidden: true, held: true } : { hidden: false });

/**
 * Start a thread. Returns { id, held }. If the title or message contains a
 * banned word, the thread is saved hidden and held for the sysop to review.
 */
export async function createThread(session, { areaId, title, body }) {
  const { bannedWords } = await getSiteSettings();
  const held = hasBannedWord(`${title} ${body}`, bannedWords);
  const threadRef = doc(collection(db, 'threads'));
  const batch = writeBatch(db);
  batch.set(threadRef, {
    areaId,
    title: title.trim(),
    ...authorFields(session),
    createdAt: serverTimestamp(),
    lastReplyAt: serverTimestamp(),
    replyCount: 0,
    pinned: false,
    locked: false,
    ...heldFields(held),
  });
  batch.set(doc(threadRef, 'posts', 'op'), {
    ...authorFields(session),
    body,
    createdAt: serverTimestamp(),
    hidden: false,
  });
  bumpLastPost(batch, session);
  await batch.commit();
  return { id: threadRef.id, held };
}

/** Reply to a thread. Returns { held } (true if the word filter held it). */
export async function createReply(session, threadId, body) {
  const { bannedWords } = await getSiteSettings();
  const held = hasBannedWord(body, bannedWords);
  const batch = writeBatch(db);
  batch.set(doc(collection(db, 'threads', threadId, 'posts')), {
    ...authorFields(session),
    body,
    createdAt: serverTimestamp(),
    ...heldFields(held),
  });
  bumpLastPost(batch, session);
  await batch.commit();
  return { held };
}

/** Report someone's post to the sysop. One report per member per post. */
export const REPORT_REASONS = [
  ['spam', 'Spam'],
  ['rude', 'Rude or abusive'],
  ['off-topic', 'Off-topic'],
  ['other', 'Something else'],
];
export function reportPost(session, threadId, postId, reason, note = '') {
  return setDoc(doc(db, 'reports', `${threadId}__${postId}__${session.user.uid}`), {
    threadId,
    postId,
    reporterUid: session.user.uid,
    reporterHandle: session.profile.handle,
    reason,
    note: note.trim().slice(0, 500),
    createdAt: serverTimestamp(),
    status: 'open',
  });
}

/** Edit your own post's text (within the edit window). */
export function editPost(threadId, postId, body) {
  return updateDoc(doc(db, 'threads', threadId, 'posts', postId), { body, editedAt: serverTimestamp() });
}

/** Delete your own reply. */
export function deletePost(threadId, postId) {
  return deleteDoc(doc(db, 'threads', threadId, 'posts', postId));
}

// ---------- helpers for the pages --------------------------------------------

/** Seconds until this member may post again (0 = now). */
export function secondsUntilCanPost(session) {
  const last = session?.profile?.lastPostAt?.toMillis?.();
  if (!last) return 0;
  return Math.max(0, Math.ceil((last + POST_GAP_SECONDS * 1000 - Date.now()) / 1000));
}

/** True while a post is still inside its edit window. */
export function canStillEdit(post) {
  const created = post.createdAt?.toMillis?.();
  return !!created && Date.now() < created + EDIT_WINDOW_MINUTES * 60 * 1000;
}

/** Turn a failed write into a message a person can act on. */
export function postErrorMessage(err, session) {
  if (err?.code === 'permission-denied') {
    const wait = secondsUntilCanPost(session);
    if (wait > 0) return `Slow down: you can post again in ${wait}s.`;
    if (session?.profile?.status && session.profile.status !== 'active') {
      return 'Your account can’t post right now.';
    }
    return 'That wasn’t allowed. The forum or thread may be closed, the edit window may have passed, or the text contains a filtered word.';
  }
  if (err?.code === 'unavailable') return 'You seem to be offline. Try again.';
  return 'Something went wrong. Try again.';
}
