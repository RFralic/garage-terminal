// keys.js: each member's message lock for end-to-end encrypted private messages (e2e.js has
// the crypto). Where things live:
//   bbsKeys/{uid}        { x, y, kid, at }   the public half; any member can read it
//   bbsKeyBackups/{uid}  { kid, v, iter, salt, iv, ct, at }  the private half, scrambled with
//                        the member's passphrase; only they can read it
//   this device          IndexedDB "gt-bbs-lock": the unlocked private key (a CryptoKey that
//                        can't be exported), so the passphrase is only asked once per device
// Also the set-up / unlock panel shown on the Crew tab and in a conversation.
import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../lib/firebase.js';
import { el } from '../lib/ui.js';
import { MIN_PASSPHRASE, WrongPassphrase, convKey, makeLock, rewrap, unlock } from './e2e.js';

// ---------- this device (IndexedDB) -----------------------------------------------------------

const IDB = 'gt-bbs-lock', STORE = 'keys';
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const d = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { d.close(); }
}
const localGet = (uid) => idbDo('readonly', (s) => s.get(uid)).catch(() => null);
const localPut = (uid, v) => idbDo('readwrite', (s) => s.put(v, uid));
const localDel = (uid) => idbDo('readwrite', (s) => s.delete(uid)).catch(() => {});

// ---------- public locks ----------------------------------------------------------------------

const pubs = new Map(); // uid -> Promise<{x,y,kid}|null>
/** Someone's posted lock (cached for this page; `fresh` reads it again). */
export function pubOf(uid, fresh = false) {
  if (fresh || !pubs.has(uid)) {
    pubs.set(uid, getDoc(doc(db, 'bbsKeys', uid)).then((s) => (s.exists() ? s.data() : null)).catch(() => null));
  }
  return pubs.get(uid);
}

// ---------- my lock ------------------------------------------------------------------------------

let mine = null; // { uid, kid, priv }

/**
 * Where I stand on this device:
 *   'none'    no lock yet (first time)
 *   'locked'  I have a lock, but this device hasn't been unlocked with the passphrase
 *   'ready'   good to go; returns { state, kid, priv }
 */
export async function myLock(uid) {
  if (mine?.uid === uid) {
    const p = await pubOf(uid);
    if (p?.kid === mine.kid) return { state: 'ready', ...mine };
  }
  const [p, local] = await Promise.all([pubOf(uid, true), localGet(uid)]);
  if (!p) return { state: 'none' };
  if (local?.kid === p.kid && local.priv) { mine = { uid, kid: local.kid, priv: local.priv }; return { state: 'ready', ...mine }; }
  return { state: 'locked' };
}

async function keep(uid, kid, priv) {
  mine = { uid, kid, priv };
  convKeys.clear();
  try { await localPut(uid, { kid, priv }); } catch (err) { console.warn('lock: couldn’t keep it on this device', err); }
}

/** First time, or starting over after a forgotten passphrase (old messages can't be read after). */
export async function setUp(uid, passphrase) {
  const { pub, backup, priv } = await makeLock(passphrase);
  const b = writeBatch(db);
  b.set(doc(db, 'bbsKeys', uid), { ...pub, at: serverTimestamp() });
  b.set(doc(db, 'bbsKeyBackups', uid), { ...backup, at: serverTimestamp() });
  await b.commit();
  pubs.set(uid, Promise.resolve(pub));
  await keep(uid, pub.kid, priv);
}

export async function unlockHere(uid, passphrase) {
  const [p, s] = await Promise.all([pubOf(uid, true), getDoc(doc(db, 'bbsKeyBackups', uid))]);
  if (!p || !s.exists()) throw new Error('There’s no lock to unlock. Set one up instead.');
  const backup = s.data();
  if (backup.kid !== p.kid) throw new Error('Your saved lock doesn’t match your posted one. Start over to make a new one.');
  await keep(uid, p.kid, await unlock(backup, passphrase));
}

export async function changePassphrase(uid, oldPass, newPass) {
  const s = await getDoc(doc(db, 'bbsKeyBackups', uid));
  if (!s.exists()) throw new Error('There’s no lock yet.');
  const backup = await rewrap(s.data(), oldPass, newPass);
  const b = writeBatch(db);
  b.set(doc(db, 'bbsKeyBackups', uid), { ...backup, at: serverTimestamp() });
  await b.commit();
}

/** Forget the unlocked key on this device (the passphrase brings it back). */
export async function lockThisDevice(uid) {
  mine = null;
  convKeys.clear();
  await localDel(uid);
}

// ---------- conversation keys ----------------------------------------------------------------

const convKeys = new Map(); // `${convId}|${kidA}|${kidB}` -> Promise<CryptoKey>
/**
 * The key for a conversation between my lock and `otherPub`. `members` = the conversation's
 * sorted uids; `kids` = the lock id of each, same order.
 */
export function keyFor(convId, me, otherPub, kids) {
  const id = `${convId}|${kids.join('|')}`;
  if (!convKeys.has(id)) convKeys.set(id, convKey(me.priv, otherPub, convId, kids));
  return convKeys.get(id);
}

// ---------- the panel -----------------------------------------------------------------------

const errText = (err) => (err instanceof WrongPassphrase ? err.message
  : /permission/i.test(err?.code || err?.message || '') ? 'You can’t do that right now.' : (err?.message || 'Something went wrong. Try again.'));

function passField(id, label, hint, autocomplete) {
  const input = el('input', { id, type: 'password', class: 'input', autocomplete, minlength: String(MIN_PASSPHRASE), spellcheck: 'false', autocapitalize: 'off' });
  return { input, row: el('div', { class: 'field', style: 'display:flex;flex-direction:column;gap:6px' },
    el('label', { for: id, style: 'font-weight:600' }, label), input, hint ? el('span', { class: 'small muted' }, hint) : null) };
}

/**
 * The set-up / unlock panel. `state` from myLock(); onDone() runs once this device is ready.
 */
export function lockPanel(ctx, state, onDone) {
  const err = el('p', { class: 'err', role: 'alert', hidden: true });
  const busy = el('p', { class: 'small muted', role: 'status' });
  const box = el('div', { class: 'panel form', style: 'display:flex;flex-direction:column;gap:12px' });
  const fail = (e) => { busy.textContent = ''; err.textContent = errText(e); err.hidden = false; };

  function drawSetUp(startingOver = false) {
    const a = passField('lk-new', 'Make a message passphrase', `At least ${MIN_PASSPHRASE} characters. A few random words is good, like “rusty socket blue mailbox”.`, 'new-password');
    const b = passField('lk-again', 'Type it again', '', 'new-password');
    const go = el('button', { class: 'btn primary', type: 'submit' }, startingOver ? 'Make a new lock' : 'Turn on private messages');
    const form = el('form', { style: 'display:flex;flex-direction:column;gap:12px' }, a.row, b.row, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true;
      if (a.input.value.length < MIN_PASSPHRASE) return fail(new Error(`Use at least ${MIN_PASSPHRASE} characters.`));
      if (a.input.value !== b.input.value) return fail(new Error('The two don’t match.'));
      if (startingOver && !confirm('Start over with a new lock? Messages sent to your old lock can’t be read any more, on any device.')) return;
      go.disabled = true; busy.textContent = 'Making your lock…';
      try { await setUp(ctx.uid, a.input.value); busy.textContent = ''; onDone(); } catch (e2) { go.disabled = false; fail(e2); }
    });
    box.replaceChildren(
      el('h3', { style: 'margin:0' }, startingOver ? '🔒 Start over with a new lock' : '🔒 Private messages are end-to-end encrypted'),
      el('p', { class: 'muted', style: 'margin:0' }, 'Your messages and photos are scrambled on your phone before they’re sent. Only you and the person you’re writing to can read them. Not the sysop, not Firebase.'),
      el('p', { class: 'mutedline', style: 'padding:0' }, 'Write the passphrase down somewhere safe. You’ll need it on a new phone or computer. If you forget it, nobody can get your old messages back, not even the sysop.'),
      form, busy, err,
      startingOver ? el('button', { class: 'link', type: 'button', onclick: () => drawUnlock() }, '← I remember it after all') : null);
    a.input.focus({ preventScroll: true });
  }

  function drawUnlock() {
    const a = passField('lk-pass', 'Your message passphrase', '', 'current-password');
    const go = el('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
    const form = el('form', { style: 'display:flex;flex-direction:column;gap:12px' }, a.row, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true;
      go.disabled = true; busy.textContent = 'Unlocking…';
      try { await unlockHere(ctx.uid, a.input.value); busy.textContent = ''; onDone(); } catch (e2) { go.disabled = false; fail(e2); }
    });
    box.replaceChildren(
      el('h3', { style: 'margin:0' }, '🔒 Unlock your messages on this device'),
      el('p', { class: 'muted', style: 'margin:0' }, 'Type the passphrase you made when you turned on private messages. This device remembers it after that.'),
      form, busy, err,
      el('button', { class: 'link', type: 'button', onclick: () => { err.hidden = true; drawSetUp(true); } }, 'Forgot it? Start over'));
    a.input.focus({ preventScroll: true });
  }

  if (state === 'none') drawSetUp(); else drawUnlock();
  return box;
}

/** Small settings under the conversation list: change passphrase, lock this device. */
export function lockSettings(ctx, onChange) {
  const out = el('details', { class: 'small', style: 'margin-top:10px' }, el('summary', { style: 'cursor:pointer' }, '🔒 Message lock settings'));
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-top:10px' });
  const err = el('p', { class: 'err', role: 'alert', hidden: true });
  const ok = el('p', { class: 'small muted', role: 'status' });
  const a = passField('lk-old', 'Current passphrase', '', 'current-password');
  const b = passField('lk-new2', 'New passphrase', `At least ${MIN_PASSPHRASE} characters.`, 'new-password');
  const go = el('button', { class: 'btn sm', type: 'submit' }, 'Change passphrase');
  const form = el('form', { style: 'display:flex;flex-direction:column;gap:10px' }, a.row, b.row, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true; ok.textContent = '';
    go.disabled = true;
    try { await changePassphrase(ctx.uid, a.input.value, b.input.value); a.input.value = b.input.value = ''; ok.textContent = 'Changed. Use the new one on your other devices from now on.'; }
    catch (e2) { err.textContent = errText(e2); err.hidden = false; }
    finally { go.disabled = false; }
  });
  const lockBtn = el('button', { class: 'btn sm', type: 'button', onclick: async () => {
    if (!confirm('Lock messages on this device? You’ll need your passphrase to read them here again.')) return;
    await lockThisDevice(ctx.uid); onChange?.();
  } }, 'Lock this device');
  body.append(form, ok, err, el('p', { class: 'small muted', style: 'margin:0' }, 'On a shared or borrowed computer, lock it when you’re done.'), lockBtn);
  out.append(body);
  return out;
}
