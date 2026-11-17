// BBS part 3 rules: Shop Talk. Members only; send as yourself; muted members read but don't
// send; only the sysop and co-sysops delete; nobody marks a message saved from the page.
// Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocs, serverTimestamp, setDoc, updateDoc, Timestamp } from 'firebase/firestore';
import { startEnv, asOf, guestOf, seed as seedRaw, seedMember } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());
const as = (...a) => asOf(env)(...a);
const seed = (fn) => seedRaw(env, fn);
const member = (handle, role = 'member', extra = {}) => ({ handle, role, since: new Date(), addedBy: 'Boss', lastSeen: null, ...extra });

beforeEach(async () => {
  await env.clearFirestore();
  if (process.env.FIREBASE_STORAGE_EMULATOR_HOST) await env.clearStorage();
  for (const [uid, h] of [['boss', 'Boss'], ['carl', 'Carl'], ['mia', 'Mia'], ['pete', 'Pete'], ['moe', 'Moe']]) await seedMember(env, uid, h);
  await seed(async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    await setDoc(doc(db, 'bbsMembers', 'carl'), member('Carl', 'cosysop'));
    await setDoc(doc(db, 'bbsMembers', 'mia'), member('Mia'));
    await setDoc(doc(db, 'bbsMembers', 'moe'), member('Moe', 'member', { mutedUntil: Timestamp.fromMillis(Date.now() + 3600000) }));
    await setDoc(doc(db, 'bbsChat', 'm1'), { uid: 'mia', handle: 'Mia', kind: 'msg', text: 'Anyone got a flywheel puller?', createdAt: new Date() });
  });
});

const say = (uid, handle, extra = {}) => setDoc(doc(collection(as(uid), 'bbsChat')), { uid, handle, kind: 'msg', text: 'Swing by Saturday', createdAt: serverTimestamp(), ...extra });

describe('Shop Talk', () => {
  test('members read; outsiders and guests don’t', async () => {
    await assertSucceeds(getDocs(collection(as('mia'), 'bbsChat')));
    await assertSucceeds(getDocs(collection(as('boss'), 'bbsChat')));
    await assertFails(getDocs(collection(as('pete'), 'bbsChat')));
    await assertFails(getDocs(collection(guestOf(env)(), 'bbsChat')));
  });
  test('send as yourself, with a photo from your own chat folder, a link, a reply', async () => {
    await assertSucceeds(say('mia', 'Mia'));
    await assertSucceeds(say('boss', 'Boss'));
    await assertSucceeds(say('mia', 'Mia', { text: '', photo: { path: 'bbs/chat/mia/a.jpg', w: 800, h: 600 } }));
    await assertSucceeds(say('mia', 'Mia', { link: 'https://youtube.com/watch?v=x', reply: { who: 'Carl', text: 'the 3-jaw one' } }));
    await assertFails(say('mia', 'Carl'));
    await assertFails(say('pete', 'Pete'));
    await assertFails(say('mia', 'Mia', { text: '   ' }));
    await assertFails(say('mia', 'Mia', { photo: { path: 'bbs/chat/carl/a.jpg', w: 1, h: 1 } }));
    await assertFails(say('mia', 'Mia', { savedTo: { boardId: 'x', threadId: 'y' } }));
  });
  test('"walked into the shop" lines carry no text', async () => {
    await assertSucceeds(say('mia', 'Mia', { kind: 'join', text: '' }));
    await assertFails(say('mia', 'Mia', { kind: 'join', text: 'hi' }));
  });
  test('a muted member reads but can’t send or type; mute over = can again', async () => {
    await assertSucceeds(getDocs(collection(as('moe'), 'bbsChat')));
    await assertFails(say('moe', 'Moe'));
    await assertFails(setDoc(doc(as('moe'), 'bbsTyping', 'moe'), { handle: 'Moe', at: serverTimestamp() }));
    await seed((db) => updateDoc(doc(db, 'bbsMembers', 'moe'), { mutedUntil: Timestamp.fromMillis(Date.now() - 1000) }));
    await assertSucceeds(say('moe', 'Moe'));
  });
  test('only the sysop and co-sysops delete messages; nobody edits them', async () => {
    await assertFails(deleteDoc(doc(as('mia'), 'bbsChat', 'm1')));
    await assertFails(updateDoc(doc(as('mia'), 'bbsChat', 'm1'), { text: 'changed' }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsChat', 'm1'), { savedTo: { boardId: 'b', threadId: 't', by: 'Carl' } }));
    await assertSucceeds(deleteDoc(doc(as('carl'), 'bbsChat', 'm1')));
  });
  test('typing: as yourself only', async () => {
    await assertSucceeds(setDoc(doc(as('mia'), 'bbsTyping', 'mia'), { handle: 'Mia', at: serverTimestamp() }));
    await assertFails(setDoc(doc(as('mia'), 'bbsTyping', 'carl'), { handle: 'Carl', at: serverTimestamp() }));
    await assertFails(setDoc(doc(as('pete'), 'bbsTyping', 'pete'), { handle: 'Pete', at: serverTimestamp() }));
    await assertSucceeds(getDocs(collection(as('carl'), 'bbsTyping')));
  });
});

describe('chat photos (Storage)', { skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST && 'Storage emulator not running' }, () => {
  const st = (uid) => env.authenticatedContext(uid).storage();
  const jpg = new Uint8Array([255, 216, 255]);
  test('members upload images to their own chat folder; members read; muted can still read', async () => {
    await assertSucceeds(st('mia').ref('bbs/chat/mia/a.jpg').put(jpg, { contentType: 'image/jpeg' }));
    await assertFails(st('mia').ref('bbs/chat/carl/a.jpg').put(jpg, { contentType: 'image/jpeg' }));
    await assertFails(st('pete').ref('bbs/chat/pete/a.jpg').put(jpg, { contentType: 'image/jpeg' }));
    await assertSucceeds(st('moe').ref('bbs/chat/mia/a.jpg').getDownloadURL());
    await assertFails(st('pete').ref('bbs/chat/mia/a.jpg').getDownloadURL());
  });
});
