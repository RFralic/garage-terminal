// repclock-sync.js: saves RepClock workouts to the signed-in member's account.
//
// RepClock itself (apps/repclock/index.html) keeps everything in this device's
// localStorage, under keys starting with "hiit.". This module mirrors the
// important ones to Firestore so they follow the member to any device:
//
//   synced:       hiit.history (every saved workout), hiit.cfg (workout setup),
//                 hiit.goals, hiit.theme, hiit.muted
//   device-only:  hiit.counter, hiit.timer (a count or stopwatch in progress)
//
// Firestore (only the member can read or write their own; see firestore.rules):
//   repclock/{uid}                     { settings: {cfg, goals, theme, muted}, updatedAt }
//   repclock/{uid}/workouts/{id}       { json, date, updatedAt }   one doc per workout
// Values are stored as the same JSON text RepClock keeps in localStorage.
//
// Which account the data on this device belongs to is remembered in
// localStorage "gt.repclock.owner":
//   - never signed in here: RepClock starts at once, device-only, like before
//   - first sign-in here:   workouts already on the device are added to the account
//   - same member again:    the account copy is loaded before RepClock starts
//   - signed out / someone else signs in: the previous member's data is removed
//     from this device (it stays safe in their account)
// Changes are saved to the account a moment after they happen; if the device is
// offline they're kept (flag "gt.repclock.dirty") and sent when it's back online.

import { collection, doc, getDoc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../lib/firebase.js';
import { watchSession } from '../lib/session.js';

const OWNER = 'gt.repclock.owner';
const DIRTY = 'gt.repclock.dirty';
const HISTORY = 'hiit.history';
const SETTINGS = { cfg: 'hiit.cfg', goals: 'hiit.goals', theme: 'hiit.theme', muted: 'hiit.muted' };
const DEVICE_ONLY = ['hiit.counter', 'hiit.timer'];
const SYNCED_KEYS = [HISTORY, ...Object.values(SETTINGS)];
const ALL_KEYS = [...SYNCED_KEYS, ...DEVICE_ONLY];

// ---------- localStorage helpers (never throw; private mode can block storage) ------

const realSetItem = Storage.prototype.setItem;
const realRemoveItem = Storage.prototype.removeItem;
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
/** Write without counting as a RepClock change (so it doesn't trigger a save). */
const write = (k, v) => {
  try {
    if (v == null) realRemoveItem.call(localStorage, k);
    else realSetItem.call(localStorage, k, v);
  } catch { /* storage unavailable */ }
};
const parseList = (text) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; } };

// ---------- status line at the top of RepClock --------------------------------------

function status(text, state = 'wait', link = null) {
  const el = document.getElementById('gtSync');
  if (!el) return;
  el.dataset.state = state;
  el.replaceChildren(text);
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    el.append(' ', a);
  }
}

const start = () => window.__startRepClock?.();
const started = () => !!window.__rcStarted;

// ---------- the device's data and the account's data ---------------------------------

/** What's on this device: settings as JSON text, workouts by id. */
function localState() {
  const settings = {};
  for (const [name, key] of Object.entries(SETTINGS)) {
    const v = read(key);
    if (v != null) settings[name] = v;
  }
  const workouts = new Map();
  for (const w of parseList(read(HISTORY))) {
    const id = String(w?.id ?? '');
    if (/^[0-9]{1,20}$/.test(id)) workouts.set(id, JSON.stringify(w));
  }
  return { settings, workouts };
}

async function loadAccount(uid) {
  const [settingsDoc, workoutDocs] = await Promise.all([
    getDoc(doc(db, 'repclock', uid)),
    getDocs(collection(db, 'repclock', uid, 'workouts')),
  ]);
  return {
    exists: settingsDoc.exists(),
    settings: settingsDoc.exists() ? { ...(settingsDoc.data().settings || {}) } : {},
    workouts: new Map(workoutDocs.docs.map((d) => [d.id, d.data().json])),
  };
}

/** Put a state onto this device. Returns true if anything changed. */
function applyToDevice(state) {
  const before = ALL_KEYS.map(read).join('\u0000');
  for (const [name, key] of Object.entries(SETTINGS)) write(key, state.settings[name] ?? null);
  const history = [...state.workouts.values()]
    .map((json) => { try { return JSON.parse(json); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date))); // newest first, as RepClock keeps it
  write(HISTORY, history.length ? JSON.stringify(history) : null);
  return before !== ALL_KEYS.map(read).join('\u0000');
}

function clearDevice() {
  for (const key of [...ALL_KEYS, OWNER, DIRTY]) write(key, null);
}

// ---------- saving to the account --------------------------------------------------------

let uid = null;
let account = null; // what we last know is in the account (to send only changes)
let saveTimer = null;
let saving = null;

async function save() {
  clearTimeout(saveTimer);
  if (!uid || !account) return;
  if (!navigator.onLine) return offlineStatus(); // saved when the connection comes back ('online')
  if (saving) return saving.then(() => (read(DIRTY) ? save() : undefined));

  saving = (async () => {
    const local = localState();
    const ops = [];
    if (JSON.stringify(local.settings) !== JSON.stringify(account.settings) || !account.exists) {
      ops.push((b) => b.set(doc(db, 'repclock', uid), { settings: local.settings, updatedAt: serverTimestamp() }));
    }
    for (const [id, json] of local.workouts) {
      if (account.workouts.get(id) !== json) {
        const date = String(JSON.parse(json).date ?? '').slice(0, 40);
        ops.push((b) => b.set(doc(db, 'repclock', uid, 'workouts', id), { json, date, updatedAt: serverTimestamp() }));
      }
    }
    for (const id of account.workouts.keys()) {
      if (!local.workouts.has(id)) ops.push((b) => b.delete(doc(db, 'repclock', uid, 'workouts', id)));
    }
    // A batch holds up to 500 writes; send in chunks.
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach((op) => op(batch));
      await batch.commit();
    }
    account = { exists: true, ...local };
    write(DIRTY, null);
  })();

  try {
    await saving;
    status('Saved to your account', 'ok');
  } catch (err) {
    console.error('RepClock sync failed', err);
    status(navigator.onLine ? 'Couldn’t save to your account; will retry' : 'Offline: saved on this device, will sync', 'error');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 30000);
  } finally {
    saving = null;
  }
}

/** True if the device has something the account doesn't. */
function differsFromAccount() {
  if (!account) return true;
  const local = localState();
  if (JSON.stringify(local.settings) !== JSON.stringify(account.settings)) return true;
  if (local.workouts.size !== account.workouts.size) return true;
  for (const [id, json] of local.workouts) if (account.workouts.get(id) !== json) return true;
  return false;
}

const offlineStatus = () => status('Offline: saved on this device, will sync', 'error');

/** RepClock saved something on the device: if it's new, save it to the account shortly. */
function changed() {
  // RepClock re-saves its settings when it starts; only real changes count.
  if (!read(DIRTY) && !differsFromAccount()) return;
  write(DIRTY, '1');
  if (navigator.onLine) status('Saving…');
  else offlineStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1500);
}

function watchRepClockWrites() {
  Storage.prototype.setItem = function (k, v) {
    realSetItem.call(this, k, v);
    if (this === localStorage && SYNCED_KEYS.includes(k)) changed();
  };
  Storage.prototype.removeItem = function (k) {
    realRemoveItem.call(this, k);
    if (this === localStorage && SYNCED_KEYS.includes(k)) changed();
  };
  window.addEventListener('online', () => { if (read(DIRTY)) save(); });
  // Save straight away when the app is put in the background or closed.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && read(DIRTY)) save(); });
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

// ---------- on page load: decide whose data this device shows ---------------------------

async function onSession(s) {
  const owner = read(OWNER);

  if (s.state === 'guest') {
    if (owner) {
      // Someone signed out since last time: their workouts stay in their account,
      // not on this (possibly shared) device.
      clearDevice();
      if (started()) return location.reload();
    }
    window.__rcNote = 'Saved on this device only. Sign in to keep your workouts in your account.';
    start();
    status('Saved on this device.', 'wait', { href: '/join?next=%2Fapps%2Frepclock', label: 'Sign in to sync' });
    return;
  }

  // Signed in (with or without a handle yet): sync with this member's account.
  uid = s.user.uid;
  const name = s.state === 'member' ? s.profile.handle : 'your account';
  status('Syncing…');
  try {
    account = await withTimeout(loadAccount(uid), 8000);
  } catch (err) {
    console.error('RepClock: could not load account data', err);
    // Offline or slow: use what's on the device; save later.
    if (owner && owner !== uid) clearDevice(); // never show someone else's data
    write(OWNER, uid);
    window.__rcNote = `Saved on this device; will sync to ${name} when online.`;
    start();
    watchRepClockWrites();
    status('Offline: saved on this device, will sync', 'error');
    account = null;
    window.addEventListener('online', async () => {
      try { account = await loadAccount(uid); if (read(DIRTY)) save(); else status('Synced', 'ok'); } catch { /* try next time */ }
    }, { once: true });
    return;
  }

  let deviceChanged = false;
  let mustSave = false;
  if (owner === uid) {
    if (read(DIRTY)) mustSave = true; // changes made offline last time: device is newer
    else deviceChanged = applyToDevice(account);
  } else if (!owner) {
    // First sign-in on this device: add the device's workouts to the account.
    const local = localState();
    const merged = {
      settings: account.exists ? account.settings : local.settings,
      workouts: new Map([...account.workouts, ...local.workouts]),
    };
    deviceChanged = applyToDevice(merged);
    mustSave = local.workouts.size > 0 || !account.exists;
  } else {
    // A different member signed in on this device.
    clearDevice();
    deviceChanged = applyToDevice(account) || true;
  }
  write(OWNER, uid);

  window.__rcNote = `Saved to ${name}: your workouts are on every device you sign in on.`;
  window.__rcSynced = true; // shows the History status line as connected
  watchRepClockWrites();
  if (mustSave) {
    write(DIRTY, '1'); // keep the device copy as the newer one until the save succeeds
    await save();
  } else {
    status('Synced', 'ok');
  }

  // RepClock reads its data when it starts. If it already started (slow load),
  // reload once so it shows the account's data.
  if (started() && deviceChanged) return location.reload();
  start();
}

let handled = false;
watchSession((s) => {
  if (s.state === 'loading' || handled) return;
  handled = true;
  onSession(s).catch((err) => {
    console.error(err);
    start();
  });
});
