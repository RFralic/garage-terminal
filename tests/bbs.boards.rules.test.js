// BBS part 2 rules: boards, threads, posts, files, "last visit" marks, and their uploads
// in Storage. Members only; authors edit / delete their own; sysop and co-sysops moderate.
// Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch,
} from 'firebase/firestore';
import { startEnv, asOf, guestOf, seed as seedRaw, seedMember as seedMemberRaw } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());

const as = (...a) => asOf(env)(...a);
const guest = () => guestOf(env)();
const seed = (fn) => seedRaw(env, fn);
const member = (role = 'member', handle) => ({ handle, role, since: new Date(), addedBy: 'Boss', lastSeen: null });

beforeEach(async () => {
  await env.clearFirestore();
  if (process.env.FIREBASE_STORAGE_EMULATOR_HOST) await env.clearStorage();
  for (const [uid, h] of [['boss', 'Boss'], ['carl', 'Carl'], ['mia', 'Mia'], ['pete', 'Pete']]) await seedMemberRaw(env, uid, h);
  await seed(async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    await setDoc(doc(db, 'bbsMembers', 'carl'), member('cosysop', 'Carl'));
    await setDoc(doc(db, 'bbsMembers', 'mia'), member('member', 'Mia'));
    await setDoc(doc(db, 'bbsBoards', 'general'), { name: 'General', description: '', order: 1, archived: false, createdAt: new Date() });
    await setDoc(doc(db, 'bbsBoards', 'old'), { name: 'Old', description: '', order: 9, archived: true, createdAt: new Date() });
    await setDoc(doc(db, 'bbsThreads', 't1'), { boardId: 'general', title: 'Carb help', authorUid: 'mia', authorHandle: 'Mia', createdAt: new Date(), lastAt: new Date(), lastBy: 'Mia', replyCount: 1, pinned: false, locked: false });
    await setDoc(doc(db, 'bbsThreads', 't1', 'posts', 'op'), { authorUid: 'mia', authorHandle: 'Mia', body: 'Bowl is gummed up', createdAt: new Date() });
    await setDoc(doc(db, 'bbsThreads', 't1', 'posts', 'r1'), { authorUid: 'carl', authorHandle: 'Carl', body: 'Soak it', createdAt: new Date() });
    await setDoc(doc(db, 'bbsFiles', 'f1'), { title: 'Wiring', titleLower: 'wiring', note: '', name: 'w.pdf', type: 'PDF', size: 4, contentType: 'application/pdf', path: 'bbs/files/mia/f1/w.pdf', byUid: 'mia', byHandle: 'Mia', createdAt: new Date() });
  });
});

/** New thread + opening post, the way the page writes them. */
function newThread(db, uid, handle, id, extra = {}, opExtra = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'bbsThreads', id), { boardId: 'general', title: 'Float height', authorUid: uid, authorHandle: handle, createdAt: serverTimestamp(), lastAt: serverTimestamp(), lastBy: handle, replyCount: 0, pinned: false, locked: false, ...extra });
  b.set(doc(db, 'bbsThreads', id, 'posts', 'op'), { authorUid: uid, authorHandle: handle, body: '1/4 inch', createdAt: serverTimestamp(), ...opExtra });
  return b.commit();
}
const reply = (db, uid, handle, threadId = 't1', extra = {}) =>
  setDoc(doc(collection(db, 'bbsThreads', threadId, 'posts')), { authorUid: uid, authorHandle: handle, body: 'Same here', createdAt: serverTimestamp(), ...extra });

describe('reading', () => {
  test('members and the sysop read boards, threads, posts and files; others read nothing', async () => {
    for (const uid of ['mia', 'boss']) {
      await assertSucceeds(getDocs(collection(as(uid), 'bbsBoards')));
      await assertSucceeds(getDocs(collection(as(uid), 'bbsThreads')));
      await assertSucceeds(getDocs(collection(as(uid), 'bbsThreads', 't1', 'posts')));
      await assertSucceeds(getDocs(collection(as(uid), 'bbsFiles')));
    }
    for (const db of [as('pete'), guest()]) {
      await assertFails(getDocs(collection(db, 'bbsBoards')));
      await assertFails(getDoc(doc(db, 'bbsThreads', 't1')));
      await assertFails(getDocs(collection(db, 'bbsThreads', 't1', 'posts')));
      await assertFails(getDocs(collection(db, 'bbsFiles')));
    }
  });
  test('removed: cut off at once', async () => {
    await seed((db) => deleteDoc(doc(db, 'bbsMembers', 'mia')));
    await assertFails(getDoc(doc(as('mia'), 'bbsThreads', 't1')));
  });
});

describe('posting', () => {
  test('a member starts a thread as themselves, on an open board', async () => {
    await assertSucceeds(newThread(as('mia'), 'mia', 'Mia', 'n1'));
    await assertFails(newThread(as('mia'), 'mia', 'Carl', 'n2'));
    await assertFails(newThread(as('pete'), 'pete', 'Pete', 'n3'));
    await assertFails(newThread(as('mia'), 'mia', 'Mia', 'n4', { boardId: 'old' }));
    await assertFails(newThread(as('mia'), 'mia', 'Mia', 'n5', { pinned: true }));
    await assertFails(newThread(as('mia'), 'mia', 'Mia', 'n6', { replyCount: 3 }));
    await assertFails(newThread(as('mia'), 'mia', 'Mia', 'n7', { saved: true }, { saved: { who: 'Carl' } }));
  });
  test('the sysop posts too', async () => {
    await assertSucceeds(newThread(as('boss'), 'boss', 'Boss', 'n8'));
  });
  test('replies: as yourself, not to a locked thread or an archived board', async () => {
    await assertSucceeds(reply(as('mia'), 'mia', 'Mia'));
    await assertFails(reply(as('mia'), 'mia', 'Boss'));
    await assertFails(reply(as('pete'), 'pete', 'Pete'));
    await seed((db) => updateDoc(doc(db, 'bbsThreads', 't1'), { locked: true }));
    await assertFails(reply(as('mia'), 'mia', 'Mia'));
    await seed((db) => updateDoc(doc(db, 'bbsThreads', 't1'), { locked: false, boardId: 'old' }));
    await assertFails(reply(as('mia'), 'mia', 'Mia'));
  });
  test('a photo must be in your own folder', async () => {
    await assertSucceeds(reply(as('mia'), 'mia', 'Mia', 't1', { photo: { path: 'bbs/posts/mia/abc.jpg', w: 800, h: 600 } }));
    await assertFails(reply(as('mia'), 'mia', 'Mia', 't1', { photo: { path: 'bbs/posts/carl/abc.jpg', w: 800, h: 600 } }));
    await assertFails(reply(as('mia'), 'mia', 'Mia', 't1', { photo: { path: 'library/x/abc.jpg', w: 1, h: 1 } }));
  });
  test('nobody sets counts directly', async () => {
    await assertFails(updateDoc(doc(as('mia'), 'bbsThreads', 't1'), { replyCount: 9 }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsThreads', 't1'), { lastAt: serverTimestamp() }));
  });
});

describe('editing and moderating', () => {
  test('authors edit their own post; nobody edits someone else’s', async () => {
    await assertSucceeds(updateDoc(doc(as('mia'), 'bbsThreads', 't1', 'posts', 'op'), { body: 'fixed', editedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsThreads', 't1', 'posts', 'op'), { body: 'x', editedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as('boss'), 'bbsThreads', 't1', 'posts', 'op'), { body: 'x', editedAt: serverTimestamp() }));
  });
  test('authors delete their own replies; the sysop and co-sysops delete any', async () => {
    await assertFails(deleteDoc(doc(as('mia'), 'bbsThreads', 't1', 'posts', 'r1')));
    await assertSucceeds(deleteDoc(doc(as('carl'), 'bbsThreads', 't1', 'posts', 'r1')));
    await seed((db) => setDoc(doc(db, 'bbsThreads', 't1', 'posts', 'r2'), { authorUid: 'mia', authorHandle: 'Mia', body: 'x', createdAt: new Date() }));
    await assertSucceeds(deleteDoc(doc(as('mia'), 'bbsThreads', 't1', 'posts', 'r2')));
  });
  test('lock and pin: sysop and co-sysops only', async () => {
    await assertFails(updateDoc(doc(as('mia'), 'bbsThreads', 't1'), { locked: true }));
    await assertSucceeds(updateDoc(doc(as('carl'), 'bbsThreads', 't1'), { locked: true }));
    await assertSucceeds(updateDoc(doc(as('boss'), 'bbsThreads', 't1'), { pinned: true }));
  });
  test('delete a whole thread: its author, the sysop or a co-sysop', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'bbsMembers', 'pete'), member('member', 'Pete'));
    });
    await assertFails(deleteDoc(doc(as('pete'), 'bbsThreads', 't1')));
    await assertSucceeds(deleteDoc(doc(as('mia'), 'bbsThreads', 't1')));
  });
  test('boards are changed only through the Cloud Function', async () => {
    await assertFails(setDoc(doc(as('boss'), 'bbsBoards', 'new'), { name: 'New', description: '', order: 4, archived: false, createdAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsBoards', 'general'), { archived: true }));
  });
});

describe('files and last visits', () => {
  const file = (uid, handle, id, extra = {}) => setDoc(doc(as(uid), 'bbsFiles', id), {
    title: 'Manual', titleLower: 'manual', note: '', name: 'm.pdf', type: 'PDF', size: 1000, contentType: 'application/pdf',
    path: `bbs/files/${uid}/${id}/m.pdf`, byUid: uid, byHandle: handle, createdAt: serverTimestamp(), ...extra });
  test('members list a file they uploaded, up to 25 MB, as themselves', async () => {
    await assertSucceeds(file('mia', 'Mia', 'f2'));
    await assertFails(file('mia', 'Mia', 'f3', { size: 26 * 1024 * 1024 }));
    await assertFails(file('mia', 'Mia', 'f4', { path: 'bbs/files/carl/f4/m.pdf' }));
    await assertFails(file('mia', 'Carl', 'f5'));
    await assertFails(file('pete', 'Pete', 'f6'));
  });
  test('the uploader or a moderator deletes a file', async () => {
    await seed((db) => setDoc(doc(db, 'bbsMembers', 'pete'), member('member', 'Pete')));
    await assertFails(deleteDoc(doc(as('pete'), 'bbsFiles', 'f1')));
    await assertSucceeds(deleteDoc(doc(as('carl'), 'bbsFiles', 'f1')));
  });
  test('last-visit marks: your own only', async () => {
    await assertSucceeds(setDoc(doc(as('mia'), 'bbsReads', 'mia'), { boards: { general: serverTimestamp() } }, { merge: true }));
    await assertFails(getDoc(doc(as('carl'), 'bbsReads', 'mia')));
    await assertFails(setDoc(doc(as('pete'), 'bbsReads', 'pete'), { files: serverTimestamp() }));
  });
});

describe('uploads (Storage)', { skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST && 'Storage emulator not running' }, () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const st = (uid) => env.authenticatedContext(uid).storage();
  test('members upload to their own folder: files up to 25 MB of allowed types, photos as images', async () => {
    await assertSucceeds(st('mia').ref('bbs/files/mia/f9/manual.pdf').put(bytes, { contentType: 'application/pdf' }));
    await assertFails(st('mia').ref('bbs/files/carl/f9/manual.pdf').put(bytes, { contentType: 'application/pdf' }));
    await assertFails(st('mia').ref('bbs/files/mia/f9/run.exe').put(bytes, { contentType: 'application/x-msdownload' }));
    await assertFails(st('pete').ref('bbs/files/pete/f9/manual.pdf').put(bytes, { contentType: 'application/pdf' }));
    await assertSucceeds(st('mia').ref('bbs/posts/mia/p.jpg').put(bytes, { contentType: 'image/jpeg' }));
    await assertFails(st('mia').ref('bbs/posts/mia/p.pdf').put(bytes, { contentType: 'application/pdf' }));
  });
  test('only members download; uploader or moderators delete', async () => {
    await env.withSecurityRulesDisabled((ctx) => ctx.storage().ref('bbs/files/mia/f1/w.pdf').put(bytes, { contentType: 'application/pdf' }));
    await assertSucceeds(st('carl').ref('bbs/files/mia/f1/w.pdf').getDownloadURL());
    await assertFails(st('pete').ref('bbs/files/mia/f1/w.pdf').getDownloadURL());
    await assertFails(env.unauthenticatedContext().storage().ref('bbs/files/mia/f1/w.pdf').getDownloadURL());
    await seed((db) => setDoc(doc(db, 'bbsMembers', 'pete'), member('member', 'Pete')));
    await assertFails(st('pete').ref('bbs/files/mia/f1/w.pdf').delete());
    await assertSucceeds(st('carl').ref('bbs/files/mia/f1/w.pdf').delete());
  });
});
