// Logbook + Project Tracker rules tests: each member's records, projects and
// tracker settings are private.
// Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, collectionGroup, setDoc, deleteDoc } from 'firebase/firestore';
import { startEnv, guestOf, asOf, seed as seedRaw, seedMember } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());

const guest = () => guestOf(env)();
const as = (...a) => asOf(env)(...a);
const engine = { kind: 'engine', name: 'Back yard mower', equipment: 'Push mower', log: [], updatedAt: '2026-11-13T00:00:00Z' };
const part = { kind: 'part', name: 'Oil filter', number: 'FL-500S', qty: '2', reorderAt: '1' };
const job = { name: 'Brake job', status: 'In progress', tasks: [] };
const PARTS = [['records', 'r1', engine], ['projects', 'p1', job], ['trackerSettings', 'shop', { name: 'My shop' }]];

beforeEach(async () => {
  await env.clearFirestore();
  await seedMember(env, 'bob', 'Bob');
  await seedMember(env, 'boss', 'Boss');
  await seedRaw(env, async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    for (const [name, id, data] of PARTS) await setDoc(doc(db, 'logbook', 'bob', name, id), data);
  });
});

describe('Logbook + Project Tracker', () => {
  test('a member can save, read, list and delete their own records, projects and settings', async () => {
    const db = as('bob');
    await assertSucceeds(setDoc(doc(db, 'logbook', 'bob', 'records', 'r2'), part));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'bob', 'records', 'r2'), { qty: '3' }, { merge: true }));
    for (const [name, id, data] of PARTS) {
      await assertSucceeds(setDoc(doc(db, 'logbook', 'bob', name, id), data));
      await assertSucceeds(getDoc(doc(db, 'logbook', 'bob', name, id)));
      await assertSucceeds(getDocs(collection(db, 'logbook', 'bob', name)));
      await assertSucceeds(deleteDoc(doc(db, 'logbook', 'bob', name, id)));
    }
  });

  test('a member can use them without a forum handle', async () => {
    const db = as('newbie'); // signed in with Google, never picked a handle
    await assertSucceeds(setDoc(doc(db, 'logbook', 'newbie', 'records', 'r1'), engine));
    await assertSucceeds(getDocs(collection(db, 'logbook', 'newbie', 'records')));
  });

  test('nobody else can read or change them: guests, other members, the sysop', async () => {
    for (const db of [guest(), as('mallory'), as('boss')]) {
      for (const [name, id, data] of PARTS) {
        await assertFails(getDoc(doc(db, 'logbook', 'bob', name, id)));
        await assertFails(getDocs(collection(db, 'logbook', 'bob', name)));
        await assertFails(setDoc(doc(db, 'logbook', 'bob', name, 'x1'), data));
        await assertFails(deleteDoc(doc(db, 'logbook', 'bob', name, id)));
      }
      await assertFails(getDocs(collectionGroup(db, 'records')));
    }
  });

  test('receipts: the member can add, read and delete their own; nobody else can', async () => {
    const rc = { partId: 'r2', name: 'receipt.png', type: 'image', data: 'data:image/jpeg;base64,AAAA', size: 27, createdAt: '2026-11-18T00:00:00Z' };
    const db = as('bob');
    await assertSucceeds(setDoc(doc(db, 'logbook', 'bob', 'receipts', 'c1'), rc));
    await assertSucceeds(getDoc(doc(db, 'logbook', 'bob', 'receipts', 'c1')));
    await assertSucceeds(setDoc(doc(db, 'logbook', 'bob', 'receipts', 'c2'), { ...rc, type: 'pdf', data: 'data:application/pdf;base64,AAAA' }));
    for (const other of [guest(), as('mallory'), as('boss')]) {
      await assertFails(getDoc(doc(other, 'logbook', 'bob', 'receipts', 'c1')));
      await assertFails(getDocs(collection(other, 'logbook', 'bob', 'receipts')));
      await assertFails(setDoc(doc(other, 'logbook', 'bob', 'receipts', 'c3'), rc));
      await assertFails(deleteDoc(doc(other, 'logbook', 'bob', 'receipts', 'c1')));
    }
    // only the receipt fields, a known type, and under the 1 MiB doc limit
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'receipts', 'c4'), { ...rc, extra: 1 }));
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'receipts', 'c4'), { ...rc, type: 'exe' }));
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'receipts', 'c4'), { ...rc, data: 'x'.repeat(1000001) }));
    await assertSucceeds(deleteDoc(doc(db, 'logbook', 'bob', 'receipts', 'c1')));
  });

  test('only the known kinds of data, with simple IDs', async () => {
    const db = as('bob');
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'other', 'x1'), part));
    await assertFails(getDocs(collection(db, 'logbook', 'bob', 'other')));
    await assertFails(setDoc(doc(db, 'logbook', 'bob'), { a: 1 }));
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'records', 'x'.repeat(65)), part));
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'records', 'r1', 'deeper', 'd1'), part));
  });
});
