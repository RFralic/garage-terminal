// End-to-end encryption for private messages (src/bbs/e2e.js): locks, passphrase backup,
// both sides getting the same conversation key, and sealed messages that can't be read,
// moved or passed off as someone else's.  Run with:  npm test  (or: node --test tests/dm.crypto.test.js)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITERATIONS, WrongPassphrase, convKey, fromB64, kidOf, makeLock, openBytes, openText, rewrap, safetyCode, sealBytes, sealText, toB64, unlock,
} from '../src/bbs/e2e.js';

const CONV = 'carl_mia';
const PASS_C = 'rusty socket blue mailbox', PASS_M = 'torque wrench at dawn';

// PBKDF2 at 600,000 rounds is slow-ish on purpose; make the two locks once.
const carlP = makeLock(PASS_C), miaP = makeLock(PASS_M);
async function pair() {
  const [carl, mia] = await Promise.all([carlP, miaP]);
  const kids = [carl.pub.kid, mia.pub.kid]; // sorted members: carl, mia
  const kc = await convKey(carl.priv, mia.pub, CONV, kids);
  const km = await convKey(mia.priv, carl.pub, CONV, kids);
  return { carl, mia, kids, kc, km };
}

describe('locks', () => {
  test('a lock has a public half, an id from it, and a backup the rules accept', async () => {
    const { pub, backup, priv } = await carlP;
    assert.equal(pub.x.length, 43);
    assert.equal(pub.y.length, 43);
    assert.equal(pub.kid, await kidOf(pub));
    assert.match(pub.kid, /^[0-9a-f]{16}$/);
    assert.equal(backup.kid, pub.kid);
    assert.equal(backup.iter, ITERATIONS);
    assert.equal(backup.salt.length, 24);
    assert.equal(backup.iv.length, 16);
    assert.ok(backup.ct.length >= 100 && backup.ct.length <= 600, `ct length ${backup.ct.length}`);
    assert.equal(priv.extractable, false);
  });
  test('short passphrases are refused', async () => {
    await assert.rejects(makeLock('short'), /at least/);
  });
  test('the backup opens with the passphrase and nothing else', async () => {
    const { carl, mia, kids, km } = await pair();
    await assert.rejects(unlock(carl.backup, 'wrong passphrase!'), WrongPassphrase);
    const again = await unlock(carl.backup, PASS_C);
    // The unlocked copy makes the same conversation key: Mia's sealed message opens with it.
    const k2 = await convKey(again, mia.pub, CONV, kids);
    const enc = await sealText(km, 'hello', CONV, 'mia');
    assert.equal(await openText(k2, enc, CONV, 'mia'), 'hello');
  });
  test('changing the passphrase keeps the lock', async () => {
    const { carl } = await pair();
    const nb = await rewrap(carl.backup, PASS_C, 'brand new passphrase');
    assert.equal(nb.kid, carl.backup.kid);
    await assert.rejects(unlock(nb, PASS_C), WrongPassphrase);
    await unlock(nb, 'brand new passphrase');
    await assert.rejects(rewrap(carl.backup, 'not it at all', 'whatever else'), WrongPassphrase);
  });
});

describe('messages', () => {
  test('both members get the same key; words go both ways', async () => {
    const { kc, km } = await pair();
    const enc = await sealText(kc, 'Got the puller? 🔧', CONV, 'carl');
    assert.equal(fromB64(enc.iv).length, 12);
    assert.ok(!enc.ct.includes('puller'));
    assert.equal(await openText(km, enc, CONV, 'carl'), 'Got the puller? 🔧');
    const back = await sealText(km, 'yep', CONV, 'mia');
    assert.equal(await openText(kc, back, CONV, 'mia'), 'yep');
  });
  test('the same words seal differently every time', async () => {
    const { kc } = await pair();
    const a = await sealText(kc, 'same', CONV, 'carl'), b = await sealText(kc, 'same', CONV, 'carl');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });
  test('a sealed message can’t be passed off as the other person’s, or moved to another conversation', async () => {
    const { kc, km } = await pair();
    const enc = await sealText(kc, 'from carl', CONV, 'carl');
    await assert.rejects(openText(km, enc, CONV, 'mia'));
    await assert.rejects(openText(km, enc, 'carl_pete', 'carl'));
  });
  test('a changed byte is caught', async () => {
    const { kc, km } = await pair();
    const enc = await sealText(kc, 'from carl', CONV, 'carl');
    const ct = fromB64(enc.ct); ct[3] ^= 1;
    await assert.rejects(openText(km, { ...enc, ct: toB64(ct) }, CONV, 'carl'));
  });
  test('someone else’s lock can’t open it', async () => {
    const { carl, kc, kids } = await pair();
    const pete = await makeLock('pete has a long passphrase');
    const kp = await convKey(pete.priv, carl.pub, CONV, kids);
    const enc = await sealText(kc, 'secret', CONV, 'carl');
    await assert.rejects(openText(kp, enc, CONV, 'carl'));
  });
  test('photos: bytes sealed as a photo open only as a photo', async () => {
    const { kc, km } = await pair();
    const jpg = new Uint8Array(5000).map((_, i) => i % 251);
    const s = await sealBytes(kc, jpg, CONV, 'carl', 'photo');
    assert.deepEqual(await openBytes(km, s, CONV, 'carl', 'photo'), jpg);
    await assert.rejects(openBytes(km, s, CONV, 'carl'));
  });
});

describe('safety code', () => {
  test('the same on both sides, 12 digits, and different for another lock', async () => {
    const { carl, mia } = await pair();
    const a = await safetyCode(carl.pub, mia.pub), b = await safetyCode(mia.pub, carl.pub);
    assert.equal(a, b);
    assert.match(a, /^\d{4} \d{4} \d{4}$/);
    const pete = await makeLock('pete has a long passphrase');
    assert.notEqual(await safetyCode(carl.pub, pete.pub), a);
  });
});
