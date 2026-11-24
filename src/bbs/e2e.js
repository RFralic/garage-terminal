// e2e.js: the end-to-end encryption for BBS private messages. Pure Web Crypto (in every
// browser, and in Node 20+ for the tests): no Firebase here, nothing is sent anywhere.
//
// How it works
//   - Each member has one "lock": an ECDH P-256 key pair made on their own device.
//     The public half is posted at bbsKeys/{uid} so other members can write to them.
//   - The private half never leaves the device unscrambled. A copy, scrambled with the
//     member's message passphrase (PBKDF2-SHA256, 600,000 rounds → AES-GCM), is kept at
//     bbsKeyBackups/{uid} (only they can read it) so another phone or computer can unlock
//     it with the same passphrase. Forget the passphrase and that copy is useless.
//   - Two members' locks give both of them the same conversation key (ECDH → HKDF-SHA256,
//     salted with the conversation id and both lock ids). Each message and photo is sealed
//     with AES-256-GCM, a fresh 12-byte nonce, and "<convId>|<sender uid>" as associated
//     data, so a message can't be passed off as the other member's or moved to another
//     conversation.
//   - The server (Firebase, Google, the sysop) only ever sees scrambled bytes. What it
//     could still do is swap someone's posted public lock for its own; comparing the
//     safety code in person (or on a call) catches that.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();

export const ITERATIONS = 600000;
export const MIN_PASSPHRASE = 10;

// ---------- small helpers -------------------------------------------------------------------

export function toB64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

/** The public half as posted: { x, y } (base64url, as in a JWK). */
const pubJwk = (pub) => ({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, ext: true });
const importPub = (pub) => subtle.importKey('jwk', pubJwk(pub), ECDH, true, []);

/** A lock's id: the first 16 hex digits of SHA-256 of its public point. */
export async function kidOf(pub) {
  const raw = await subtle.exportKey('raw', await importPub(pub));
  return hex(await subtle.digest('SHA-256', raw)).slice(0, 16);
}

async function passKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Re-import a PKCS#8 private key so it can't be exported again (safe to keep on the device). */
const importPriv = (pkcs8) => subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);

async function wrap(pkcs8, passphrase, kid) {
  const salt = rand(16), iv = rand(12);
  const key = await passKey(passphrase, salt, ITERATIONS);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`gt-lock|${kid}`) }, key, pkcs8);
  return { kid, v: 1, iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

// ---------- the lock --------------------------------------------------------------------------

/**
 * Make a new lock. Returns
 *   pub:     { x, y, kid }  → bbsKeys/{uid}
 *   backup:  { kid, v, iter, salt, iv, ct } → bbsKeyBackups/{uid}
 *   priv:    a non-exportable CryptoKey to keep on this device
 */
export async function makeLock(passphrase) {
  if ((passphrase || '').length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`);
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  const pub = { x: jwk.x, y: jwk.y };
  const kid = await kidOf(pub);
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  const backup = await wrap(pkcs8, passphrase, kid);
  return { pub: { ...pub, kid }, backup, priv: await importPriv(pkcs8) };
}

/** Open the scrambled copy with the passphrase. Throws WrongPassphrase if it doesn't fit. */
export class WrongPassphrase extends Error { constructor() { super('That passphrase doesn’t open your messages.'); } }
async function unwrapRaw(backup, passphrase) {
  const key = await passKey(passphrase, fromB64(backup.salt), backup.iter || ITERATIONS);
  try {
    return await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(backup.iv), additionalData: te.encode(`gt-lock|${backup.kid}`) }, key, fromB64(backup.ct));
  } catch { throw new WrongPassphrase(); }
}
export async function unlock(backup, passphrase) {
  return importPriv(await unwrapRaw(backup, passphrase));
}
/** Same lock, new passphrase (needs the old one). Returns a new backup record. */
export async function rewrap(backup, oldPassphrase, newPassphrase) {
  if ((newPassphrase || '').length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`);
  return wrap(await unwrapRaw(backup, oldPassphrase), newPassphrase, backup.kid);
}

// ---------- a conversation ----------------------------------------------------------------------

/**
 * The shared key for convId between my lock and theirs. `kids` = both lock ids in the order of
 * the conversation's sorted members, so both sides derive the same key.
 */
export async function convKey(myPriv, theirPub, convId, kids) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: await importPub(theirPub) }, myPriv, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(`gt-dm-v1|${convId}`), info: te.encode(`gt-dm-v1|${kids.join('|')}`) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const aad = (convId, uid, kind) => te.encode(`${convId}|${uid}${kind ? `|${kind}` : ''}`);

/** Seal bytes. Returns { iv, ct } (base64). */
export async function sealBytes(key, bytes, convId, uid, kind = '') {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(convId, uid, kind) }, key, bytes);
  return { iv: toB64(iv), ct: new Uint8Array(ct) };
}
export async function openBytes(key, { iv, ct }, convId, uid, kind = '') {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: aad(convId, uid, kind) }, key, ct));
}

/** Seal a message's words. Returns { iv, ct } with ct base64. */
export async function sealText(key, text, convId, uid) {
  const { iv, ct } = await sealBytes(key, te.encode(JSON.stringify({ t: text })), convId, uid);
  return { iv, ct: toB64(ct) };
}
export async function openText(key, enc, convId, uid) {
  const out = await openBytes(key, { iv: enc.iv, ct: fromB64(enc.ct) }, convId, uid);
  return String(JSON.parse(td.decode(out)).t ?? '');
}

/**
 * The safety code both members see for their two locks: 12 digits in groups of four.
 * Same on both phones; if it ever differs, one of the posted locks isn't the real one.
 */
export async function safetyCode(pubA, pubB) {
  const raws = await Promise.all([pubA, pubB].map(async (p) => new Uint8Array(await subtle.exportKey('raw', await importPub(p)))));
  raws.sort((a, b) => (toB64(a) < toB64(b) ? -1 : 1));
  const joined = new Uint8Array(raws[0].length + raws[1].length);
  joined.set(raws[0]); joined.set(raws[1], raws[0].length);
  const h = new Uint8Array(await subtle.digest('SHA-256', joined));
  const groups = [];
  for (let i = 0; i < 3; i++) {
    const n = ((h[i * 3] << 16) | (h[i * 3 + 1] << 8) | h[i * 3 + 2]) % 10000;
    groups.push(String(n).padStart(4, '0'));
  }
  return groups.join(' ');
}
