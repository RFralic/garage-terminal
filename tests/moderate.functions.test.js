// Tests for the `moderate` Cloud Function (functions/moderate.js), run against
// the Firestore emulator. Checks the sysop-only gate, each action, and that
// every action lands in the mod log.  Run with:  npm test

import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.GCLOUD_PROJECT = 'demo-garage-terminal';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';

const { moderate } = await import('../functions/index.js');
const requireFromFunctions = createRequire(new URL('../functions/index.js', import.meta.url));
const { getFirestore, Timestamp } = requireFromFunctions('firebase-admin/firestore');
const db = getFirestore();

const call = (uid, data) => moderate.run({ auth: uid ? { uid } : undefined, data });
const read = async (path) => (await db.doc(path).get()).data();
const logCount = async () => (await db.collection('modlog').count().get()).data().count;
const lastLog = async () => (await db.collection('modlog').orderBy('createdAt', 'desc').limit(1).get()).docs[0]?.data();

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

beforeEach(async () => {
  for (const c of ['threads', 'users', 'handles', 'private', 'admins', 'reports', 'modlog', 'settings', 'areas']) {
    await db.recursiveDelete(db.collection(c));
  }
  await db.doc('admins/boss').set({ addedAt: Timestamp.now() });
  await db.doc('users/boss').set({ handle: 'Boss', status: 'active', postCount: 0 });
  await db.doc('users/bob').set({ handle: 'Bob', status: 'active', postCount: 2 });
  await db.doc('handles/bob').set({ uid: 'bob' });
  await db.doc('private/bob').set({ email: 'bob@example.com' });
  await db.doc('handles/taken').set({ uid: 'someone' });
  await db.doc('areas/general').set({ key: '[1]', name: 'General', order: 1 });
  await db.doc('areas/off-topic').set({ key: '[5]', name: 'Off-Topic', order: 5 });
  await db.doc('settings/site').set({ sysopNotice: '', forumOpen: true, bannedWords: [] });
  await db.doc('threads/t1').set({ areaId: 'general', title: 'T1', authorUid: 'bob', authorHandle: 'Bob', pinned: false, locked: false, hidden: false, replyCount: 1 });
  await db.doc('threads/t1/posts/op').set({ authorUid: 'bob', authorHandle: 'Bob', body: 'op', hidden: false, createdAt: Timestamp.now() });
  await db.doc('threads/t1/posts/p1').set({ authorUid: 'bob', authorHandle: 'Bob', body: 'reply', hidden: false, createdAt: Timestamp.now() });
  await db.doc('reports/t1__p1__ryan').set({ threadId: 't1', postId: 'p1', reporterUid: 'ryan', reason: 'spam', status: 'open' });
});
after(() => db.terminate());

describe('who can moderate', () => {
  test('guests and ordinary members are refused, and nothing is logged', async () => {
    await rejects(call(null, { action: 'thread.lock', threadId: 't1', value: true }), 'unauthenticated');
    await rejects(call('bob', { action: 'thread.lock', threadId: 't1', value: true }), 'permission-denied');
    assert.equal((await read('threads/t1')).locked, false);
    assert.equal(await logCount(), 0);
  });

  test('bad input is refused', async () => {
    await rejects(call('boss', { action: 'thread.lock', threadId: 't1', value: 'yes' }), 'invalid-argument');
    await rejects(call('boss', { action: 'thread.lock', threadId: '../users/bob', value: true }), 'invalid-argument');
    await rejects(call('boss', { action: 'explode' }), 'invalid-argument');
    await rejects(call('boss', { action: 'thread.lock', threadId: 'ghost', value: true }), 'not-found');
  });
});

describe('threads', () => {
  test('pin, lock and move, each logged', async () => {
    await call('boss', { action: 'thread.pin', threadId: 't1', value: true });
    await call('boss', { action: 'thread.lock', threadId: 't1', value: true, reason: 'resolved' });
    await call('boss', { action: 'thread.move', threadId: 't1', areaId: 'off-topic' });
    const t = await read('threads/t1');
    assert.deepEqual([t.pinned, t.locked, t.areaId], [true, true, 'off-topic']);
    assert.equal(await logCount(), 3);
    const log = await lastLog();
    assert.equal(log.action, 'thread.move');
    assert.equal(log.byUid, 'boss');
    assert.equal(log.byHandle, 'Boss');
    assert.equal(log.targetPath, 'threads/t1');
    await rejects(call('boss', { action: 'thread.move', threadId: 't1', areaId: 'nope' }), 'not-found');
  });

  test('hide with a reason; unhide clears the reason and approves a held thread', async () => {
    await call('boss', { action: 'thread.hide', threadId: 't1', value: true, reason: 'spam' });
    assert.deepEqual([(await read('threads/t1')).hidden, (await read('threads/t1')).hiddenReason], [true, 'spam']);
    await db.doc('threads/t1').update({ held: true });
    await call('boss', { action: 'thread.hide', threadId: 't1', value: false });
    const t = await read('threads/t1');
    assert.equal(t.hidden, false);
    assert.equal('held' in t, false);
    assert.equal('hiddenReason' in t, false);
  });

  test('delete removes the thread and all its posts, and closes its reports', async () => {
    await call('boss', { action: 'thread.delete', threadId: 't1', reason: 'spam' });
    assert.equal(await read('threads/t1'), undefined);
    assert.equal((await db.collection('threads/t1/posts').get()).size, 0);
    assert.equal((await read('reports/t1__p1__ryan')).status, 'actioned');
    assert.equal((await lastLog()).details.title, 'T1');
  });
});

describe('posts and reports', () => {
  test('hiding a post from a report closes the report', async () => {
    await call('boss', { action: 'post.hide', threadId: 't1', postId: 'p1', value: true, reason: 'spam', reportId: 't1__p1__ryan' });
    assert.equal((await read('threads/t1/posts/p1')).hidden, true);
    assert.equal((await read('reports/t1__p1__ryan')).status, 'actioned');
  });

  test('dismissing a report leaves the post alone', async () => {
    await call('boss', { action: 'report.dismiss', reportId: 't1__p1__ryan' });
    assert.equal((await read('reports/t1__p1__ryan')).status, 'dismissed');
    assert.equal((await read('threads/t1/posts/p1')).hidden, false);
  });

  test('a reply can be deleted; an opening post cannot (delete the thread instead)', async () => {
    await call('boss', { action: 'post.delete', threadId: 't1', postId: 'p1' });
    assert.equal(await read('threads/t1/posts/p1'), undefined);
    await rejects(call('boss', { action: 'post.delete', threadId: 't1', postId: 'op' }), 'invalid-argument');
  });
});

describe('members', () => {
  test('ban stores the reason privately; restore clears it', async () => {
    await call('boss', { action: 'member.status', uid: 'bob', status: 'banned', reason: 'spam bot' });
    assert.equal((await read('users/bob')).status, 'banned');
    assert.equal('bannedReason' in (await read('users/bob')), false, 'reason must not be on the public profile');
    assert.equal((await read('private/bob')).bannedReason, 'spam bot');
    assert.equal((await read('private/bob')).email, 'bob@example.com');
    await call('boss', { action: 'member.status', uid: 'bob', status: 'active' });
    assert.equal((await read('users/bob')).status, 'active');
    assert.equal('bannedReason' in (await read('private/bob')), false);
  });

  test('mute works; invalid status and changing your own status are refused', async () => {
    await call('boss', { action: 'member.status', uid: 'bob', status: 'muted' });
    assert.equal((await read('users/bob')).status, 'muted');
    await rejects(call('boss', { action: 'member.status', uid: 'bob', status: 'king' }), 'invalid-argument');
    await rejects(call('boss', { action: 'member.status', uid: 'boss', status: 'banned' }), 'invalid-argument');
  });

  test('hide all posts by a member hides their posts and threads', async () => {
    const res = await call('boss', { action: 'member.hideAll', uid: 'bob', reason: 'spammer' });
    assert.equal(res.posts, 2);
    assert.equal((await read('threads/t1/posts/p1')).hidden, true);
    assert.equal((await read('threads/t1')).hidden, true);
  });

  test('rename moves the handle reservation and updates their posts', async () => {
    await call('boss', { action: 'member.rename', uid: 'bob', handle: 'Robert_2' });
    assert.equal((await read('users/bob')).handle, 'Robert_2');
    assert.equal(await read('handles/bob'), undefined);
    assert.equal((await read('handles/robert_2')).uid, 'bob');
    assert.equal((await read('threads/t1/posts/p1')).authorHandle, 'Robert_2');
    assert.equal((await read('threads/t1')).authorHandle, 'Robert_2');
  });

  test('rename refuses taken, reserved or badly formed handles', async () => {
    await rejects(call('boss', { action: 'member.rename', uid: 'bob', handle: 'Taken' }), 'already-exists');
    await rejects(call('boss', { action: 'member.rename', uid: 'bob', handle: 'SysOp' }), 'invalid-argument');
    await rejects(call('boss', { action: 'member.rename', uid: 'bob', handle: 'no spaces' }), 'invalid-argument');
    assert.equal((await read('users/bob')).handle, 'Bob');
  });
});

describe('site settings', () => {
  test('notice, forum switch and banned words are saved and logged', async () => {
    const res = await call('boss', { action: 'settings.update', sysopNotice: 'Be nice', forumOpen: false, bannedWords: [' Spammy ', 'BUY   now', 'spammy'] });
    const s = await read('settings/site');
    assert.equal(s.sysopNotice, 'Be nice');
    assert.equal(s.forumOpen, false);
    assert.deepEqual(s.bannedWords, ['spammy', 'buy now']);
    assert.deepEqual(res.bannedWords, ['spammy', 'buy now']);
    assert.equal((await lastLog()).details.bannedWords, '2 words');
  });

  test('banned words with symbols are refused (they’d break the database word check)', async () => {
    for (const w of ['a|b', 'c.*', 'x)', 'é']) {
      await rejects(call('boss', { action: 'settings.update', bannedWords: [w] }), 'invalid-argument');
    }
    assert.deepEqual((await read('settings/site')).bannedWords, []);
  });
});
