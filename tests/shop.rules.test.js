// Shared shop (employees) rules tests: who can join an owner's shop, and what each
// role can do with the owner's Logbook + Job_Board data (logbook/{owner}/...).
// Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { startEnv, guestOf, asOf, seed } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());

const guest = () => guestOf(env)();
const as = (...a) => asOf(env)(...a);

const TECH = { prices: false, phones: false, inventory: false, settings: false, deleteJobs: false, approveTime: false };
const ALL = { prices: true, phones: true, inventory: true, settings: true, deleteJobs: true, approveTime: true };
const invite = (memberId, role, perms) => ({ owner: 'ryan', ownerName: 'Ryan', shopName: "Ryan's Small Engine", memberId, name: memberId === 'm1' ? 'Jake' : 'Mia', role, perms });
const joinDoc = (email, memberId, role, perms) => ({ email, name: 'Me', role, perms, memberId, joinedAt: serverTimestamp() });

const engine = { kind: 'engine', name: 'Back yard mower', log: [] };
const part = { kind: 'part', name: 'Oil filter', number: 'FL-500S', qty: '2' };
const job = { title: 'Brake job', kind: 'customer', status: 'In progress', tasks: [] };

beforeEach(async () => {
  await env.clearFirestore();
  await seed(env, async (db) => {
    await setDoc(doc(db, 'logbook', 'ryan', 'records', 'e1'), engine);
    await setDoc(doc(db, 'logbook', 'ryan', 'records', 'p1'), part);
    await setDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1'), job);
    await setDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'shop'), { name: "Ryan's Small Engine", rate: 65 });
    await setDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'team'), { on: true, members: [] });
    await setDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'customers'), { list: [] });
    await setDoc(doc(db, 'shops', 'ryan'), { on: true, name: "Ryan's Small Engine" });
    await setDoc(doc(db, 'shopInvites', 'jake@example.com'), invite('m1', 'tech', TECH));
    await setDoc(doc(db, 'shopInvites', 'mia@example.com'), invite('m2', 'manager', ALL));
  });
});

const join = (uid, email, memberId, role, perms) => setDoc(doc(as(uid, email), 'shops', 'ryan', 'members', uid), joinDoc(email, memberId, role, perms));
async function joined(uid, email, memberId, role, perms) {
  await seed(env, (db) => setDoc(doc(db, 'shops', 'ryan', 'members', uid), { email, name: 'Me', role, perms, memberId, joinedAt: new Date() }));
}

describe('shop invites', () => {
  test('only the owner and the invited email can read an invite', async () => {
    await assertSucceeds(getDoc(doc(as('ryan'), 'shopInvites', 'jake@example.com')));
    await assertSucceeds(getDoc(doc(as('jake', 'jake@example.com'), 'shopInvites', 'jake@example.com')));
    await assertSucceeds(getDoc(doc(as('jake', 'Jake@Example.com'), 'shopInvites', 'jake@example.com')));
    await assertFails(getDoc(doc(as('mallory'), 'shopInvites', 'jake@example.com')));
    await assertFails(getDoc(doc(guest(), 'shopInvites', 'jake@example.com')));
  });

  test("an owner can invite; nobody can take over someone else's invite", async () => {
    await assertSucceeds(setDoc(doc(as('ryan'), 'shopInvites', 'new@example.com'), invite('m3', 'counter', { ...TECH, prices: true, phones: true })));
    await assertFails(setDoc(doc(as('mallory'), 'shopInvites', 'jake@example.com'), { ...invite('m1', 'manager', ALL), owner: 'mallory' }));
    await assertFails(setDoc(doc(as('mallory'), 'shopInvites', 'x@example.com'), invite('m1', 'tech', TECH))); // owner must be yourself
    await assertFails(setDoc(doc(as('ryan'), 'shopInvites', 'Upper@Example.com'), invite('m4', 'tech', TECH))); // lower case only
    await assertFails(setDoc(doc(as('ryan'), 'shopInvites', 'z@example.com'), invite('m5', 'boss', TECH))); // no such role
    await assertFails(deleteDoc(doc(as('mallory'), 'shopInvites', 'jake@example.com')));
    await assertSucceeds(deleteDoc(doc(as('ryan'), 'shopInvites', 'jake@example.com')));
  });
});

describe('joining a shop', () => {
  test('the invited account joins by copying its invite exactly', async () => {
    await assertFails(join('jake', 'jake@example.com', 'm1', 'manager', TECH)); // role must match
    await assertFails(join('jake', 'jake@example.com', 'm1', 'tech', ALL)); // permissions must match
    await assertFails(join('jake', 'jake@example.com', 'm2', 'tech', TECH)); // memberId must match
    await assertSucceeds(join('jake', 'jake@example.com', 'm1', 'tech', TECH));
  });

  test('nobody else can join', async () => {
    await assertFails(join('mallory', 'mallory@example.com', 'm1', 'tech', TECH));
    await assertFails(setDoc(doc(as('mallory', 'jake@example.com'), 'shops', 'ryan', 'members', 'jake'), joinDoc('jake@example.com', 'm1', 'tech', TECH))); // someone else's uid
    const unverified = env.authenticatedContext('jake', { email: 'jake@example.com', email_verified: false }).firestore();
    await assertFails(setDoc(doc(unverified, 'shops', 'ryan', 'members', 'jake'), joinDoc('jake@example.com', 'm1', 'tech', TECH)));
    await assertFails(setDoc(doc(as('ryan'), 'shops', 'ryan', 'members', 'ryan'), joinDoc('ryan@example.com', 'm1', 'tech', TECH)));
  });

  test("a member can't change their own role; the owner can", async () => {
    await joined('jake', 'jake@example.com', 'm1', 'tech', TECH);
    await assertFails(updateDoc(doc(as('jake', 'jake@example.com'), 'shops', 'ryan', 'members', 'jake'), { role: 'manager', perms: ALL }));
    await assertSucceeds(updateDoc(doc(as('ryan'), 'shops', 'ryan', 'members', 'jake'), { role: 'manager', perms: ALL }));
  });

  test('a member can leave; the owner can remove them', async () => {
    await joined('jake', 'jake@example.com', 'm1', 'tech', TECH);
    await joined('mia', 'mia@example.com', 'm2', 'manager', ALL);
    await assertFails(deleteDoc(doc(as('mallory'), 'shops', 'ryan', 'members', 'jake')));
    await assertSucceeds(deleteDoc(doc(as('jake', 'jake@example.com'), 'shops', 'ryan', 'members', 'jake')));
    await assertSucceeds(deleteDoc(doc(as('ryan'), 'shops', 'ryan', 'members', 'mia')));
  });

  test('only the owner can switch Employees on or off', async () => {
    await joined('mia', 'mia@example.com', 'm2', 'manager', ALL);
    await assertFails(setDoc(doc(as('mia', 'mia@example.com'), 'shops', 'ryan'), { on: false, name: 'x' }));
    await assertSucceeds(setDoc(doc(as('ryan'), 'shops', 'ryan'), { on: false, name: "Ryan's Small Engine" }));
  });
});

describe("a member using the owner's data", () => {
  test('before joining: nothing', async () => {
    const db = as('jake', 'jake@example.com');
    await assertFails(getDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1')));
    await assertFails(getDocs(collection(db, 'logbook', 'ryan', 'records')));
  });

  test('a Tech reads the shop and works jobs, but not settings or inventory', async () => {
    await joined('jake', 'jake@example.com', 'm1', 'tech', TECH);
    const db = as('jake', 'jake@example.com');
    await assertSucceeds(getDocs(collection(db, 'logbook', 'ryan', 'records')));
    await assertSucceeds(getDocs(collection(db, 'logbook', 'ryan', 'projects')));
    await assertSucceeds(getDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'shop')));
    await assertSucceeds(getDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'customers')));
    await assertFails(getDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'team')));
    // jobs
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1'), { ...job, status: 'Done' }));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'projects', 'j2'), job));
    await assertFails(deleteDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1')));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'counter'), { lastJobNo: 5 }));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'customers'), { list: [] }));
    await assertFails(setDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'shop'), { name: 'Hacked', rate: 1 }));
    await assertFails(setDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'team'), { on: false }));
    // machines yes, inventory only the count
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'records', 'e2'), engine));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'records', 'e1'), { ...engine, log: [{ date: '2026-11-25' }] }));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'records', 'p1'), { qty: '1', updatedAt: 'now' }, { merge: true }));
    await assertFails(setDoc(doc(db, 'logbook', 'ryan', 'records', 'p1'), { name: 'Renamed' }, { merge: true }));
    await assertFails(setDoc(doc(db, 'logbook', 'ryan', 'records', 'p2'), part));
    await assertFails(setDoc(doc(db, 'logbook', 'ryan', 'records', 'e1'), { ...engine, kind: 'part' })); // can't turn a machine into a part
    await assertFails(deleteDoc(doc(db, 'logbook', 'ryan', 'records', 'p1')));
  });

  test('deleting jobs follows the deleteJobs permission, whatever the role', async () => {
    await joined('jake', 'jake@example.com', 'm1', 'tech', { ...TECH, deleteJobs: true });
    await joined('mia', 'mia@example.com', 'm2', 'manager', { ...ALL, deleteJobs: false });
    await assertFails(deleteDoc(doc(as('mia', 'mia@example.com'), 'logbook', 'ryan', 'projects', 'j1')));
    await assertSucceeds(deleteDoc(doc(as('jake', 'jake@example.com'), 'logbook', 'ryan', 'projects', 'j1')));
  });

  test("an invite can't carry unknown permissions", async () => {
    await assertFails(setDoc(doc(as('ryan'), 'shopInvites', 'q@example.com'), invite('m6', 'tech', { ...TECH, everything: true })));
    await assertSucceeds(setDoc(doc(as('ryan'), 'shopInvites', 'q@example.com'), invite('m6', 'tech', { prices: false, phones: false, inventory: false, settings: false })));
  });

  test('a Manager can delete jobs, edit inventory and change shop info', async () => {
    await joined('mia', 'mia@example.com', 'm2', 'manager', ALL);
    const db = as('mia', 'mia@example.com');
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'records', 'p2'), part));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'records', 'p1'), { name: 'Renamed' }, { merge: true }));
    await assertSucceeds(deleteDoc(doc(db, 'logbook', 'ryan', 'records', 'p2')));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'shop'), { name: "Ryan's Small Engine", rate: 70 }));
    await assertSucceeds(deleteDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1')));
    await assertFails(getDoc(doc(db, 'logbook', 'ryan', 'trackerSettings', 'team')));
  });

  test('Employees switched off or the member removed: access stops', async () => {
    await joined('jake', 'jake@example.com', 'm1', 'tech', TECH);
    const db = as('jake', 'jake@example.com');
    await assertSucceeds(getDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1')));
    await seed(env, (s) => setDoc(doc(s, 'shops', 'ryan'), { on: false, name: 'x' }));
    await assertFails(getDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1')));
    await seed(env, (s) => setDoc(doc(s, 'shops', 'ryan'), { on: true, name: 'x' }));
    await assertSucceeds(getDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1')));
    await seed(env, (s) => deleteDoc(doc(s, 'shops', 'ryan', 'members', 'jake')));
    await assertFails(getDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1')));
  });

  test("strangers and other shops' members still see nothing", async () => {
    await joined('jake', 'jake@example.com', 'm1', 'tech', TECH);
    for (const db of [guest(), as('mallory')]) {
      await assertFails(getDoc(doc(db, 'logbook', 'ryan', 'projects', 'j1')));
      await assertFails(getDoc(doc(db, 'shops', 'ryan')));
      await assertFails(setDoc(doc(db, 'logbook', 'ryan', 'projects', 'j9'), job));
    }
    // jake belongs to ryan's shop only, not to mallory's data
    await seed(env, (s) => setDoc(doc(s, 'logbook', 'mallory', 'projects', 'x'), job));
    await assertFails(getDoc(doc(as('jake', 'jake@example.com'), 'logbook', 'mallory', 'projects', 'x')));
  });
});
