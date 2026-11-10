// Firestore rules tests (Node's built-in test runner). Run with:  npm run test:rules
// (starts the Firestore emulator on this computer; never touches the real database)
//
// Each test acts as a guest, a member, or the sysop and checks the rules
// allow or block exactly what PLAN.md says.

import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp } from 'firebase/firestore';

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-garage-terminal',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

// ---------- helpers ----------------------------------------------------------

const guest = () => env.unauthenticatedContext().firestore();
const as = (uid, email = `${uid}@example.com`) =>
  env.authenticatedContext(uid, { email, email_verified: true }).firestore();

/** The same three writes the /join page makes when claiming a handle. */
function claim(db, uid, handle, { email = `${uid}@example.com`, extra = {}, handleId } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'handles', handleId ?? handle.toLowerCase()), { uid });
  b.set(doc(db, 'users', uid), { handle, createdAt: serverTimestamp(), status: 'active', postCount: 0, ...extra });
  b.set(doc(db, 'private', uid), { email });
  return b.commit();
}

/** Seed data directly, bypassing rules (like the console or a Cloud Function). */
async function seed(fn) {
  await env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));
}
async function seedMember(uid, handle) {
  await seed(async (db) => {
    await setDoc(doc(db, 'users', uid), { handle, createdAt: new Date(), status: 'active', postCount: 0 });
    await setDoc(doc(db, 'handles', handle.toLowerCase()), { uid });
    await setDoc(doc(db, 'private', uid), { email: `${uid}@example.com` });
  });
}

// ---------- claiming a handle ------------------------------------------------

describe('claiming a handle', () => {
  test('a signed-in user can claim a free handle', async () => {
    await assertSucceeds(claim(as('ryan'), 'ryan', 'Ryan_F'));
  });

  test('a guest cannot claim a handle', async () => {
    await assertFails(claim(guest(), 'ryan', 'Ryan_F'));
  });

  test('a second account cannot take the same handle (any capitals)', async () => {
    await seedMember('ryan', 'Ryan_F');
    await assertFails(claim(as('other'), 'other', 'Ryan_F'));
    await assertFails(claim(as('other'), 'other', 'ryan_f'));
    await assertFails(claim(as('other'), 'other', 'RYAN_F'));
  });

  test('a member cannot claim a second handle', async () => {
    await seedMember('ryan', 'Ryan_F');
    await assertFails(claim(as('ryan'), 'ryan', 'AnotherName'));
  });

  for (const h of ['ab', 'a'.repeat(21), 'has space', 'dash-y', 'émile', 'semi;colon']) {
    test(`bad format is rejected: ${h}`, async () => {
      await assertFails(claim(as('u1'), 'u1', h));
    });
  }

  for (const h of ['sysop', 'SysOp', 'admin', 'Moderator', 'GARAGE', 'terminal']) {
    test(`reserved handle is rejected: ${h}`, async () => {
      await assertFails(claim(as('u1'), 'u1', h));
    });
  }

  test('the handle reservation must be lowercase and match the profile', async () => {
    await assertFails(claim(as('u1'), 'u1', 'Gearhead', { handleId: 'Gearhead' }));
    await assertFails(claim(as('u1'), 'u1', 'Gearhead', { handleId: 'someoneelse' }));
  });

  test('cannot claim a handle on behalf of someone else', async () => {
    const db = as('mallory');
    const b = writeBatch(db);
    b.set(doc(db, 'handles', 'victim'), { uid: 'victim' });
    b.set(doc(db, 'users', 'victim'), { handle: 'victim', createdAt: serverTimestamp(), status: 'active', postCount: 0 });
    b.set(doc(db, 'private', 'victim'), { email: 'mallory@example.com' });
    await assertFails(b.commit());
  });

  test('must record the real sign-in email, not a made-up one', async () => {
    await assertFails(claim(as('u1'), 'u1', 'Gearhead', { email: 'someone@else.com' }));
  });

  test('cannot start with a different status, post count or extra fields', async () => {
    await assertFails(claim(as('u1'), 'u1', 'Gearhead', { extra: { status: 'banned' } }));
    await assertFails(claim(as('u1'), 'u1', 'Gearhead', { extra: { postCount: 999 } }));
    await assertFails(claim(as('u1'), 'u1', 'Gearhead', { extra: { isSysop: true } }));
  });

  test('cannot write the profile without the handle reservation and email', async () => {
    const db = as('u1');
    await assertFails(setDoc(doc(db, 'users', 'u1'), { handle: 'Gearhead', createdAt: serverTimestamp(), status: 'active', postCount: 0 }));
    await assertFails(setDoc(doc(db, 'handles', 'gearhead'), { uid: 'u1' }));
    await assertFails(setDoc(doc(db, 'private', 'u1'), { email: 'u1@example.com' }));
  });
});

// ---------- after joining ----------------------------------------------------

describe('member profiles', () => {
  beforeEach(() => seedMember('ryan', 'Ryan_F'));

  test('anyone can read a public profile', async () => {
    await assertSucceeds(getDoc(doc(guest(), 'users', 'ryan')));
  });

  test('a member cannot change their status, post count or handle', async () => {
    const db = as('ryan');
    await assertFails(updateDoc(doc(db, 'users', 'ryan'), { status: 'active', postCount: 500 }));
    await assertFails(updateDoc(doc(db, 'users', 'ryan'), { handle: 'NewName' }));
    await assertFails(deleteDoc(doc(db, 'users', 'ryan')));
  });

  test('nobody can release or steal a reserved handle', async () => {
    await assertFails(deleteDoc(doc(as('ryan'), 'handles', 'ryan_f')));
    await assertFails(setDoc(doc(as('other'), 'handles', 'ryan_f'), { uid: 'other' }));
  });

  test('anyone can check if one handle is taken, but nobody can list them all', async () => {
    await assertSucceeds(getDoc(doc(guest(), 'handles', 'ryan_f')));
    await assertSucceeds(getDoc(doc(guest(), 'handles', 'free_one')));
    await assertFails(getDocs(collection(guest(), 'handles')));
    await assertFails(getDocs(collection(as('ryan'), 'handles')));
  });
});

// ---------- emails stay private ----------------------------------------------

describe('emails', () => {
  beforeEach(async () => {
    await seedMember('ryan', 'Ryan_F');
    await seedMember('other', 'Other');
    await seed((db) => setDoc(doc(db, 'admins', 'sysop1'), { addedAt: new Date() }));
  });

  test('guests and other members cannot read anyone’s email', async () => {
    await assertFails(getDoc(doc(guest(), 'private', 'ryan')));
    await assertFails(getDoc(doc(as('other'), 'private', 'ryan')));
    await assertFails(getDocs(collection(as('other'), 'private')));
  });

  test('a member cannot change their stored email', async () => {
    await assertFails(setDoc(doc(as('ryan'), 'private', 'ryan'), { email: 'ryan@example.com' }));
  });

  test('the sysop can read emails', async () => {
    await assertSucceeds(getDoc(doc(as('sysop1'), 'private', 'ryan')));
  });

  test('public profiles never contain an email field', async () => {
    await assertFails(claim(as('u2'), 'u2', 'Gearhead', { extra: { email: 'u2@example.com' } }));
  });
});

// ---------- sysop list -------------------------------------------------------

describe('admins', () => {
  beforeEach(() => seed((db) => setDoc(doc(db, 'admins', 'sysop1'), { addedAt: new Date() })));

  test('a user can check only their own sysop entry', async () => {
    await assertSucceeds(getDoc(doc(as('sysop1'), 'admins', 'sysop1')));
    await assertSucceeds(getDoc(doc(as('ryan'), 'admins', 'ryan')));
    await assertFails(getDoc(doc(as('ryan'), 'admins', 'sysop1')));
    await assertFails(getDoc(doc(guest(), 'admins', 'sysop1')));
    await assertFails(getDocs(collection(as('ryan'), 'admins')));
  });

  test('nobody can make themselves sysop from the site', async () => {
    await assertFails(setDoc(doc(as('ryan'), 'admins', 'ryan'), { addedAt: new Date() }));
    await assertFails(setDoc(doc(as('sysop1'), 'admins', 'ryan'), { addedAt: new Date() }));
  });
});

// ---------- everything else is locked ----------------------------------------

test('collections not opened yet are locked for everyone', async () => {
  await assertFails(getDoc(doc(guest(), 'threads', 'x')));
  await assertFails(setDoc(doc(as('ryan'), 'threads', 'x'), { title: 'hi' }));
  await assertFails(setDoc(doc(as('ryan'), 'anything', 'x'), { a: 1 }));
});
