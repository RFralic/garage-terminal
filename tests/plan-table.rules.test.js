// The security table from PLAN.md, one block per row (Guest, Member, Muted,
// Banned, Sysop). Most details are tested in depth in the other files; this
// file checks each row end to end so it's easy to see the table is enforced.
// Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp,
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

function reply(db, uid, handle, role = 'member') {
  const b = writeBatch(db);
  b.set(doc(db, 'threads', 't1', 'posts', `r-${uid}`), {
    authorUid: uid, authorHandle: handle, authorRole: role, body: 'hi', createdAt: serverTimestamp(), hidden: false,
  });
  b.update(doc(db, 'users', uid), { lastPostAt: serverTimestamp() });
  return b.commit();
}
const report = (db, uid, handle) => setDoc(doc(db, 'reports', `t1__p1__${uid}`), {
  threadId: 't1', postId: 'p1', reporterUid: uid, reporterHandle: handle, reason: 'spam', note: '', createdAt: serverTimestamp(), status: 'open',
});

/** Everything a reader may see: visible thread + posts, published library item. */
async function canReadPublicThings(db) {
  await assertSucceeds(getDoc(doc(db, 'threads', 't1')));
  await assertSucceeds(getDocs(query(collection(db, 'threads', 't1', 'posts'), where('hidden', '==', false))));
  await assertSucceeds(getDoc(doc(db, 'library', 'pub')));
  await assertSucceeds(getDocs(query(collection(db, 'library'), where('status', '==', 'published'))));
}

/** Everything nobody but the sysop may see. */
async function cannotReadPrivateThings(db) {
  await assertFails(getDoc(doc(db, 'threads', 'hid')));
  await assertFails(getDoc(doc(db, 'threads', 't1', 'posts', 'hidden')));
  await assertFails(getDoc(doc(db, 'library', 'draft')));
  await assertFails(getDoc(doc(db, 'private', 'bob')));
  await assertFails(getDocs(collection(db, 'reports')));
  await assertFails(getDocs(collection(db, 'modlog')));
}

beforeEach(async () => {
  await env.clearFirestore();
  await seedMember('bob', 'Bob');
  await seedMember('muted', 'Muted1', { status: 'muted' });
  await seedMember('banned', 'Banned1', { status: 'banned' });
  await seedMember('boss', 'Boss');
  await seed(async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    await setDoc(doc(db, 'areas', 'general'), { key: '[1]', name: 'General', order: 1 });
    await setDoc(doc(db, 'settings', 'site'), { sysopNotice: '', forumOpen: true, bannedWords: [] });
    const thread = { areaId: 'general', title: 'T', authorUid: 'bob', authorHandle: 'Bob', authorRole: 'member', createdAt: longAgo, lastReplyAt: longAgo, replyCount: 1, pinned: false, locked: false };
    await setDoc(doc(db, 'threads', 't1'), { ...thread, hidden: false });
    await setDoc(doc(db, 'threads', 'hid'), { ...thread, hidden: true });
    const post = { authorUid: 'bob', authorHandle: 'Bob', authorRole: 'member', body: 'x', createdAt: longAgo };
    await setDoc(doc(db, 'threads', 't1', 'posts', 'op'), { ...post, hidden: false });
    await setDoc(doc(db, 'threads', 't1', 'posts', 'p1'), { ...post, hidden: false });
    await setDoc(doc(db, 'threads', 't1', 'posts', 'hidden'), { ...post, hidden: true });
    const lib = { slug: 'x', title: 'Doc', folder: 'guides', kind: 'page', type: 'GUIDE', description: '', body: 'b', storagePath: '', fileName: '', size: 0, contentType: '', createdAt: longAgo, updatedAt: longAgo, updatedBy: 'boss' };
    await setDoc(doc(db, 'library', 'pub'), { ...lib, slug: 'pub', status: 'published' });
    await setDoc(doc(db, 'library', 'draft'), { ...lib, slug: 'draft', status: 'draft' });
  });
});

describe('PLAN row: Guest', () => {
  test('can read visible threads, posts and published library items', async () => {
    await canReadPublicThings(guest());
  });
  test('cannot see hidden items, drafts, emails, reports or the mod log', async () => {
    await cannotReadPrivateThings(guest());
  });
  test('cannot write anything anywhere', async () => {
    const db = guest();
    for (const [path, data] of [
      ['threads/new', { title: 'x' }], ['threads/t1/posts/new', { body: 'x' }], ['users/x', { handle: 'x' }],
      ['handles/x', { uid: 'x' }], ['reports/x', { reason: 'spam' }], ['library/x', { title: 'x' }],
      ['settings/site', { forumOpen: false }], ['areas/x', { name: 'x' }], ['modlog/x', { action: 'x' }], ['admins/x', {}],
    ]) {
      await assertFails(setDoc(doc(db, ...path.split('/')), data));
    }
    await assertFails(deleteDoc(doc(db, 'threads', 't1', 'posts', 'p1')));
  });
});

describe('PLAN row: Member (signed in, has a handle, status active)', () => {
  test('can read like a guest, post and reply as themselves, report a post', async () => {
    await canReadPublicThings(as('bob'));
    await assertSucceeds(reply(as('bob'), 'bob', 'Bob'));
    await assertSucceeds(report(as('bob'), 'bob', 'Bob'));
  });
  test('cannot post as someone else, change counters/pins/locks, or see emails or hidden items', async () => {
    await assertFails(reply(as('bob'), 'muted', 'Muted1'));
    await assertFails(updateDoc(doc(as('bob'), 'threads', 't1'), { replyCount: 9 }));
    await assertFails(updateDoc(doc(as('bob'), 'threads', 't1'), { pinned: true }));
    await assertFails(updateDoc(doc(as('bob'), 'threads', 't1'), { locked: true }));
    await cannotReadPrivateThings(as('bob'));
  });
  test('cannot post in a locked thread', async () => {
    await seed((db) => updateDoc(doc(db, 'threads', 't1'), { locked: true }));
    await assertFails(reply(as('bob'), 'bob', 'Bob'));
  });
});

describe('PLAN row: Muted member', () => {
  test('can read and report', async () => {
    await canReadPublicThings(as('muted'));
    await assertSucceeds(report(as('muted'), 'muted', 'Muted1'));
  });
  test('cannot post or reply', async () => {
    await assertFails(reply(as('muted'), 'muted', 'Muted1'));
  });
});

describe('PLAN row: Banned member', () => {
  test('can read like a guest', async () => {
    await canReadPublicThings(as('banned'));
    await cannotReadPrivateThings(as('banned'));
  });
  test('cannot post, reply or report', async () => {
    await assertFails(reply(as('banned'), 'banned', 'Banned1'));
    await assertFails(report(as('banned'), 'banned', 'Banned1'));
  });
});

describe('PLAN row: Sysop (in admins)', () => {
  test('can read everything, including hidden items, drafts, emails, reports and the mod log', async () => {
    const db = as('boss');
    await canReadPublicThings(db);
    await assertSucceeds(getDoc(doc(db, 'threads', 'hid')));
    await assertSucceeds(getDoc(doc(db, 'threads', 't1', 'posts', 'hidden')));
    await assertSucceeds(getDoc(doc(db, 'library', 'draft')));
    await assertSucceeds(getDoc(doc(db, 'private', 'bob')));
    await assertSucceeds(getDocs(collection(db, 'reports')));
    await assertSucceeds(getDocs(collection(db, 'modlog')));
  });
  test('can post (with the SYSOP badge) and manage the library', async () => {
    await assertSucceeds(reply(as('boss'), 'boss', 'Boss', 'sysop'));
    await assertSucceeds(updateDoc(doc(as('boss'), 'library', 'draft'), { status: 'published', updatedAt: serverTimestamp(), updatedBy: 'boss' }));
  });
  test('moderation changes go through the logged function, not direct writes', async () => {
    await assertFails(updateDoc(doc(as('boss'), 'threads', 't1'), { pinned: true }));
  });
});
