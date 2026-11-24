// BBS private messages (bbsDms): only the two members of a conversation can read or write it,
// not even the sysop; removed members lose access and can't be messaged; muted members can't
// send; you delete only your own messages; nobody edits them. New messages must be sealed
// (end-to-end encrypted, src/bbs/e2e.js); message locks (bbsKeys, bbsKeyBackups) are each
// member's own.  Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  Bytes, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch, Timestamp,
} from 'firebase/firestore';
import { startEnv, asOf, guestOf, seed as seedRaw, seedMember } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());
const as = (...a) => asOf(env)(...a);
const seed = (fn) => seedRaw(env, fn);
const member = (handle, role = 'member', extra = {}) => ({ handle, role, since: new Date(), addedBy: 'Boss', lastSeen: null, ...extra });
const CONV = 'carl_mia'; // sorted uids

beforeEach(async () => {
  await env.clearFirestore();
  if (process.env.FIREBASE_STORAGE_EMULATOR_HOST) await env.clearStorage();
  for (const [uid, h] of [['boss', 'Boss'], ['carl', 'Carl'], ['mia', 'Mia'], ['moe', 'Moe'], ['pete', 'Pete']]) await seedMember(env, uid, h);
  await seed(async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    await setDoc(doc(db, 'bbsMembers', 'boss'), member('Boss', 'sysop'));
    await setDoc(doc(db, 'bbsMembers', 'carl'), member('Carl', 'cosysop'));
    await setDoc(doc(db, 'bbsMembers', 'mia'), member('Mia'));
    await setDoc(doc(db, 'bbsMembers', 'moe'), member('Moe', 'member', { mutedUntil: Timestamp.fromMillis(Date.now() + 3600000) }));
    await setDoc(doc(db, 'bbsDms', CONV), { members: ['carl', 'mia'], handles: { carl: 'Carl', mia: 'Mia' }, lastAt: new Date(), lastText: 'hi', lastBy: 'mia', lastId: 'm1', readAt: {}, hidden: {} });
    await setDoc(doc(db, 'bbsDms', CONV, 'messages', 'm1'), { uid: 'mia', handle: 'Mia', text: 'hi', createdAt: new Date() });
  });
});

const start = (uid, handle, other, otherHandle) => {
  const members = [uid, other].sort();
  return setDoc(doc(as(uid), 'bbsDms', members.join('_')), {
    members, handles: { [uid]: handle, [other]: otherHandle }, lastAt: serverTimestamp(), lastText: '', lastBy: uid, lastId: '',
    readAt: { [uid]: serverTimestamp() }, hidden: {} });
};
const ENC = { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'c2VhbGVkIHdvcmRzIGdvIGhlcmUgLi4u', k: ['0123456789abcdef', 'fedcba9876543210'] };
const sendAs = (uid, handle, conv = CONV, extra = {}, { lastText = 'Encrypted message', blob = null } = {}) => {
  const db = as(uid);
  const b = writeBatch(db);
  const m = doc(collection(db, 'bbsDms', conv, 'messages'));
  if (blob) b.set(doc(db, 'bbsDms', conv, 'blobs', m.id), { uid, iv: 'BBBBBBBBBBBBBBBB', data: Bytes.fromUint8Array(new Uint8Array(blob)), createdAt: serverTimestamp(), ...(blob.extra || {}) });
  b.set(m, { uid, handle, text: '', enc: ENC, createdAt: serverTimestamp(), ...extra });
  b.update(doc(db, 'bbsDms', conv), { lastAt: serverTimestamp(), lastText, lastBy: uid, lastId: m.id, [`readAt.${uid}`]: serverTimestamp() });
  return b.commit();
};

describe('private messages', () => {
  test('only the two members read the conversation and its messages: not the sysop, not a co-sysop, not other members', async () => {
    await assertSucceeds(getDoc(doc(as('mia'), 'bbsDms', CONV)));
    await assertSucceeds(getDocs(collection(as('carl'), 'bbsDms', CONV, 'messages')));
    for (const uid of ['boss', 'moe', 'pete']) {
      await assertFails(getDoc(doc(as(uid), 'bbsDms', CONV)));
      await assertFails(getDocs(collection(as(uid), 'bbsDms', CONV, 'messages')));
    }
    await assertFails(getDocs(collection(guestOf(env)(), 'bbsDms')));
  });
  test('listing: only your own conversations', async () => {
    await assertSucceeds(getDocs(query(collection(as('mia'), 'bbsDms'), where('members', 'array-contains', 'mia'))));
    await assertFails(getDocs(query(collection(as('boss'), 'bbsDms'), where('members', 'array-contains', 'mia'))));
    await assertFails(getDocs(collection(as('boss'), 'bbsDms')));
  });
  test('start a conversation with a member; not with yourself, an outsider, or under a wrong id', async () => {
    await assertSucceeds(start('mia', 'Mia', 'boss', 'Boss'));
    await assertFails(start('mia', 'Mia', 'pete', 'Pete'));
    await assertFails(start('pete', 'Pete', 'mia', 'Mia'));
    await assertFails(setDoc(doc(as('mia'), 'bbsDms', 'x_y'), { members: ['carl', 'mia'], handles: { mia: 'Mia', carl: 'Carl' }, lastAt: serverTimestamp(), lastText: '', lastBy: 'mia', lastId: '', readAt: {}, hidden: {} }));
    await assertFails(start('mia', 'Boss', 'moe', 'Moe'));
  });
  test('send as yourself; the other member can’t be impersonated', async () => {
    await assertSucceeds(sendAs('carl', 'Carl'));
    await assertFails(sendAs('carl', 'Mia'));
    await assertFails(sendAs('boss', 'Boss'));
  });
  test('muted members can’t send; removed members lose access; nobody can message them', async () => {
    await seed((db) => setDoc(doc(db, 'bbsDms', 'mia_moe'), { members: ['mia', 'moe'], handles: { mia: 'Mia', moe: 'Moe' }, lastAt: new Date(), lastText: '', lastBy: 'mia', lastId: '', readAt: {}, hidden: {} }));
    await assertFails(sendAs('moe', 'Moe', 'mia_moe'));
    await assertSucceeds(getDocs(collection(as('moe'), 'bbsDms', 'mia_moe', 'messages')));
    await seed((db) => deleteDoc(doc(db, 'bbsMembers', 'carl')));
    await assertFails(getDoc(doc(as('carl'), 'bbsDms', CONV)));
    await assertFails(sendAs('mia', 'Mia'));
  });
  test('delete your own messages only; nobody edits', async () => {
    await assertFails(deleteDoc(doc(as('carl'), 'bbsDms', CONV, 'messages', 'm1')));
    await assertFails(deleteDoc(doc(as('boss'), 'bbsDms', CONV, 'messages', 'm1')));
    await assertFails(updateDoc(doc(as('mia'), 'bbsDms', CONV, 'messages', 'm1'), { text: 'changed' }));
    await assertSucceeds(deleteDoc(doc(as('mia'), 'bbsDms', CONV, 'messages', 'm1')));
  });
  test('read marks and hiding: your own only', async () => {
    await assertSucceeds(updateDoc(doc(as('carl'), 'bbsDms', CONV), { 'readAt.carl': serverTimestamp() }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsDms', CONV), { 'readAt.mia': serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(as('carl'), 'bbsDms', CONV), { 'hidden.carl': serverTimestamp() }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsDms', CONV), { 'hidden.mia': serverTimestamp() }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsDms', CONV), { members: ['carl', 'pete'] }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsDms', CONV), { lastAt: serverTimestamp(), lastBy: 'mia' }));
    await assertFails(deleteDoc(doc(as('carl'), 'bbsDms', CONV)));
  });
});

describe('end-to-end encryption', () => {
  test('new messages must be sealed: plain words are refused', async () => {
    await assertSucceeds(sendAs('carl', 'Carl'));
    await assertFails(sendAs('carl', 'Carl', CONV, { text: 'Got the puller?' }));
    await assertFails(sendAs('carl', 'Carl', CONV, { enc: null }));
    await assertFails(sendAs('carl', 'Carl', CONV, { enc: { ...ENC, v: 2 } }));
    await assertFails(sendAs('carl', 'Carl', CONV, { enc: { ...ENC, k: ['0123456789abcdef'] } }));
    await assertFails(sendAs('carl', 'Carl', CONV, { enc: { ...ENC, plain: 'oops' } }));
    // Old-style photo in Storage: not any more.
    await assertFails(sendAs('carl', 'Carl', CONV, { photo: { path: `bbs/dm/carl/${CONV}/a.jpg`, w: 10, h: 10 } }));
  });
  test('the list preview can only say "Encrypted message" or "Message deleted"', async () => {
    await assertFails(sendAs('carl', 'Carl', CONV, {}, { lastText: 'Got the puller?' }));
    await assertSucceeds(updateDoc(doc(as('mia'), 'bbsDms', CONV), { lastText: 'Message deleted' }));
    await assertFails(updateDoc(doc(as('mia'), 'bbsDms', CONV), { lastText: 'sneaky plain text' }));
    // Old conversations with a plain preview still take read marks.
    await assertSucceeds(updateDoc(doc(as('carl'), 'bbsDms', CONV), { 'readAt.carl': serverTimestamp() }));
    await assertFails(setDoc(doc(as('mia'), 'bbsDms', 'boss_mia'), { members: ['boss', 'mia'], handles: { mia: 'Mia', boss: 'Boss' }, lastAt: serverTimestamp(), lastText: 'hello', lastBy: 'mia', lastId: '', readAt: { mia: serverTimestamp() }, hidden: {} }));
  });
  test('a photo comes with its sealed bytes in the same batch; only the two read them; the sender deletes them', async () => {
    await assertFails(sendAs('carl', 'Carl', CONV, { photo: { w: 10, h: 10 } }));
    await assertSucceeds(sendAs('carl', 'Carl', CONV, { photo: { w: 10, h: 10 } }, { blob: [1, 2, 3] }));
    const [blob] = (await getDocs(collection(as('mia'), 'bbsDms', CONV, 'blobs'))).docs;
    await assertSucceeds(getDoc(doc(as('carl'), 'bbsDms', CONV, 'blobs', blob.id)));
    for (const uid of ['boss', 'moe', 'pete']) await assertFails(getDoc(doc(as(uid), 'bbsDms', CONV, 'blobs', blob.id)));
    await assertFails(updateDoc(doc(as('carl'), 'bbsDms', CONV, 'blobs', blob.id), { iv: 'CCCCCCCCCCCCCCCC' }));
    await assertFails(deleteDoc(doc(as('mia'), 'bbsDms', CONV, 'blobs', blob.id)));
    await assertSucceeds(deleteDoc(doc(as('carl'), 'bbsDms', CONV, 'blobs', blob.id)));
  });
  test('sealed photos: not too big, as yourself, not for a muted member', async () => {
    await assertFails(sendAs('carl', 'Carl', CONV, { photo: { w: 10, h: 10 } }, { blob: { length: 0 } }));
    await assertFails(sendAs('carl', 'Carl', CONV, { photo: { w: 10, h: 10 } }, { blob: Object.assign([1, 2, 3], { extra: { uid: 'mia' } }) }));
    await seed((db) => setDoc(doc(db, 'bbsDms', 'mia_moe'), { members: ['mia', 'moe'], handles: { mia: 'Mia', moe: 'Moe' }, lastAt: new Date(), lastText: '', lastBy: 'mia', lastId: '', readAt: {}, hidden: {} }));
    await assertFails(setDoc(doc(as('moe'), 'bbsDms', 'mia_moe', 'blobs', 'x'), { uid: 'moe', iv: 'BBBBBBBBBBBBBBBB', data: Bytes.fromUint8Array(new Uint8Array([1])), createdAt: serverTimestamp() }));
  });
});

describe('message locks', () => {
  const X = 'x'.repeat(43), Y = 'y'.repeat(43), KID = '0123456789abcdef';
  const pub = (extra = {}) => ({ x: X, y: Y, kid: KID, at: serverTimestamp(), ...extra });
  const backup = (extra = {}) => ({ kid: KID, v: 1, iter: 600000, salt: 'S'.repeat(24), iv: 'I'.repeat(16), ct: 'C'.repeat(208), at: serverTimestamp(), ...extra });
  test('post your own public lock; every member can read it; nobody else writes it', async () => {
    await assertSucceeds(setDoc(doc(as('mia'), 'bbsKeys', 'mia'), pub()));
    await assertSucceeds(getDoc(doc(as('carl'), 'bbsKeys', 'mia')));
    await assertSucceeds(getDoc(doc(as('boss'), 'bbsKeys', 'mia')));
    await assertFails(getDoc(doc(as('pete'), 'bbsKeys', 'mia')));
    await assertFails(getDoc(doc(guestOf(env)(), 'bbsKeys', 'mia')));
    await assertFails(setDoc(doc(as('carl'), 'bbsKeys', 'mia'), pub()));
    await assertFails(setDoc(doc(as('boss'), 'bbsKeys', 'mia'), pub()));
    await assertFails(setDoc(doc(as('pete'), 'bbsKeys', 'pete'), pub()));
    await assertFails(setDoc(doc(as('mia'), 'bbsKeys', 'mia'), pub({ x: 'short' })));
    await assertFails(setDoc(doc(as('mia'), 'bbsKeys', 'mia'), pub({ d: 'private part' })));
  });
  test('the passphrase-scrambled backup: only you read or write it, not even the sysop', async () => {
    await assertSucceeds(setDoc(doc(as('mia'), 'bbsKeyBackups', 'mia'), backup()));
    await assertSucceeds(getDoc(doc(as('mia'), 'bbsKeyBackups', 'mia')));
    for (const uid of ['boss', 'carl', 'pete']) await assertFails(getDoc(doc(as(uid), 'bbsKeyBackups', 'mia')));
    await assertFails(setDoc(doc(as('boss'), 'bbsKeyBackups', 'mia'), backup()));
    await assertFails(setDoc(doc(as('mia'), 'bbsKeyBackups', 'mia'), backup({ iter: 1000 })));
    await assertFails(setDoc(doc(as('mia'), 'bbsKeyBackups', 'mia'), backup({ passphrase: 'nope' })));
  });
});

describe('private photos (Storage)', { skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST && 'Storage emulator not running' }, () => {
  const st = (uid) => env.authenticatedContext(uid).storage();
  const jpg = new Uint8Array([255, 216, 255]);
  test('upload into your own folder for that conversation; only the two can see it', async () => {
    await assertSucceeds(st('mia').ref(`bbs/dm/mia/${CONV}/a.jpg`).put(jpg, { contentType: 'image/jpeg' }));
    await assertFails(st('mia').ref(`bbs/dm/carl/${CONV}/a.jpg`).put(jpg, { contentType: 'image/jpeg' }));
    await assertFails(st('moe').ref(`bbs/dm/moe/${CONV}/a.jpg`).put(jpg, { contentType: 'image/jpeg' }));
    await assertSucceeds(st('carl').ref(`bbs/dm/mia/${CONV}/a.jpg`).getDownloadURL());
    await assertFails(st('boss').ref(`bbs/dm/mia/${CONV}/a.jpg`).getDownloadURL());
    await assertFails(st('moe').ref(`bbs/dm/mia/${CONV}/a.jpg`).getDownloadURL());
  });
});
