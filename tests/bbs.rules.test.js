// BBS rules tests: who can read the door settings, ask to join, and see who's in.
// (The member list itself is changed only by the `bbs` Cloud Function; see
// tests/bbs.functions.test.js.)  Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { startEnv, guestOf, asOf, seed as seedRaw, seedMember as seedMemberRaw } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await seedMember('boss', 'Boss');
  await seedMember('carl', 'Carl'); // co-sysop
  await seedMember('mia', 'Mia'); // member
  await seedMember('pete', 'Pete'); // site account, not in the BBS
  await seed(async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    await setDoc(doc(db, 'bbsConfig', 'main'), { doorWord: 'backroom', requirePasscode: false, notice: '' });
    await setDoc(doc(db, 'bbsMembers', 'carl'), { handle: 'Carl', role: 'cosysop', since: new Date(), addedBy: 'Boss', lastSeen: null });
    await setDoc(doc(db, 'bbsMembers', 'mia'), { handle: 'Mia', role: 'member', since: new Date(), addedBy: 'Boss', lastSeen: null });
  });
});

const guest = () => guestOf(env)();
const as = (...a) => asOf(env)(...a);
const seed = (fn) => seedRaw(env, fn);
const seedMember = (uid, handle) => seedMemberRaw(env, uid, handle);
const ask = (db, uid, handle) => setDoc(doc(db, 'bbsRequests', uid), { handle, createdAt: serverTimestamp() });

describe('the door', () => {
  test('anyone, even signed out, can read the door word', async () => {
    await assertSucceeds(getDoc(doc(guest(), 'bbsConfig', 'main')));
  });
  test('nobody can change it from the page, not even the sysop', async () => {
    await assertFails(setDoc(doc(as('boss'), 'bbsConfig', 'main'), { doorWord: 'x', requirePasscode: false, notice: '' }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsConfig', 'main'), { notice: 'hi' }));
  });
});

describe('asking to join', () => {
  test('a site account with a handle can ask, once, with its own handle', async () => {
    await assertSucceeds(ask(as('pete'), 'pete', 'Pete'));
    await assertFails(ask(as('pete'), 'pete', 'Pete')); // a second request is an update: refused
  });
  test('only for yourself, with your real handle, and not without a handle', async () => {
    await assertFails(ask(as('pete'), 'zed', 'Pete'));
    await assertFails(ask(as('pete'), 'pete', 'Boss'));
    await assertFails(ask(as('nohandle'), 'nohandle', 'Nobody'));
    await assertFails(ask(guest(), 'pete', 'Pete'));
  });
  test('members can’t ask', async () => {
    await assertFails(ask(as('mia'), 'mia', 'Mia'));
  });
  test('a denied account must wait 30 days (unless the wait is over)', async () => {
    await seed((db) => setDoc(doc(db, 'bbsDenied', 'pete'), { handle: 'Pete', at: new Date(), until: Timestamp.fromMillis(Date.now() + 86400000), by: 'Boss' }));
    await assertFails(ask(as('pete'), 'pete', 'Pete'));
    await seed((db) => setDoc(doc(db, 'bbsDenied', 'pete'), { handle: 'Pete', at: new Date(), until: Timestamp.fromMillis(Date.now() - 1000), by: 'Boss' }));
    await assertSucceeds(ask(as('pete'), 'pete', 'Pete'));
  });
  test('with the passcode switched on, requests come only from the passcode check', async () => {
    await seed((db) => setDoc(doc(db, 'bbsConfig', 'main'), { doorWord: 'backroom', requirePasscode: true, notice: '' }));
    await assertFails(ask(as('pete'), 'pete', 'Pete'));
  });
  test('a pending person sees only their own request, and can take it back', async () => {
    await ask(as('pete'), 'pete', 'Pete');
    await assertSucceeds(getDoc(doc(as('pete'), 'bbsRequests', 'pete')));
    await assertFails(getDocs(collection(as('pete'), 'bbsRequests')));
    await assertFails(getDoc(doc(as('mia'), 'bbsRequests', 'pete'))); // plain members don't see requests
    await assertFails(getDocs(collection(as('pete'), 'bbsMembers'))); // nor the crew
    await assertFails(deleteDoc(doc(as('mia'), 'bbsRequests', 'pete')));
    await assertSucceeds(deleteDoc(doc(as('pete'), 'bbsRequests', 'pete')));
  });
  test('the sysop and co-sysops can list requests', async () => {
    await ask(as('pete'), 'pete', 'Pete');
    await assertSucceeds(getDocs(collection(as('boss'), 'bbsRequests')));
    await assertSucceeds(getDocs(collection(as('carl'), 'bbsRequests')));
  });
});

describe('the member list', () => {
  test('members and the sysop see the crew; others don’t', async () => {
    await assertSucceeds(getDocs(collection(as('mia'), 'bbsMembers')));
    await assertSucceeds(getDocs(collection(as('boss'), 'bbsMembers')));
    await assertFails(getDocs(collection(as('pete'), 'bbsMembers')));
    await assertFails(getDocs(collection(guest(), 'bbsMembers')));
  });
  test('anyone signed in can check their own doc (the page asks "am I in?")', async () => {
    await assertSucceeds(getDoc(doc(as('pete'), 'bbsMembers', 'pete')));
  });
  test('nobody can add, change or remove members from the page; only "last seen" on yourself', async () => {
    await assertFails(setDoc(doc(as('pete'), 'bbsMembers', 'pete'), { handle: 'Pete', role: 'member' }));
    await assertFails(setDoc(doc(as('boss'), 'bbsMembers', 'pete'), { handle: 'Pete', role: 'member' }));
    await assertFails(updateDoc(doc(as('mia'), 'bbsMembers', 'mia'), { role: 'cosysop' }));
    await assertFails(updateDoc(doc(as('carl'), 'bbsMembers', 'mia'), { role: 'cosysop' }));
    await assertFails(deleteDoc(doc(as('carl'), 'bbsMembers', 'mia')));
    await assertFails(updateDoc(doc(as('mia'), 'bbsMembers', 'carl'), { lastSeen: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(as('mia'), 'bbsMembers', 'mia'), { lastSeen: serverTimestamp() }));
  });
  test('a removed member is cut off at once', async () => {
    await seed((db) => deleteDoc(doc(db, 'bbsMembers', 'mia')));
    await assertFails(getDocs(collection(as('mia'), 'bbsMembers')));
  });
  test('denied and removed lists: sysop and co-sysops only (a denied person sees their own)', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'bbsDenied', 'pete'), { handle: 'Pete', at: new Date(), until: new Date(Date.now() + 1e9), by: 'Boss' });
      await setDoc(doc(db, 'bbsRemoved', 'zed'), { handle: 'Zed', at: new Date(), by: 'Boss' });
    });
    await assertSucceeds(getDoc(doc(as('pete'), 'bbsDenied', 'pete')));
    await assertFails(getDocs(collection(as('pete'), 'bbsDenied')));
    await assertFails(getDocs(collection(as('mia'), 'bbsDenied')));
    await assertFails(getDocs(collection(as('mia'), 'bbsRemoved')));
    await assertSucceeds(getDocs(collection(as('carl'), 'bbsDenied')));
    await assertSucceeds(getDocs(collection(as('carl'), 'bbsRemoved')));
    await assertFails(setDoc(doc(as('carl'), 'bbsDenied', 'mia'), { handle: 'Mia' }));
    await assertFails(getDoc(doc(as('pete'), 'bbsKnocks', 'pete')));
  });
});
