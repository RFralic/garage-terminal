// Pantry rules tests: a pantry is shared by the people in it, each with a role
// (owner / member / viewer). Nobody else can see it, not even the sysop.
// Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  Timestamp, arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query,
  serverTimestamp, setDoc, updateDoc, where,
} from 'firebase/firestore';
import { startEnv, guestOf, asOf, seed as seedRaw, seedMember } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());

const guest = () => guestOf(env)();
const as = (...a) => asOf(env)(...a);
const DAY = 86400000;
const CODE = 'ABCD2345';

const pantry = () => ({
  name: 'Fralic household',
  owner: 'bob',
  members: { bob: 'owner', ann: 'member', val: 'viewer' },
  memberIds: ['bob', 'ann', 'val'],
  memberNames: { bob: 'Bob', ann: 'Ann', val: 'Val' },
  nextBatch: 3,
  inviteCode: CODE,
  inviteExpires: Timestamp.fromMillis(Date.now() + 7 * DAY),
  createdAt: new Date(),
});
const item = (by, extra = {}) => ({
  name: 'Black beans', brand: '', size: '15.5 oz', location: 'Pantry', keepAtLeast: 2,
  barcodes: ['041331021551'], lots: [{ qty: 6, expires: '2027-08-01' }],
  updatedBy: by, updatedAt: serverTimestamp(), ...extra,
});
const P = (db, ...rest) => doc(db, 'pantries', 'p1', ...rest);

beforeEach(async () => {
  await env.clearFirestore();
  for (const [uid, h] of [['bob', 'Bob'], ['ann', 'Ann'], ['val', 'Val'], ['carol', 'Carol'], ['boss', 'Boss']]) await seedMember(env, uid, h);
  await seedRaw(env, async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    await setDoc(doc(db, 'pantries', 'p1'), pantry());
    await setDoc(doc(db, 'pantries', 'p1', 'items', 'i1'), { ...item('bob'), updatedAt: new Date() });
    await setDoc(doc(db, 'pantries', 'p1', 'activity', 'a1'), { by: 'bob', who: 'Bob', what: '+ 6 Black beans', at: new Date() });
    await setDoc(doc(db, 'pantries', 'p1', 'shopping', 's1'), { name: 'Bananas', done: false, by: 'ann', who: 'Ann', at: new Date() });
    await setDoc(doc(db, 'pantryInvites', CODE), { pantryId: 'p1', pantryName: 'Fralic household', createdBy: 'bob', expiresAt: Timestamp.fromMillis(Date.now() + 7 * DAY) });
  });
});

describe('Pantry: starting one', () => {
  const fresh = (uid) => ({
    name: 'Camp pantry', owner: uid, members: { [uid]: 'owner' }, memberIds: [uid], memberNames: { [uid]: 'Me' },
    nextBatch: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });

  test('anyone signed in can start their own pantry', async () => {
    await assertSucceeds(setDoc(doc(as('carol'), 'pantries', 'p2'), fresh('carol')));
  });

  test('…only with themselves as the owner and only member', async () => {
    const db = as('carol');
    await assertFails(setDoc(doc(db, 'pantries', 'p2'), { ...fresh('carol'), owner: 'bob', members: { bob: 'owner' }, memberIds: ['bob'], memberNames: {} }));
    await assertFails(setDoc(doc(db, 'pantries', 'p2'), { ...fresh('carol'), members: { carol: 'owner', bob: 'member' }, memberIds: ['carol', 'bob'] }));
    await assertFails(setDoc(doc(db, 'pantries', 'p2'), { ...fresh('carol'), nextBatch: 5 }));
    await assertFails(setDoc(doc(db, 'pantries', 'p2'), { ...fresh('carol'), inviteCode: CODE }));
    await assertFails(setDoc(doc(guest(), 'pantries', 'p2'), fresh('carol')));
  });
});

describe('Pantry: who can see it', () => {
  test('everyone in it can read the pantry, items, activity and shopping list', async () => {
    for (const uid of ['bob', 'ann', 'val']) {
      const db = as(uid);
      await assertSucceeds(getDoc(P(db)));
      await assertSucceeds(getDocs(collection(db, 'pantries', 'p1', 'items')));
      await assertSucceeds(getDocs(collection(db, 'pantries', 'p1', 'activity')));
      await assertSucceeds(getDocs(collection(db, 'pantries', 'p1', 'shopping')));
      await assertSucceeds(getDocs(query(collection(db, 'pantries'), where('memberIds', 'array-contains', uid))));
    }
  });

  test('nobody else: guests, other members of the site, the sysop', async () => {
    for (const db of [guest(), as('carol'), as('boss')]) {
      await assertFails(getDoc(P(db)));
      await assertFails(getDoc(P(db, 'items', 'i1')));
      await assertFails(getDocs(collection(db, 'pantries', 'p1', 'items')));
      await assertFails(getDocs(collection(db, 'pantries', 'p1', 'activity')));
      await assertFails(getDocs(collection(db, 'pantries', 'p1', 'shopping')));
      await assertFails(getDocs(collection(db, 'pantries')));
    }
  });
});

describe('Pantry: items', () => {
  test('the owner and members add, change and delete items', async () => {
    for (const uid of ['bob', 'ann']) {
      const db = as(uid);
      await assertSucceeds(setDoc(P(db, 'items', 'i-' + uid), item(uid)));
      await assertSucceeds(setDoc(P(db, 'items', 'i1'), item(uid, { lots: [{ qty: 5, expires: '2027-08-01' }] })));
      await assertSucceeds(deleteDoc(P(db, 'items', 'i-' + uid)));
    }
  });

  test('viewers and outsiders can\'t', async () => {
    for (const uid of ['val', 'carol', 'boss']) {
      const db = as(uid);
      await assertFails(setDoc(P(db, 'items', 'i9'), item(uid)));
      await assertFails(setDoc(P(db, 'items', 'i1'), item(uid)));
      await assertFails(deleteDoc(P(db, 'items', 'i1')));
    }
  });

  test('every change is signed by whoever made it', async () => {
    await assertFails(setDoc(P(as('ann'), 'items', 'i1'), item('bob')));
    await assertFails(setDoc(P(as('ann'), 'items', 'i1'), { ...item('ann'), surprise: true }));
    await assertFails(setDoc(P(as('ann'), 'items', 'i1'), { ...item('ann'), name: '' }));
  });
});

describe('Pantry: activity and shopping list', () => {
  test('activity: anyone in the pantry adds entries as themselves; nobody edits them', async () => {
    const entry = (by) => ({ by, who: 'X', what: '− 1 Black beans', at: serverTimestamp() });
    await assertSucceeds(setDoc(P(as('ann'), 'activity', 'a2'), entry('ann')));
    await assertSucceeds(setDoc(P(as('val'), 'activity', 'a3'), entry('val')));
    await assertFails(setDoc(P(as('ann'), 'activity', 'a4'), entry('bob')));
    await assertFails(setDoc(P(as('carol'), 'activity', 'a5'), entry('carol')));
    await assertFails(updateDoc(P(as('bob'), 'activity', 'a1'), { what: 'nothing happened' }));
    await assertFails(deleteDoc(P(as('ann'), 'activity', 'a1')));
    await assertSucceeds(deleteDoc(P(as('bob'), 'activity', 'a1')));
  });

  test('shopping list: viewers can add and tick things off too; outsiders can\'t', async () => {
    const s = { name: 'Coffee', done: false, by: 'val', who: 'Val', at: serverTimestamp() };
    await assertSucceeds(setDoc(P(as('val'), 'shopping', 's2'), s));
    await assertSucceeds(updateDoc(P(as('val'), 'shopping', 's1'), { done: true }));
    await assertSucceeds(deleteDoc(P(as('ann'), 'shopping', 's1')));
    await assertFails(setDoc(P(as('carol'), 'shopping', 's3'), s));
    await assertFails(setDoc(P(as('val'), 'shopping', 's4'), { ...s, done: 'yes' }));
  });
});

describe('Pantry: joining with an invite code', () => {
  const join = (db, uid, code = CODE, role = 'member') => updateDoc(P(db), {
    [`members.${uid}`]: role, memberIds: arrayUnion(uid), [`memberNames.${uid}`]: 'Carol', joinCode: code,
  });

  test('anyone signed in can look up an invite by its exact code, but not list them', async () => {
    await assertSucceeds(getDoc(doc(as('carol'), 'pantryInvites', CODE)));
    await assertFails(getDocs(collection(as('carol'), 'pantryInvites')));
    await assertFails(getDoc(doc(guest(), 'pantryInvites', CODE)));
  });

  test('with the right code, someone adds themselves as a member', async () => {
    await assertSucceeds(join(as('carol'), 'carol'));
    await assertSucceeds(getDoc(P(as('carol'))));
    await assertSucceeds(setDoc(P(as('carol'), 'items', 'i5'), item('carol')));
  });

  test('wrong or expired code, a higher role, or adding someone else: no', async () => {
    await assertFails(join(as('carol'), 'carol', 'WRONG234'));
    await assertFails(join(as('carol'), 'carol', CODE, 'owner'));
    await assertFails(join(as('carol'), 'carol', CODE, 'viewer'));
    await assertFails(join(as('carol'), 'dave'));
    await assertFails(updateDoc(P(as('carol')), { 'members.carol': 'member', memberIds: arrayUnion('carol'), joinCode: CODE, name: 'Mine now' }));
    await seedRaw(env, (db) => updateDoc(doc(db, 'pantries', 'p1'), { inviteExpires: Timestamp.fromMillis(Date.now() - DAY) }));
    await assertFails(join(as('carol'), 'carol'));
  });

  test('no code set: nobody can join', async () => {
    await seedRaw(env, (db) => updateDoc(doc(db, 'pantries', 'p1'), { inviteCode: '' }));
    await assertFails(join(as('carol'), 'carol', ''));
  });

  test('only the owner makes invites', async () => {
    const inv = (by) => ({ pantryId: 'p1', pantryName: 'Fralic household', createdBy: by, expiresAt: Timestamp.fromMillis(Date.now() + DAY) });
    await assertSucceeds(setDoc(doc(as('bob'), 'pantryInvites', 'ZZZZ2345'), inv('bob')));
    await assertFails(setDoc(doc(as('ann'), 'pantryInvites', 'YYYY2345'), inv('ann')));
    await assertFails(setDoc(doc(as('bob'), 'pantryInvites', 'bad'), inv('bob')));
    await assertFails(deleteDoc(doc(as('ann'), 'pantryInvites', CODE)));
    await assertSucceeds(deleteDoc(doc(as('bob'), 'pantryInvites', CODE)));
  });
});

describe('Pantry: leaving, roles and settings', () => {
  const removeUser = (uid) => ({ [`members.${uid}`]: deleteField(), memberIds: arrayRemove(uid), [`memberNames.${uid}`]: deleteField() });

  test('members and viewers can leave; the owner can\'t', async () => {
    await assertSucceeds(updateDoc(P(as('ann')), removeUser('ann')));
    await assertSucceeds(updateDoc(P(as('val')), removeUser('val')));
    await assertFails(updateDoc(P(as('bob')), removeUser('bob')));
  });

  test('only the owner removes other people or changes roles', async () => {
    await assertFails(updateDoc(P(as('ann')), removeUser('val')));
    await assertFails(updateDoc(P(as('ann')), { 'members.val': 'member' }));
    await assertFails(updateDoc(P(as('ann')), { 'members.ann': 'owner' }));
    await assertSucceeds(updateDoc(P(as('bob')), { 'members.val': 'member' }));
    await assertSucceeds(updateDoc(P(as('bob')), removeUser('ann')));
    await assertFails(updateDoc(P(as('bob')), { 'members.val': 'boss' }));
  });

  test('the owner renames, sets use-by defaults and makes a new code; members can\'t', async () => {
    await assertSucceeds(updateDoc(P(as('bob')), { name: 'Home', useBy: { Frozen: 9 }, inviteCode: 'NEWC2345', inviteExpires: Timestamp.fromMillis(Date.now() + DAY), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(P(as('ann')), { name: 'Ann\'s' }));
    await assertFails(updateDoc(P(as('ann')), { inviteCode: 'MINE2345' }));
    await assertFails(updateDoc(P(as('bob')), { owner: 'ann', 'members.ann': 'owner', 'members.bob': 'member' }));
    await assertFails(updateDoc(P(as('bob')), { inviteCode: 'lower' }));
  });

  test('homemade batch numbers: members take the next one, one at a time', async () => {
    await assertSucceeds(updateDoc(P(as('ann')), { nextBatch: 4 }));
    await assertFails(updateDoc(P(as('ann')), { nextBatch: 6 }));
    await assertFails(updateDoc(P(as('ann')), { nextBatch: 3 }));
    await assertFails(updateDoc(P(as('val')), { nextBatch: 5 }));
    await assertFails(updateDoc(P(as('carol')), { nextBatch: 5 }));
  });

  test('only the owner deletes the pantry', async () => {
    await assertFails(deleteDoc(P(as('ann'))));
    await assertSucceeds(deleteDoc(P(as('bob'))));
  });
});
