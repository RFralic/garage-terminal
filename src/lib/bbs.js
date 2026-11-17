// bbs.js: data for the BBS (/bbs and the BBS tab in /mod).
//
// Reads go straight to Firestore; firestore.rules decide who may read what.
// Changes to the member list and settings go through the `bbs` Cloud Function
// (functions/bbs.js), which checks sysop / co-sysop powers and writes the mod log.

import { httpsCallable } from 'firebase/functions';
import {
  collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc,
} from 'firebase/firestore';
import { db, functions } from './firebase.js';

export const DEFAULT_CONFIG = { doorWord: 'backroom', requirePasscode: false, notice: '' };
export const PRESENT_MS = 5 * 60 * 1000; // "In the shop now": seen in the last 5 minutes

const callBbs = httpsCallable(functions, 'bbs');
const callKnock = httpsCallable(functions, 'bbsKnock');
const message = (err) => new Error(err?.message?.replace(/^.*?: /, '') || 'That didn’t work. Try again.');

/** A sysop / co-sysop action, e.g. bbsAction('request.approve', { uid }). */
export async function bbsAction(action, params = {}) {
  try { return (await callBbs({ action, ...params })).data; } catch (err) { throw message(err); }
}

/** The passcode check. Returns { ok } / { ok:false, triesLeft } / { ok:false, lockedMinutes }. */
export async function knock(code) {
  try { return (await callKnock({ code })).data; } catch (err) { throw message(err); }
}

export async function getConfig() {
  try {
    const snap = await getDoc(doc(db, 'bbsConfig', 'main'));
    return { ...DEFAULT_CONFIG, ...(snap.data() ?? {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
export function watchConfig(cb) {
  return onSnapshot(doc(db, 'bbsConfig', 'main'), (s) => cb({ ...DEFAULT_CONFIG, ...(s.data() ?? {}) }), () => cb({ ...DEFAULT_CONFIG }));
}

// ---------- me ----------------------------------------------------------------------

export const getMember = async (uid) => {
  const s = await getDoc(doc(db, 'bbsMembers', uid));
  return s.exists() ? { uid, ...s.data() } : null;
};
export const watchMember = (uid, cb) =>
  onSnapshot(doc(db, 'bbsMembers', uid), (s) => cb(s.exists() ? { uid, ...s.data() } : null), () => cb(null));
export const getRequest = async (uid) => (await getDoc(doc(db, 'bbsRequests', uid))).data() ?? null;
export const watchRequest = (uid, cb) => onSnapshot(doc(db, 'bbsRequests', uid), (s) => cb(s.exists() ? s.data() : null), () => cb(null));
export const getDenied = async (uid) => (await getDoc(doc(db, 'bbsDenied', uid))).data() ?? null;
export const askToJoin = (uid, handle) => setDoc(doc(db, 'bbsRequests', uid), { handle, createdAt: serverTimestamp() });
export const cancelRequest = (uid) => deleteDoc(doc(db, 'bbsRequests', uid));
/** Presence: "last seen now". */
export const touch = (uid) => updateDoc(doc(db, 'bbsMembers', uid), { lastSeen: serverTimestamp() }).catch(() => {});

// ---------- the crew and the sysop lists ----------------------------------------------

const list = (snap) => snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
export const watchCrew = (cb, onError) => onSnapshot(collection(db, 'bbsMembers'), (s) => cb(list(s)), onError);
export const loadRequests = async () => list(await getDocs(query(collection(db, 'bbsRequests'), orderBy('createdAt', 'desc'))));
export const watchRequests = (cb, onError) => onSnapshot(query(collection(db, 'bbsRequests'), orderBy('createdAt', 'desc')), (s) => cb(list(s)), onError);
export const loadMembers = async () => list(await getDocs(collection(db, 'bbsMembers')));
export const loadDenied = async () => {
  const now = Date.now();
  return list(await getDocs(collection(db, 'bbsDenied'))).filter((d) => d.until?.toMillis?.() > now)
    .sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0));
};
export const loadRemoved = async () => list(await getDocs(collection(db, 'bbsRemoved')))
  .sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0));

/** Sort the crew: sysop, co-sysops, then everyone by handle. */
export const ROLE_ORDER = { sysop: 0, cosysop: 1, member: 2 };
export const byRank = (a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || String(a.handle).localeCompare(String(b.handle));
export const roleLabel = (r) => (r === 'sysop' ? 'Sysop' : r === 'cosysop' ? 'Co-sysop' : '');
export const isHere = (m, now = Date.now()) => !!m.lastSeen?.toMillis && now - m.lastSeen.toMillis() < PRESENT_MS;
