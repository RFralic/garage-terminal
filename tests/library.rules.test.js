// Library rules tests: Firestore (library/{slug}) and Storage (library files).
// Run with:  npm test   (starts the Firestore and Storage emulators)

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { startEnv, guestOf, asOf, seed as seedRaw, seedMember as seedMemberRaw } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());

const guest = () => guestOf(env)();
const as = (...a) => asOf(env)(...a);
const seed = (fn) => seedRaw(env, fn);
const seedMember = (...a) => seedMemberRaw(env, ...a);

// Storage contexts (compat API, as returned by the test library)
const guestStorage = () => env.unauthenticatedContext().storage();
const storageAs = (uid) => env.authenticatedContext(uid).storage();
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

const item = (slug, extra = {}) => ({
  slug, title: 'Carb rebuild guide', folder: 'guides', kind: 'page', type: 'GUIDE',
  description: 'Step by step', body: '# Steps', storagePath: '', fileName: '', size: 0, contentType: '',
  status: 'published', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: 'boss', ...extra,
});
const fileItem = (slug, extra = {}) => item(slug, {
  kind: 'file', type: 'PDF', body: '', storagePath: `library/${slug}/manual.pdf`, fileName: 'manual.pdf', size: 4, contentType: 'application/pdf', ...extra,
});

beforeEach(async () => {
  await env.clearFirestore();
  if (process.env.FIREBASE_STORAGE_EMULATOR_HOST) await env.clearStorage();
  await seedMember('boss', 'Boss');
  await seedMember('bob', 'Bob');
  await seed(async (db) => {
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
    const at = Timestamp.now();
    await setDoc(doc(db, 'library', 'pub'), { ...fileItem('pub'), createdAt: at, updatedAt: at, slug: 'pub' });
    await setDoc(doc(db, 'library', 'draft'), { ...fileItem('draft', { status: 'draft' }), createdAt: at, updatedAt: at });
  });
});

// ---------- Firestore: library items ---------------------------------------------

describe('library items', () => {
  test('anyone can read published items; drafts are sysop-only', async () => {
    await assertSucceeds(getDoc(doc(guest(), 'library', 'pub')));
    await assertSucceeds(getDocs(query(collection(guest(), 'library'), where('status', '==', 'published'))));
    await assertFails(getDoc(doc(guest(), 'library', 'draft')));
    await assertFails(getDoc(doc(as('bob'), 'library', 'draft')));
    await assertFails(getDocs(collection(guest(), 'library')));
    await assertSucceeds(getDoc(doc(as('boss'), 'library', 'draft')));
    await assertSucceeds(getDocs(collection(as('boss'), 'library')));
  });

  test('only the sysop can add, edit or delete items', async () => {
    await assertFails(setDoc(doc(as('bob'), 'library', 'new-guide'), item('new-guide', { updatedBy: 'bob' })));
    await assertFails(setDoc(doc(guest(), 'library', 'new-guide'), item('new-guide')));
    await assertSucceeds(setDoc(doc(as('boss'), 'library', 'new-guide'), item('new-guide')));
    await assertFails(updateDoc(doc(as('bob'), 'library', 'pub'), { title: 'Hacked', updatedAt: serverTimestamp(), updatedBy: 'bob' }));
    await assertSucceeds(updateDoc(doc(as('boss'), 'library', 'pub'), { title: 'Better title', updatedAt: serverTimestamp(), updatedBy: 'boss' }));
    await assertFails(deleteDoc(doc(as('bob'), 'library', 'pub')));
    await assertSucceeds(deleteDoc(doc(as('boss'), 'library', 'pub')));
  });

  test('addresses must be lowercase words with dashes and match the doc ID', async () => {
    const db = as('boss');
    await assertFails(setDoc(doc(db, 'library', 'Bad Slug'), item('Bad Slug')));
    await assertFails(setDoc(doc(db, 'library', 'trailing-'), item('trailing-')));
    await assertFails(setDoc(doc(db, 'library', 'one'), item('two')));
  });

  test('folder, type, status and sizes are checked', async () => {
    const db = as('boss');
    await assertFails(setDoc(doc(db, 'library', 'x1'), item('x1', { folder: 'secret' })));
    await assertFails(setDoc(doc(db, 'library', 'x2'), item('x2', { type: 'EXE' })));
    await assertFails(setDoc(doc(db, 'library', 'x3'), item('x3', { status: 'live' })));
    await assertFails(setDoc(doc(db, 'library', 'x4'), item('x4', { description: 'x'.repeat(501) })));
    await assertFails(setDoc(doc(db, 'library', 'x5'), fileItem('x5', { size: 50 * 1024 * 1024 + 1 })));
    await assertFails(setDoc(doc(db, 'library', 'x6'), item('x6', { extra: true })));
  });

  test('a file item must point at a file inside its own Storage folder', async () => {
    const db = as('boss');
    await assertFails(setDoc(doc(db, 'library', 'f1'), fileItem('f1', { storagePath: '' })));
    await assertFails(setDoc(doc(db, 'library', 'f2'), fileItem('f2', { storagePath: 'library/other/manual.pdf' })));
    await assertFails(setDoc(doc(db, 'library', 'f3'), fileItem('f3', { storagePath: 'library/f3/a/b.pdf' })));
    await assertSucceeds(setDoc(doc(db, 'library', 'f4'), fileItem('f4')));
  });

  test('created date and kind can’t be changed on edit', async () => {
    const db = as('boss');
    await assertFails(updateDoc(doc(db, 'library', 'pub'), { kind: 'page', storagePath: '', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, 'library', 'pub'), { createdAt: Timestamp.fromMillis(0), updatedAt: serverTimestamp() }));
  });
});

// ---------- Storage: library files ----------------------------------------------------

describe('library files (Storage)', { skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST && 'Storage emulator not running' }, () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.storage().ref('library/pub/manual.pdf').put(PDF, { contentType: 'application/pdf' });
      await ctx.storage().ref('library/draft/manual.pdf').put(PDF, { contentType: 'application/pdf' });
    });
  });

  test('anyone can download a published item’s file', async () => {
    await assertSucceeds(guestStorage().ref('library/pub/manual.pdf').getDownloadURL());
    await assertSucceeds(storageAs('bob').ref('library/pub/manual.pdf').getMetadata());
  });

  test('draft files are hidden from guests and members, visible to the sysop', async () => {
    await assertFails(guestStorage().ref('library/draft/manual.pdf').getDownloadURL());
    await assertFails(storageAs('bob').ref('library/draft/manual.pdf').getDownloadURL());
    await assertSucceeds(storageAs('boss').ref('library/draft/manual.pdf').getDownloadURL());
  });

  test('files with no library item can’t be read by the public', async () => {
    await env.withSecurityRulesDisabled((ctx) => ctx.storage().ref('library/orphan/x.pdf').put(PDF));
    await assertFails(guestStorage().ref('library/orphan/x.pdf').getDownloadURL());
  });

  test('only the sysop can upload or delete', async () => {
    await assertFails(guestStorage().ref('library/pub/new.pdf').put(PDF));
    await assertFails(storageAs('bob').ref('library/pub/new.pdf').put(PDF));
    await assertSucceeds(storageAs('boss').ref('library/pub/new.pdf').put(PDF));
    await assertFails(storageAs('bob').ref('library/pub/manual.pdf').delete());
    await assertSucceeds(storageAs('boss').ref('library/pub/manual.pdf').delete());
  });

  test('uploads over 50 MB are refused', async () => {
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    await assertFails(storageAs('boss').ref('library/pub/big.bin').put(big));
  });

  test('nothing outside library/ can be read or written', async () => {
    await assertFails(storageAs('boss').ref('other/x.txt').put(PDF));
    await assertFails(guestStorage().ref('other/x.txt').getDownloadURL());
  });
});
