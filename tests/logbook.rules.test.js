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

  test('only the three kinds of data, with simple IDs', async () => {
    const db = as('bob');
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'other', 'x1'), part));
    await assertFails(getDocs(collection(db, 'logbook', 'bob', 'other')));
    await assertFails(setDoc(doc(db, 'logbook', 'bob'), { a: 1 }));
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'records', 'x'.repeat(65)), part));
    await assertFails(setDoc(doc(db, 'logbook', 'bob', 'records', 'r1', 'deeper', 'd1'), part));
  });
});
