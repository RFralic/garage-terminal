// Forum rules tests: threads, posts, rate limit, locks, hidden items, SYSOP badge.
// Run with:  npm run test:rules

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc,
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

// ---------- writes, exactly as the forum pages make them ---------------------

function newThread(db, uid, handle, { id = 't-new', areaId = 'general', title = 'Carb rebuild tips', body = 'Hello **shop**', role = 'member', thread = {}, post = {}, bump = true } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'threads', id), {
    areaId, title, authorUid: uid, authorHandle: handle, authorRole: role,
    createdAt: serverTimestamp(), lastReplyAt: serverTimestamp(), replyCount: 0,
    pinned: false, locked: false, hidden: false, ...thread,
  });
  b.set(doc(db, 'threads', id, 'posts', 'op'), {
    authorUid: uid, authorHandle: handle, authorRole: role, body,
    createdAt: serverTimestamp(), hidden: false, ...post,
  });
  if (bump) b.update(doc(db, 'users', uid), { lastPostAt: serverTimestamp() });
  return b.commit();
}

function reply(db, uid, handle, { threadId = 't1', postId = 'r-new', body = 'Nice one', role = 'member', post = {}, bump = true } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'threads', threadId, 'posts', postId), {
    authorUid: uid, authorHandle: handle, authorRole: role, body,
    createdAt: serverTimestamp(), hidden: false, ...post,
  });
  if (bump) b.update(doc(db, 'users', uid), { lastPostAt: serverTimestamp() });
  return b.commit();
}

// ---------- fixtures -----------------------------------------------------------

const longAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000); // 1 hour ago
const justNow = Timestamp.fromMillis(Date.now() - 5 * 1000); // 5 seconds ago

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
    await setDoc(doc(db, 'settings', 'site'), { sysopNotice: 'Welcome', forumOpen: true, bannedWords: [] });
    const t = (id, extra = {}) => setDoc(doc(db, 'threads', id), {
      areaId: 'general', title: 'Thread ' + id, authorUid: 'bob', authorHandle: 'Bob', authorRole: 'member',
      createdAt: longAgo, lastReplyAt: longAgo, replyCount: 0, pinned: false, locked: false, hidden: false, ...extra,
    });
    const p = (tid, pid, extra = {}) => setDoc(doc(db, 'threads', tid, 'posts', pid), {
      authorUid: 'bob', authorHandle: 'Bob', authorRole: 'member', body: 'post ' + pid,
      createdAt: longAgo, hidden: false, ...extra,
    });
    await t('t1'); await p('t1', 'op'); await p('t1', 'old-reply');
    await p('t1', 'fresh-reply', { createdAt: Timestamp.now() });
    await p('t1', 'hidden-reply', { hidden: true });
    await t('locked', { locked: true }); await p('locked', 'op');
    await t('hidden', { hidden: true }); await p('hidden', 'op');
  });
});

// ---------- reading -----------------------------------------------------------

describe('reading', () => {
  test('guests can read visible threads, posts, areas and the sysop notice', async () => {
    const db = guest();
    await assertSucceeds(getDoc(doc(db, 'threads', 't1')));
    await assertSucceeds(getDoc(doc(db, 'threads', 't1', 'posts', 'op')));
    await assertSucceeds(getDocs(query(collection(db, 'threads'), where('hidden', '==', false))));
    await assertSucceeds(getDocs(query(collection(db, 'threads', 't1', 'posts'), where('hidden', '==', false))));
    await assertSucceeds(getDoc(doc(db, 'areas', 'general')));
    await assertSucceeds(getDoc(doc(db, 'settings', 'site')));
  });

  test('hidden threads and posts are invisible to guests and members', async () => {
    for (const db of [guest(), as('ryan')]) {
      await assertFails(getDoc(doc(db, 'threads', 'hidden')));
      await assertFails(getDoc(doc(db, 'threads', 'hidden', 'posts', 'op')));
      await assertFails(getDoc(doc(db, 'threads', 't1', 'posts', 'hidden-reply')));
      // a query that doesn't filter out hidden items is refused outright
      await assertFails(getDocs(collection(db, 'threads')));
    }
  });

  test('the sysop can see hidden threads and posts', async () => {
    const db = as('sysop1');
    await assertSucceeds(getDoc(doc(db, 'threads', 'hidden')));
    await assertSucceeds(getDoc(doc(db, 'threads', 't1', 'posts', 'hidden-reply')));
    await assertSucceeds(getDocs(collection(db, 'threads')));
  });
});

// ---------- new threads ---------------------------------------------------------

describe('new threads', () => {
  test('an active member can start a thread', async () => {
    await assertSucceeds(newThread(as('ryan'), 'ryan', 'Ryan_F'));
  });

  test('guests, muted and banned members cannot start threads', async () => {
    await assertFails(newThread(guest(), 'ryan', 'Ryan_F'));
    await assertFails(newThread(as('muted'), 'muted', 'Muted1'));
    await assertFails(newThread(as('banned'), 'banned', 'Banned1'));
  });

  test('a member with no handle cannot post', async () => {
    await assertFails(newThread(as('nohandle'), 'nohandle', 'Nobody'));
  });

  test('cannot post as someone else or under a fake handle', async () => {
    await assertFails(newThread(as('ryan'), 'bob', 'Bob'));
    await assertFails(newThread(as('ryan'), 'ryan', 'Bob'));
  });

  test('a member cannot fake the SYSOP badge; the sysop gets it', async () => {
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { role: 'sysop' }));
    await assertFails(newThread(as('sysop1'), 'sysop1', 'Boss', { role: 'member' }));
    await assertSucceeds(newThread(as('sysop1'), 'sysop1', 'Boss', { role: 'sysop' }));
  });

  test('title must be 3–120 characters and not blank', async () => {
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { title: 'ab' }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { title: 'x'.repeat(121) }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { title: '     ' }));
    await assertSucceeds(newThread(as('ryan'), 'ryan', 'Ryan_F', { title: 'x'.repeat(120) }));
  });

  test('body must be 1–10,000 characters and not blank', async () => {
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { body: '' }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { body: '   \n ' }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { body: 'x'.repeat(10001) }));
    await assertSucceeds(newThread(as('ryan'), 'ryan', 'Ryan_F', { body: 'x'.repeat(10000) }));
  });

  test('cannot start pinned, locked, hidden, with fake counts, or in a made-up area', async () => {
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { thread: { pinned: true } }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { thread: { locked: true } }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { thread: { replyCount: 50 } }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { areaId: 'nope' }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { thread: { extra: 1 } }));
  });

  test('a thread needs its opening post, and an opening post needs a new thread', async () => {
    const db = as('ryan');
    const b = writeBatch(db);
    b.set(doc(db, 'threads', 'lonely'), {
      areaId: 'general', title: 'No post', authorUid: 'ryan', authorHandle: 'Ryan_F', authorRole: 'member',
      createdAt: serverTimestamp(), lastReplyAt: serverTimestamp(), replyCount: 0, pinned: false, locked: false, hidden: false,
    });
    b.update(doc(db, 'users', 'ryan'), { lastPostAt: serverTimestamp() });
    await assertFails(b.commit());
    // can't overwrite an existing thread's opening post
    await assertFails(reply(db, 'ryan', 'Ryan_F', { postId: 'op' }));
  });
});

// ---------- replies -------------------------------------------------------------

describe('replies', () => {
  test('an active member can reply', async () => {
    await assertSucceeds(reply(as('ryan'), 'ryan', 'Ryan_F'));
  });

  test('guests, muted and banned members cannot reply', async () => {
    await assertFails(reply(guest(), 'ryan', 'Ryan_F'));
    await assertFails(reply(as('muted'), 'muted', 'Muted1'));
    await assertFails(reply(as('banned'), 'banned', 'Banned1'));
  });

  test('no replies in locked or hidden threads, or threads that don’t exist', async () => {
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { threadId: 'locked' }));
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { threadId: 'hidden' }));
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { threadId: 'ghost' }));
  });

  test('cannot post a reply that starts out hidden or has extra fields', async () => {
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { post: { hidden: true } }));
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { post: { editedAt: serverTimestamp() } }));
  });
});

// ---------- rate limit ------------------------------------------------------------

describe('rate limit: one post per 20 seconds', () => {
  test('posting without updating "last posted" is refused', async () => {
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F', { bump: false }));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F', { bump: false }));
  });

  test('a second post within 20 seconds is refused', async () => {
    await seed((db) => updateDoc(doc(db, 'users', 'ryan'), { lastPostAt: justNow }));
    await assertFails(reply(as('ryan'), 'ryan', 'Ryan_F'));
    await assertFails(newThread(as('ryan'), 'ryan', 'Ryan_F'));
  });

  test('posting is fine again after 20 seconds', async () => {
    await seed((db) => updateDoc(doc(db, 'users', 'ryan'), { lastPostAt: Timestamp.fromMillis(Date.now() - 21000) }));
    await assertSucceeds(reply(as('ryan'), 'ryan', 'Ryan_F'));
  });

  test('"last posted" can only be set to now, and nothing else on the profile', async () => {
    const db = as('ryan');
    await assertFails(updateDoc(doc(db, 'users', 'ryan'), { lastPostAt: longAgo }));
    await assertFails(updateDoc(doc(db, 'users', 'ryan'), { lastPostAt: serverTimestamp(), postCount: 99 }));
    await assertFails(updateDoc(doc(db, 'users', 'bob'), { lastPostAt: serverTimestamp() }));
  });
});

// ---------- editing and deleting -----------------------------------------------

describe('editing and deleting', () => {
  const edit = (db, postId, data = {}) =>
    updateDoc(doc(db, 'threads', 't1', 'posts', postId), { body: 'fixed typo', editedAt: serverTimestamp(), ...data });

  test('the author can edit their post within 30 minutes', async () => {
    await assertSucceeds(edit(as('bob'), 'fresh-reply'));
  });

  test('editing after 30 minutes is refused', async () => {
    await assertFails(edit(as('bob'), 'old-reply'));
  });

  test('nobody else can edit a post, and the author can only change the text', async () => {
    await assertFails(edit(as('ryan'), 'fresh-reply'));
    await assertFails(edit(as('bob'), 'fresh-reply', { authorHandle: 'Someone' }));
    await assertFails(edit(as('bob'), 'fresh-reply', { hidden: true }));
    await assertFails(updateDoc(doc(as('bob'), 'threads', 't1', 'posts', 'fresh-reply'), { body: 'no editedAt' }));
  });

  test('muted or banned authors cannot edit', async () => {
    await seed((db) => updateDoc(doc(db, 'users', 'bob'), { status: 'muted' }));
    await assertFails(edit(as('bob'), 'fresh-reply'));
  });

  test('the author can delete their own reply, but not the opening post', async () => {
    await assertSucceeds(deleteDoc(doc(as('bob'), 'threads', 't1', 'posts', 'old-reply')));
    await assertFails(deleteDoc(doc(as('bob'), 'threads', 't1', 'posts', 'op')));
  });

  test('nobody can delete someone else’s post', async () => {
    await assertFails(deleteDoc(doc(as('ryan'), 'threads', 't1', 'posts', 'old-reply')));
    await assertFails(deleteDoc(doc(guest(), 'threads', 't1', 'posts', 'old-reply')));
  });

  test('members cannot change threads: counts, pins, locks, titles', async () => {
    const db = as('bob');
    for (const change of [{ replyCount: 99 }, { pinned: true }, { locked: false }, { title: 'Renamed' }, { hidden: true }]) {
      await assertFails(updateDoc(doc(db, 'threads', 't1'), change));
    }
    await assertFails(deleteDoc(doc(db, 'threads', 't1')));
  });
});

// ---------- areas and settings -------------------------------------------------

describe('areas and settings', () => {
  test('members cannot change areas or the sysop notice', async () => {
    await assertFails(setDoc(doc(as('ryan'), 'areas', 'spam'), { key: '[9]', name: 'Spam', order: 9 }));
    await assertFails(updateDoc(doc(as('ryan'), 'settings', 'site'), { sysopNotice: 'hacked' }));
  });

  test('even the sysop changes settings only through the logged moderation function', async () => {
    await assertFails(updateDoc(doc(as('sysop1'), 'settings', 'site'), { sysopNotice: 'New rules' }));
  });
});
