// store.js: the Pantry's reads and writes in Firestore. Who may do what is
// decided by the PANTRY section of firestore.rules; this file only asks.
//
//   pantries/{pid}                 the pantry: name, people and their roles
//   pantries/{pid}/items/{id}      food and supplies (counts in lots, see logic.js)
//   pantries/{pid}/activity/{id}   "Ann − 1 Whole milk"
//   pantries/{pid}/shopping/{id}   things added to the shopping list by hand
//   pantryInvites/{code}           points an invite code at a pantry
//
// `me` is always { uid, name }: name is what the household sees in Activity.

import {
  Timestamp, addDoc, arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs,
  limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { db } from '../lib/firebase.js';
import { addToLots, batchCode, makeInviteCode, totalQty, useFromLots } from './logic.js';

const pantryRef = (pid) => doc(db, 'pantries', pid);
const itemsCol = (pid) => collection(db, 'pantries', pid, 'items');
const withId = (snap) => ({ id: snap.id, ...snap.data() });

/** Days an invite code works. */
export const INVITE_DAYS = 7;

const ITEM_KEYS = ['name', 'brand', 'size', 'location', 'keepAtLeast', 'barcodes', 'lots', 'photo', 'notes', 'homemade', 'createdAt'];
function itemData(item, me) {
  const out = {};
  for (const k of ITEM_KEYS) if (item[k] !== undefined) out[k] = item[k];
  out.name = String(out.name || '').trim().slice(0, 120) || 'Unnamed item';
  out.barcodes = (out.barcodes || []).slice(0, 20);
  out.lots = (out.lots || []).slice(0, 50);
  out.updatedBy = me.uid;
  out.updatedAt = serverTimestamp();
  return out;
}

// ---------- pantries -----------------------------------------------------------

/** Every pantry this person is in. */
export async function myPantries(uid) {
  const snap = await getDocs(query(collection(db, 'pantries'), where('memberIds', 'array-contains', uid)));
  return snap.docs.map(withId).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function createPantry(me, name) {
  const ref = doc(collection(db, 'pantries'));
  await setDoc(ref, {
    name: name.trim().slice(0, 60) || 'Household',
    owner: me.uid,
    members: { [me.uid]: 'owner' },
    memberIds: [me.uid],
    memberNames: { [me.uid]: me.name },
    nextBatch: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchPantry(pid, cb, onErr) {
  return onSnapshot(pantryRef(pid), (s) => cb(s.exists() ? withId(s) : null), onErr);
}
export function watchItems(pid, cb, onErr) {
  return onSnapshot(itemsCol(pid), (s) => cb(s.docs.map(withId)), onErr);
}
export function watchShopping(pid, cb, onErr) {
  return onSnapshot(collection(db, 'pantries', pid, 'shopping'), (s) => cb(s.docs.map(withId)), onErr);
}
export function watchActivity(pid, cb, onErr) {
  return onSnapshot(query(collection(db, 'pantries', pid, 'activity'), orderBy('at', 'desc'), limit(40)), (s) => cb(s.docs.map(withId)), onErr);
}

/** Adds a line to Activity. Never blocks the change it describes. */
export function log(pid, me, what) {
  return addDoc(collection(db, 'pantries', pid, 'activity'), {
    by: me.uid, who: String(me.name || '').slice(0, 40), what: String(what).slice(0, 200), at: serverTimestamp(),
  }).catch(() => {});
}

// ---------- items ----------------------------------------------------------------

/** Creates or replaces an item. Returns its id. */
export async function saveItem(pid, me, item) {
  const ref = item.id ? doc(itemsCol(pid), item.id) : doc(itemsCol(pid));
  const data = itemData(item, me);
  delete data.createdAt;
  if (item.id) {
    // merge keeps createdAt; every field the form edits is written in full
    await setDoc(ref, data, { merge: true });
  } else {
    data.createdAt = serverTimestamp();
    await setDoc(ref, data);
  }
  return ref.id;
}

export function deleteItem(pid, itemId) {
  return deleteDoc(doc(itemsCol(pid), itemId));
}

/**
 * Changes an item's count by `delta` (−1 = used one, +1 = got one), safely even
 * when two phones scan at once. Adding with `expires` joins that date's lot.
 * Returns { name, total, changed }.
 */
export async function changeQty(pid, me, itemId, delta, expires) {
  const ref = doc(itemsCol(pid), itemId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That item was deleted.');
    const it = snap.data();
    let lots, changed;
    if (delta < 0) {
      const r = useFromLots(it.lots, -delta);
      lots = r.lots; changed = -r.taken;
    } else {
      lots = addToLots(it.lots, delta, expires); changed = delta;
    }
    if (changed) tx.update(ref, { lots, updatedBy: me.uid, updatedAt: serverTimestamp() });
    return { name: it.name, total: totalQty({ lots }), changed };
  });
}

export async function addBarcode(pid, me, itemId, code) {
  await updateDoc(doc(itemsCol(pid), itemId), { barcodes: arrayUnion(code), updatedBy: me.uid, updatedAt: serverTimestamp() });
}

/**
 * A homemade batch: takes the pantry's next batch number and adds the item with
 * that batch's barcode, in one step, so two people can't get the same number.
 * Returns { id, batch, code }.
 */
export async function addBatch(pid, me, b) {
  const pRef = pantryRef(pid);
  const ref = doc(itemsCol(pid));
  return runTransaction(db, async (tx) => {
    const p = await tx.get(pRef);
    const n = (p.data().nextBatch || 0) + 1;
    const code = batchCode(n);
    tx.update(pRef, { nextBatch: n });
    tx.set(ref, {
      ...itemData({
        name: b.name, brand: '', size: b.size || '', location: b.location || 'Pantry',
        keepAtLeast: null, barcodes: [code], lots: [{ qty: b.qty, expires: b.useBy || '' }],
        photo: '', notes: b.notes || '',
        homemade: { batch: n, method: b.method, made: b.made, useBy: b.useBy || '' },
      }, me),
      createdAt: serverTimestamp(),
    });
    return { id: ref.id, batch: n, code };
  });
}

// ---------- shopping list (added by hand) -------------------------------------------

export function addShopping(pid, me, name) {
  return addDoc(collection(db, 'pantries', pid, 'shopping'), {
    name: name.trim().slice(0, 120), done: false, by: me.uid, who: String(me.name || '').slice(0, 40), at: serverTimestamp(),
  });
}
export function setShoppingDone(pid, id, done) {
  return updateDoc(doc(db, 'pantries', pid, 'shopping', id), { done });
}
export function deleteShopping(pid, id) {
  return deleteDoc(doc(db, 'pantries', pid, 'shopping', id));
}

// ---------- people, invites, settings ---------------------------------------------

/** Owner: a fresh invite code (the old one stops working). Returns the code. */
export async function makeInvite(pantry, me) {
  const code = makeInviteCode();
  const expiresAt = Timestamp.fromMillis(Date.now() + INVITE_DAYS * 86400000);
  const batch = writeBatch(db);
  batch.set(doc(db, 'pantryInvites', code), { pantryId: pantry.id, pantryName: pantry.name, createdBy: me.uid, expiresAt });
  batch.update(pantryRef(pantry.id), { inviteCode: code, inviteExpires: expiresAt, updatedAt: serverTimestamp() });
  await batch.commit();
  if (pantry.inviteCode) deleteDoc(doc(db, 'pantryInvites', pantry.inviteCode)).catch(() => {});
  return code;
}

/** Owner: stop the current code from working. */
export async function cancelInvite(pantry) {
  await updateDoc(pantryRef(pantry.id), { inviteCode: '', updatedAt: serverTimestamp() });
  if (pantry.inviteCode) deleteDoc(doc(db, 'pantryInvites', pantry.inviteCode)).catch(() => {});
}

/** The invite for a code, or null. { pantryId, pantryName, expiresAt } */
export async function lookupInvite(code) {
  const s = await getDoc(doc(db, 'pantryInvites', code));
  return s.exists() ? s.data() : null;
}

/** Joins with a code (the rules check it). */
export function joinPantry(pantryId, code, me) {
  return updateDoc(pantryRef(pantryId), {
    [`members.${me.uid}`]: 'member',
    memberIds: arrayUnion(me.uid),
    [`memberNames.${me.uid}`]: String(me.name || '').slice(0, 40),
    joinCode: code,
  });
}

const without = (uid) => ({ [`members.${uid}`]: deleteField(), memberIds: arrayRemove(uid), [`memberNames.${uid}`]: deleteField() });

/** Leave a pantry (anyone but the owner). */
export function leavePantry(pid, uid) {
  return updateDoc(pantryRef(pid), without(uid));
}

/** Owner: take someone out. */
export function removeMember(pid, uid) {
  return updateDoc(pantryRef(pid), { ...without(uid), updatedAt: serverTimestamp() });
}

/** Owner: "member" or "viewer". */
export function setRole(pid, uid, role) {
  return updateDoc(pantryRef(pid), { [`members.${uid}`]: role, updatedAt: serverTimestamp() });
}

/** Owner: name and use-by defaults ({ "Water bath": 12, … } in months). */
export function updatePantry(pid, fields) {
  const out = { updatedAt: serverTimestamp() };
  if (fields.name !== undefined) out.name = fields.name.trim().slice(0, 60) || 'Household';
  if (fields.useBy !== undefined) out.useBy = fields.useBy;
  return updateDoc(pantryRef(pid), out);
}
