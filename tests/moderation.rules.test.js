// Moderation rules tests: forum switch, word filter, reports, mod log, and the
// sysop-only reads the /mod dashboard needs. Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, collection, collectionGroup, query, where, setDoc, updateDoc,
  writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { startEnv, guestOf, asOf, seed as seedRaw, seedMember as seedMemberRaw } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());

const guest = () => guestOf(env)();
const as = (...a) => asOf(env)(...a);
const seed = (fn) => seedRaw(env, fn);
const seedMember = (...a) => seedMemberRaw(env, ...a);
const longAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);

function reply(db, uid, handle, { threadId = 't1', postId = 'r-new', body = 'Nice one', role = 'member', post = {} } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'threads', threadId, 'posts', postId), {
    authorUid: uid, authorHandle: handle, authorRole: role, body, createdAt: serverTimestamp(), hidden: false, ...post,
  });
  b.update(doc(db, 'users', uid), { lastPostAt: serverTimestamp() });
  return b.commit();
}

function newThread(db, uid, handle, { id = 't-new', title = 'Carb rebuild tips', body = 'Hello', role = 'member', thread = {} } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'threads', id), {
    areaId: 'general', title, authorUid: uid, authorHandle: handle, authorRole: role,
    createdAt: serverTimestamp(), lastReplyAt: serverTimestamp(), replyCount: 0,
    pinned: false, locked: false, hidden: false, ...thread,
  });
  b.set(doc(db, 'threads', id, 'posts', 'op'), {
    authorUid: uid, authorHandle: handle, authorRole: role, body, createdAt: serverTimestamp(), hidden: false,
  });
  b.update(doc(db, 'users', uid), { lastPostAt: serverTimestamp() });
  return b.commit();
}

function report(db, uid, handle, { threadId = 't1', postId = 'p1', reason = 'spam', note = '', idOverride } = {}) {
  return setDoc(doc(db, 'reports', idOverride ?? `${threadId}__${postId}__${uid}`), {
    threadId, postId, reporterUid: uid, reporterHandle: handle, reason, note, createdAt: serverTimestamp(), status: 'open',
  });
}

beforeEach(async () => {
  await env.clearFirestore();
  await seedMember('ryan', 'Ryan_F');
  await seedMember('bob', 'Bob');
  await seedMember('muted', 'Muted1', { status: 'muted' });
  await seedMember('banned', 'Banned1', { status: 'banned' });
  await seedMember('sysop1', 'Boss');
  await seed(async (db) => {
    await setDoc(doc(db, 'admins', 'sysop1'), { addedAt: new Date() });
    await setDoc(doc(db, 'areas', 'general'), { key: '[1]', name: 'General', order: 1 });
    await setDoc(doc(db, 'settings', 'site'), { sysopNotice: '', forumOpen: true, bannedWords: ['spammy', 'buy now'] });
    await setDoc(doc(db, 'threads', 't1'), {
      areaId: 'general', title: 'T1', authorUid: 'bob', authorHandle: 'Bob', authorRole: 'member',
      createdAt: longAgo, lastReplyAt: longAgo, replyCount: 1, pinned: false, locked: false, hidden: false,
    });
    await setDoc(doc(db, 'threads', 't1', 'posts', 'op'), { authorUid: 'bob', authorHandle: 'Bob', authorRole: 'member', body: 'op', createdAt: longAgo, hidden: false });
    await setDoc(doc(db, 'threads', 't1', 'posts', 'p1'), { authorUid: 'bob', authorHandle: 'Bob', authorRole: 'member', body: 'p1', createdAt: Timestamp.now(), hidden: false });
    await setDoc(doc(db, 'threads', 't1', 'posts', 'gone'), { authorUid: 'bob', authorHandle: 'Bob', authorRole: 'member', body: 'x', createdAt: longAgo, hidden: true });
    await setDoc(doc(db, 'modlog', 'm1'), { action: 'thread.lock', byUid: 'sysop1' });
  });
});

// ---------- forum switch -----------------------------------------------------

describe('forum switch (read-only mode)', () => {
  beforeEach(() => seed((db) => updateDoc(doc(db, 'settings', 'site'), { forumOpen: false })));

  test('members cannot post or start threads while the forum is closed', async () => {
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F'));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F'));
  });

  test('the sysop can still post', async () => {
    await assertSucceeds(reply(as('sysop1'), 'sysop1', 'Boss', { role: 'sysop' }));
  });

  test('everyone can still read', async () => {
    await assertSucceeds(getDoc(doc(guest(), 'threads', 't1', 'posts', 'op')));
  });
});

// ---------- word filter ------------------------------------------------------------

describe('word filter', () => {
  test('a reply with a banned word must be saved hidden and held', async () => {
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { body: 'This is SPAMMY stuff' }));
    await assertSucceeds(reply(as('ryan'), 'ryan', 'Ryan_F', { body: 'This is SPAMMY stuff', post: { hidden: true, held: true } }));
  });

  test('multi-word phrases match too, ignoring capitals and line breaks', async () => {
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { body: 'line one\nBuy Now please' }));
  });

  test('only whole words match ("spammy" doesn’t catch "unspammyish")', async () => {
    await assertSucceeds(reply(as('ryan'), 'ryan', 'Ryan_F', { body: 'unspammyish is fine' }));
  });

  test('a clean post cannot be marked held, and cannot start out hidden', async () => {
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { body: 'clean', post: { hidden: true, held: true } }));
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { body: 'clean', post: { held: false } }));
  });

  test('a new thread with a banned word in the title or post is held as a whole', async () => {
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { title: 'Buy now: parts' }));
    await assertSucceeds(newThread(as('ryan'), 'ryan', 'Ryan_F', { title: 'Buy now: parts', thread: { hidden: true, held: true } }));
    // (a different member, so the 20-second rate limit doesn't apply)
    await assertSucceeds(newThread(as('bob'), 'bob', 'Bob', { id: 't-b', body: 'spammy', thread: { hidden: true, held: true } }));
  });

  test('editing a post to add a banned word is refused', async () => {
    await assertFails(updateDoc(doc(as('bob'), 'threads', 't1', 'posts', 'p1'), { body: 'now spammy', editedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(as('bob'), 'threads', 't1', 'posts', 'p1'), { body: 'now clean', editedAt: serverTimestamp() }));
  });

  test('with no banned words, nothing is held', async () => {
    await seed((db) => updateDoc(doc(db, 'settings', 'site'), { bannedWords: [] }));
    await assertSucceeds(reply(as('ryan'), 'ryan', 'Ryan_F', { body: 'spammy is fine now' }));
  });
});

// ---------- reports ----------------------------------------------------------------

describe('reports', () => {
  test('active and muted members can report a visible post', async () => {
    await assertSucceeds(report(as('ryan'), 'ryan', 'Ryan_F'));
    await assertSucceeds(report(as('muted'), 'muted', 'Muted1', { reason: 'rude', note: 'not nice' }));
  });

  test('guests and banned members cannot report', async () => {
    await assertFails(report(guest(), 'ryan', 'Ryan_F'));
    await assertFails(report(as('banned'), 'banned', 'Banned1'));
  });

  test('one report per member per post', async () => {
    await assertSucceeds(report(as('ryan'), 'ryan', 'Ryan_F'));
    await assertFails(report(as('ryan'), 'ryan', 'Ryan_F'));
    await assertFails(report(as('ryan'), 'ryan', 'Ryan_F', { idOverride: 'another-id' }));
  });

  test('cannot report as someone else, with a fake reason, or a hidden/missing post', async () => {
    await assertFails(report(as('ryan'), 'ryan', 'Bob'));
    await assertFails(report(as('ryan'), 'ryan', 'Ryan_F', { reason: 'boring' }));
    await assertFails(report(as('ryan'), 'ryan', 'Ryan_F', { note: 'x'.repeat(501) }));
    await assertFails(report(as('ryan'), 'ryan', 'Ryan_F', { postId: 'gone' }));
    await assertFails(report(as('ryan'), 'ryan', 'Ryan_F', { postId: 'nope' }));
  });

  test('only the sysop can read reports, and nobody edits them directly', async () => {
    await seed((db) => setDoc(doc(db, 'reports', 't1__p1__bob'), { status: 'open' }));
    await assertFails(getDoc(doc(as('ryan'), 'reports', 't1__p1__bob')));
    await assertFails(getDoc(doc(as('bob'), 'reports', 't1__p1__bob')));
    await assertSucceeds(getDoc(doc(as('sysop1'), 'reports', 't1__p1__bob')));
    await assertFails(updateDoc(doc(as('sysop1'), 'reports', 't1__p1__bob'), { status: 'dismissed' }));
  });
});

// ---------- sysop-only reads; moderation only through the function ---------------

describe('moderation access', () => {
  test('only the sysop can read the mod log; nobody writes it from the page', async () => {
    await assertFails(getDocs(collection(as('ryan'), 'modlog')));
    await assertSucceeds(getDocs(collection(as('sysop1'), 'modlog')));
    await assertFails(setDoc(doc(as('sysop1'), 'modlog', 'fake'), { action: 'x' }));
  });

  test('only the sysop can list handles (member search)', async () => {
    await assertFails(getDocs(collection(as('ryan'), 'handles')));
    await assertSucceeds(getDocs(collection(as('sysop1'), 'handles')));
  });

  test('only the sysop can query posts across all threads', async () => {
    await assertFails(getDocs(query(collectionGroup(as('ryan'), 'posts'), where('authorUid', '==', 'bob'))));
    await assertFails(getDocs(query(collectionGroup(guest(), 'posts'), where('hidden', '==', false))));
    await assertSucceeds(getDocs(query(collectionGroup(as('sysop1'), 'posts'), where('authorUid', '==', 'bob'))));
  });

  test('even the sysop cannot pin, lock, hide or change status directly (must use the logged function)', async () => {
    const db = as('sysop1');
    await assertFails(updateDoc(doc(db, 'threads', 't1'), { pinned: true }));
    await assertFails(updateDoc(doc(db, 'threads', 't1', 'posts', 'p1'), { hidden: true }));
    await assertFails(updateDoc(doc(db, 'users', 'bob'), { status: 'banned' }));
  });

  test('the sysop can read hidden posts and ban reasons; members cannot', async () => {
    await seed((db) => setDoc(doc(db, 'private', 'banned'), { email: 'b@example.com', bannedReason: 'spam' }));
    await assertSucceeds(getDoc(doc(as('sysop1'), 'threads', 't1', 'posts', 'gone')));
    await assertSucceeds(getDoc(doc(as('sysop1'), 'private', 'banned')));
    await assertFails(getDoc(doc(as('banned'), 'private', 'banned')));
  });
});
