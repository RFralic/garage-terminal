// Home Projects rules tests: each member's projects and photos are private.
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
const project = { name: 'Bathroom remodel', room: 'Bathroom', status: 'Planning', tasks: [], photos: [] };
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const hasStorage = !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;

beforeEach(async () => {
  await env.clearFirestore();
  if (hasStorage) await env.clearStorage();
  await seedMember(env, 'bob', 'Bob');
  await seedMember(env, 'boss', 'Boss');
  await seedRaw(env, async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    await setDoc(doc(db, 'homeprojects', 'bob', 'projects', 'p1'), project);
  });
});

describe('Home Projects: projects', () => {
  test('a member can save, read, list and delete their own projects', async () => {
    const db = as('bob');
    await assertSucceeds(setDoc(doc(db, 'homeprojects', 'bob', 'projects', 'p2'), project));
    await assertSucceeds(getDoc(doc(db, 'homeprojects', 'bob', 'projects', 'p1')));
    await assertSucceeds(getDocs(collection(db, 'homeprojects', 'bob', 'projects')));
    await assertSucceeds(deleteDoc(doc(db, 'homeprojects', 'bob', 'projects', 'p1')));
  });

  test('nobody else can read or change them: guests, other members, the sysop', async () => {
    for (const db of [guest(), as('mallory'), as('boss')]) {
      await assertFails(getDoc(doc(db, 'homeprojects', 'bob', 'projects', 'p1')));
      await assertFails(getDocs(collection(db, 'homeprojects', 'bob', 'projects')));
      await assertFails(getDocs(collectionGroup(db, 'projects')));
      await assertFails(setDoc(doc(db, 'homeprojects', 'bob', 'projects', 'p3'), project));
      await assertFails(deleteDoc(doc(db, 'homeprojects', 'bob', 'projects', 'p1')));
    }
  });

  test('project IDs must be simple', async () => {
    await assertFails(setDoc(doc(as('bob'), 'homeprojects', 'bob', 'projects', 'x'.repeat(65)), project));
  });
});

describe('Home Projects: photos (Storage)', { skip: !hasStorage && 'Storage emulator not running' }, () => {
  const photo = (uid, ctx) => ctx.ref(`homeprojects/${uid}/photos/ph1`);
  test('a member can upload, view and delete their own photos', async () => {
    const st = env.authenticatedContext('bob').storage();
    await assertSucceeds(photo('bob', st).put(JPG, { contentType: 'image/jpeg' }));
    await assertSucceeds(photo('bob', st).getDownloadURL());
    await assertSucceeds(photo('bob', st).delete());
  });

  test('nobody else can view, add or delete them', async () => {
    await env.withSecurityRulesDisabled((ctx) => ctx.storage().ref('homeprojects/bob/photos/ph1').put(JPG, { contentType: 'image/jpeg' }));
    for (const st of [env.unauthenticatedContext().storage(), env.authenticatedContext('mallory').storage(), env.authenticatedContext('boss').storage()]) {
      await assertFails(photo('bob', st).getDownloadURL());
      await assertFails(st.ref('homeprojects/bob/photos/ph2').put(JPG, { contentType: 'image/jpeg' }));
      await assertFails(photo('bob', st).delete());
    }
  });

  test('only images, up to 10 MB', async () => {
    const st = env.authenticatedContext('bob').storage();
    await assertFails(st.ref('homeprojects/bob/photos/doc1').put(JPG, { contentType: 'application/pdf' }));
    await assertFails(st.ref('homeprojects/bob/photos/big').put(new Uint8Array(10 * 1024 * 1024 + 1), { contentType: 'image/jpeg' }));
  });
});
