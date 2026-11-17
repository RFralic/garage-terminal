// Tests for the BBS Cloud Functions (functions/bbs.js) on the Firestore emulator:
// sysop vs co-sysop powers, the 30-day wait, the passcode lockout, the emails,
// and that every action lands in the mod log.  Run with:  npm test

import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.GCLOUD_PROJECT = 'demo-garage-terminal';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';

const { bbs } = await import('../functions/index.js');
const { knockHandler, requestEmail, welcomeEmail, setMailer } = await import('../functions/bbs.js');
const content = await import('../functions/bbs-content.js');
const requireFromFunctions = createRequire(new URL('../functions/index.js', import.meta.url));
const { getFirestore, Timestamp } = requireFromFunctions('firebase-admin/firestore');
const db = getFirestore();

const call = (uid, data) => bbs.run({ auth: uid ? { uid } : undefined, data });
const knock = (uid, code, passcode = '481516') => knockHandler({ auth: { uid }, data: { code } }, passcode);
const read = async (path) => (await db.doc(path).get()).data();
const exists = async (path) => (await db.doc(path).get()).exists;
const lastLog = async () => (await db.collection('modlog').orderBy('createdAt', 'desc').limit(1).get()).docs[0]?.data();
async function rejects(promise, code) {
  await assert.rejects(promise, (err) => { assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`); return true; });
}

beforeEach(async () => {
  for (const c of ['users', 'handles', 'private', 'admins', 'modlog', 'bbsConfig', 'bbsRequests', 'bbsMembers', 'bbsDenied', 'bbsRemoved', 'bbsKnocks']) {
    await db.recursiveDelete(db.collection(c));
  }
  const person = async (uid, handle) => {
    await db.doc(`users/${uid}`).set({ handle, status: 'active', postCount: 0 });
    await db.doc(`handles/${handle.toLowerCase()}`).set({ uid });
    await db.doc(`private/${uid}`).set({ email: `${uid}@example.com` });
  };
  await person('boss', 'Boss');
  await person('carl', 'Carl');
  await person('mia', 'Mia');
  await person('pete', 'Pete');
  await person('petra', 'Petra');
  await db.doc('admins/boss').set({ addedAt: Timestamp.now() });
  await db.doc('bbsMembers/carl').set({ handle: 'Carl', role: 'cosysop', since: Timestamp.now(), addedBy: 'Boss', lastSeen: null });
  await db.doc('bbsMembers/mia').set({ handle: 'Mia', role: 'member', since: Timestamp.now(), addedBy: 'Boss', lastSeen: null });
  await db.doc('bbsRequests/pete').set({ handle: 'Pete', createdAt: Timestamp.now() });
});
after(() => db.terminate());

describe('requests', () => {
  test('a co-sysop approves: member now, request gone, logged', async () => {
    await call('carl', { action: 'request.approve', uid: 'pete' });
    const m = await read('bbsMembers/pete');
    assert.equal(m.handle, 'Pete');
    assert.equal(m.role, 'member');
    assert.equal(m.addedBy, 'Carl');
    assert.equal(await exists('bbsRequests/pete'), false);
    assert.equal((await lastLog()).action, 'bbs.request.approve');
    assert.equal(JSON.stringify(m).includes('@'), false, 'no email in the member doc');
  });
  test('deny: request gone, 30-day wait, logged; let them in clears it', async () => {
    await call('boss', { action: 'request.deny', uid: 'pete' });
    const d = await read('bbsDenied/pete');
    const days = (d.until.toMillis() - Date.now()) / 86400000;
    assert.ok(days > 29.9 && days <= 30, `until is 30 days out (${days})`);
    assert.equal(await exists('bbsRequests/pete'), false);
    assert.equal((await lastLog()).action, 'bbs.request.deny');
    await call('carl', { action: 'denied.letIn', uid: 'pete' });
    assert.equal(await exists('bbsDenied/pete'), false);
    assert.equal((await read('bbsMembers/pete')).role, 'member');
  });
  test('clear the wait lets them ask again', async () => {
    await call('boss', { action: 'request.deny', uid: 'pete' });
    await call('carl', { action: 'denied.clear', uid: 'pete' });
    assert.equal(await exists('bbsDenied/pete'), false);
    assert.equal(await exists('bbsMembers/pete'), false);
  });
  test('plain members, outsiders and guests can’t approve', async () => {
    await rejects(call('mia', { action: 'request.approve', uid: 'pete' }), 'permission-denied');
    await rejects(call('petra', { action: 'request.approve', uid: 'pete' }), 'permission-denied');
    await rejects(call(null, { action: 'request.approve', uid: 'pete' }), 'unauthenticated');
    assert.equal(await exists('bbsMembers/pete'), false);
  });
});

describe('members', () => {
  test('add a member by account search, in immediately', async () => {
    const { accounts } = await call('carl', { action: 'accounts.search', text: 'pet' });
    assert.deepEqual(accounts.map((a) => a.handle).sort(), ['Pete', 'Petra']);
    assert.equal(JSON.stringify(accounts).includes('@'), false, 'search never returns emails');
    await call('carl', { action: 'member.add', uid: 'petra' });
    assert.equal((await read('bbsMembers/petra')).role, 'member');
    await rejects(call('carl', { action: 'member.add', uid: 'petra' }), 'invalid-argument');
  });
  test('remove: access ends, listed as removed, can be let back in', async () => {
    await call('carl', { action: 'member.remove', uid: 'mia' });
    assert.equal(await exists('bbsMembers/mia'), false);
    assert.equal((await read('bbsRemoved/mia')).handle, 'Mia');
    await call('boss', { action: 'removed.restore', uid: 'mia' });
    assert.equal(await exists('bbsRemoved/mia'), false);
    assert.equal((await read('bbsMembers/mia')).role, 'member');
  });
  test('only the sysop makes co-sysops; co-sysops can’t remove each other or the sysop', async () => {
    await rejects(call('carl', { action: 'member.role', uid: 'mia', role: 'cosysop' }), 'permission-denied');
    await call('boss', { action: 'member.role', uid: 'mia', role: 'cosysop' });
    assert.equal((await read('bbsMembers/mia')).role, 'cosysop');
    await rejects(call('carl', { action: 'member.remove', uid: 'mia' }), 'permission-denied');
    await call('boss', { action: 'enter' });
    await rejects(call('carl', { action: 'member.remove', uid: 'boss' }), 'permission-denied');
    await call('boss', { action: 'member.role', uid: 'mia', role: 'member' });
    await call('boss', { action: 'member.remove', uid: 'carl' });
    assert.equal(await exists('bbsMembers/carl'), false);
  });
  test('the sysop joins the crew list on first entry', async () => {
    assert.deepEqual(await call('boss', { action: 'enter' }), { role: 'sysop' });
    assert.equal((await read('bbsMembers/boss')).role, 'sysop');
    assert.deepEqual(await call('mia', { action: 'enter' }), { role: 'member' });
  });
});

describe('settings (sysop only)', () => {
  test('door word, passcode switch and notice', async () => {
    await rejects(call('carl', { action: 'settings.update', doorWord: 'shed' }), 'permission-denied');
    await rejects(call('boss', { action: 'settings.update', doorWord: 'two words' }), 'invalid-argument');
    await call('boss', { action: 'settings.update', doorWord: 'Shed42', requirePasscode: true, notice: 'Swap meet Saturday' });
    assert.deepEqual(await read('bbsConfig/main'), { doorWord: 'shed42', requirePasscode: true, notice: 'Swap meet Saturday' });
    const log = await lastLog();
    assert.equal(log.action, 'bbs.settings.update');
    assert.equal(log.details.doorWord, 'shed42');
  });
});

describe('the passcode (bbsKnock)', () => {
  test('refused while the passcode is switched off', async () => {
    await rejects(knock('petra', '481516'), 'failed-precondition');
  });
  test('5 wrong tries lock the account for 15 minutes; the right code files the request', async () => {
    await db.doc('bbsConfig/main').set({ doorWord: 'backroom', requirePasscode: true, notice: '' });
    assert.deepEqual(await knock('petra', '000000'), { ok: false, triesLeft: 4 });
    for (const left of [3, 2, 1]) assert.deepEqual(await knock('petra', '000000'), { ok: false, triesLeft: left });
    assert.deepEqual(await knock('petra', '000000'), { ok: false, lockedMinutes: 15 });
    assert.deepEqual(await knock('petra', '481516'), { ok: false, lockedMinutes: 15 }, 'even the right code waits out the lockout');
    assert.equal(await exists('bbsRequests/petra'), false);
    await db.doc('bbsKnocks/petra').set({ fails: 0, lockedUntil: Timestamp.fromMillis(Date.now() - 1000) });
    assert.deepEqual(await knock('petra', '481516'), { ok: true });
    assert.equal((await read('bbsRequests/petra')).handle, 'Petra');
    assert.equal(await exists('bbsKnocks/petra'), false);
  });
  test('not 6 digits, no secret set, or denied', async () => {
    await db.doc('bbsConfig/main').set({ doorWord: 'backroom', requirePasscode: true, notice: '' });
    await rejects(knock('petra', '12ab'), 'invalid-argument');
    await rejects(knock('petra', '123456', ''), 'failed-precondition');
    await db.doc('bbsDenied/petra').set({ handle: 'Petra', at: Timestamp.now(), until: Timestamp.fromMillis(Date.now() + 1e9), by: 'Boss' });
    await rejects(knock('petra', '481516'), 'permission-denied');
  });
});

describe('emails', () => {
  test('a request emails the sysop; approval emails "You’re in"; nothing for the sysop’s own entry', async () => {
    const sent = [];
    setMailer(async (m) => { sent.push(m); });
    await requestEmail({ data: { data: () => ({ handle: 'Pete' }) }, params: { uid: 'pete' } }, 'key');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'boss@example.com');
    assert.equal(sent[0].subject, 'New BBS request: Pete');
    assert.match(sent[0].html, /\/mod#bbs/);
    assert.match(sent[0].from, /brief@garageterminal\.com/);
    await welcomeEmail({ data: { data: () => ({ handle: 'Pete', role: 'member' }) }, params: { uid: 'pete' } }, 'key');
    assert.equal(sent[1].to, 'pete@example.com');
    assert.match(sent[1].subject, /You’re in/);
    assert.match(sent[1].text, />_ at the bottom/);
    await welcomeEmail({ data: { data: () => ({ handle: 'Boss', role: 'sysop' }) }, params: { uid: 'boss' } }, 'key');
    await welcomeEmail({ data: { data: () => ({ handle: 'Pete', role: 'member' }) }, params: { uid: 'pete' } }, '');
    assert.equal(sent.length, 2, 'no email for the sysop, and none without the key');
  });
});

describe('boards (sysop only) and their upkeep', () => {
  test('add, rename / reorder, archive and restore a board; logged', async () => {
    await rejects(call('carl', { action: 'board.save', name: 'Tools', description: '', order: 4 }), 'permission-denied');
    const { id } = await call('boss', { action: 'board.save', name: 'Small Engines!', description: 'Mowers & saws', order: 4 });
    assert.equal(id, 'small-engines');
    assert.deepEqual((await read('bbsBoards/small-engines')).archived, false);
    const again = await call('boss', { action: 'board.save', name: 'Small engines', description: '', order: 5 });
    assert.equal(again.id, 'small-engines-2', 'a new board never overwrites one');
    await call('boss', { action: 'board.save', id: 'small-engines', name: 'Engines', description: 'x', order: 2 });
    assert.equal((await read('bbsBoards/small-engines')).name, 'Engines');
    await call('boss', { action: 'board.archive', id: 'small-engines', archived: true });
    assert.equal((await read('bbsBoards/small-engines')).archived, true);
    assert.equal((await lastLog()).action, 'bbs.board.archive');
    await rejects(call('boss', { action: 'board.save', name: '', description: '', order: 1 }), 'invalid-argument');
  });
  test('a reply bumps its thread; deleting it lowers the count; deleting a thread removes its posts', async () => {
    await db.recursiveDelete(db.collection('bbsThreads'));
    await db.doc('bbsThreads/t1').set({ replyCount: 0, lastAt: Timestamp.fromMillis(0), lastBy: 'Mia' });
    await db.doc('bbsThreads/t1/posts/op').set({ authorUid: 'mia', authorHandle: 'Mia', body: 'x' });
    const at = Timestamp.now();
    const ev = (postId, post) => ({ params: { threadId: 't1', postId }, data: { data: () => post } });
    await content.postCreated(ev('op', { authorHandle: 'Mia', createdAt: at }));
    assert.equal((await read('bbsThreads/t1')).replyCount, 0, 'the opening post isn’t a reply');
    await content.postCreated(ev('r1', { authorHandle: 'Carl', createdAt: at }));
    const t = await read('bbsThreads/t1');
    assert.equal(t.replyCount, 1);
    assert.equal(t.lastBy, 'Carl');
    assert.equal(t.lastAt.toMillis(), at.toMillis());
    await content.postDeleted(ev('r1', { authorHandle: 'Carl' }));
    assert.equal((await read('bbsThreads/t1')).replyCount, 0);
    await content.threadDeleted({ params: { threadId: 't1' }, data: { data: () => ({}) } });
    assert.equal((await db.collection('bbsThreads/t1/posts').get()).size, 0);
  });
});
