// Cloud Functions tests: run the counter functions against the Firestore
// emulator and check the numbers they write. Run with:  npm run test:rules
//
// The functions are called directly with a fake "post created/deleted" event,
// the same shape Firebase sends them in production.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.GCLOUD_PROJECT = 'demo-garage-terminal';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';

const { onPostCreated, onPostDeleted } = await import('../functions/index.js');
// Use the functions folder's own copy of firebase-admin (the one the functions use).
const requireFromFunctions = createRequire(new URL('../functions/index.js', import.meta.url));
const { getFirestore, Timestamp } = requireFromFunctions('firebase-admin/firestore');
const db = getFirestore();

const event = (threadId, postId, post) => ({ params: { threadId, postId }, data: { data: () => post } });
const post = (authorUid, createdAt = Timestamp.now()) => ({ authorUid, authorHandle: 'X', body: 'hi', createdAt, hidden: false });
const read = async (path) => (await db.doc(path).get()).data();

beforeEach(async () => {
  await db.recursiveDelete(db.collection('threads'));
  await db.doc('users/bob').set({ handle: 'Bob', status: 'active', postCount: 0 });
  await db.doc('threads/t1').set({ title: 'T', replyCount: 0, lastReplyAt: Timestamp.fromMillis(0) });
});
after(() => db.terminate());

test('a reply bumps the thread reply count, last reply time and the author post count', async () => {
  const at = Timestamp.fromMillis(Date.now() - 1000);
  await onPostCreated.run(event('t1', 'r1', post('bob', at)));
  const thread = await read('threads/t1');
  assert.equal(thread.replyCount, 1);
  assert.equal(thread.lastReplyAt.toMillis(), at.toMillis());
  assert.equal((await read('users/bob')).postCount, 1);
});

test('the opening post counts for the author but not as a reply', async () => {
  await onPostCreated.run(event('t1', 'op', post('bob')));
  assert.equal((await read('threads/t1')).replyCount, 0);
  assert.equal((await read('users/bob')).postCount, 1);
});

test('deleting a reply lowers both counts', async () => {
  await onPostCreated.run(event('t1', 'r1', post('bob')));
  await onPostCreated.run(event('t1', 'r2', post('bob')));
  await onPostDeleted.run(event('t1', 'r1', post('bob')));
  assert.equal((await read('threads/t1')).replyCount, 1);
  assert.equal((await read('users/bob')).postCount, 1);
});

test('a missing thread or user is ignored instead of crashing', async () => {
  await onPostCreated.run(event('gone', 'r1', post('nobody')));
  await onPostDeleted.run(event('gone', 'r1', post('nobody')));
  assert.equal(await read('threads/gone'), undefined);
});
