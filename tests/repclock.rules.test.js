// RepClock rules tests: each member's workouts are private to them.
// Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, collectionGroup, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { startEnv, guestOf, asOf, seed as seedRaw, seedMember as seedMemberRaw } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());

const guest = () => guestOf(env)();
const as = (...a) => asOf(env)(...a);
const seed = (fn) => seedRaw(env, fn);

const settings = (extra = {}) => ({
  settings: { cfg: '{"work":40}', goals: '{}', theme: '"original"', muted: 'false' }, updatedAt: serverTimestamp(), ...extra,
});
const workout = (extra = {}) => ({ json: '{"id":1731000000000,"reps":[[10]]}', date: '2026-11-10T12:00:00.000Z', updatedAt: serverTimestamp(), ...extra });

beforeEach(async () => {
  await env.clearFirestore();
  await seedMemberRaw(env, 'bob', 'Bob');
  await seedMemberRaw(env, 'boss', 'Boss');
  await seed(async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    await setDoc(doc(db, 'repclock', 'bob'), { settings: { cfg: '{}' }, updatedAt: new Date() });
    await setDoc(doc(db, 'repclock', 'bob', 'workouts', '1731000000000'), { json: '{}', date: 'x', updatedAt: new Date() });
  });
});

describe('RepClock data', () => {
  test('a member can save, read and delete their own settings and workouts', async () => {
    const db = as('bob');
    await assertSucceeds(setDoc(doc(db, 'repclock', 'bob'), settings()));
    await assertSucceeds(setDoc(doc(db, 'repclock', 'bob', 'workouts', '1731000000001'), workout()));
    await assertSucceeds(getDoc(doc(db, 'repclock', 'bob')));
    await assertSucceeds(getDocs(collection(db, 'repclock', 'bob', 'workouts')));
    await assertSucceeds(deleteDoc(doc(db, 'repclock', 'bob', 'workouts', '1731000000000')));
  });

  test('a signed-in user without a handle yet can still use their own RepClock data', async () => {
    await assertSucceeds(setDoc(doc(as('newbie'), 'repclock', 'newbie'), settings()));
  });

  test('nobody else can read or change a member’s workouts: guests, other members, the sysop', async () => {
    for (const db of [guest(), as('mallory'), as('boss')]) {
      await assertFails(getDoc(doc(db, 'repclock', 'bob')));
      await assertFails(getDocs(collection(db, 'repclock', 'bob', 'workouts')));
      await assertFails(getDocs(collectionGroup(db, 'workouts')));
      await assertFails(setDoc(doc(db, 'repclock', 'bob'), settings()));
      await assertFails(setDoc(doc(db, 'repclock', 'bob', 'workouts', '1731000000002'), workout()));
      await assertFails(deleteDoc(doc(db, 'repclock', 'bob', 'workouts', '1731000000000')));
    }
  });

  test('settings must be the known RepClock fields, as text, within size limits', async () => {
    const db = as('bob');
    await assertFails(setDoc(doc(db, 'repclock', 'bob'), settings({ extra: 1 })));
    await assertFails(setDoc(doc(db, 'repclock', 'bob'), { settings: { cfg: '{}', isSysop: 'true' }, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db, 'repclock', 'bob'), { settings: { cfg: { work: 40 } }, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db, 'repclock', 'bob'), { settings: { cfg: 'x'.repeat(20001) }, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db, 'repclock', 'bob'), { settings: {}, updatedAt: new Date(0) }));
  });

  test('workouts must have a numeric ID, known fields, and a size limit', async () => {
    const db = as('bob');
    await assertFails(setDoc(doc(db, 'repclock', 'bob', 'workouts', 'abc'), workout()));
    await assertFails(setDoc(doc(db, 'repclock', 'bob', 'workouts', '1731000000003'), workout({ extra: 1 })));
    await assertFails(setDoc(doc(db, 'repclock', 'bob', 'workouts', '1731000000004'), workout({ json: 'x'.repeat(50001) })));
  });
});
