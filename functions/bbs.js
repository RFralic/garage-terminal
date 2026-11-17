// bbs.js: the BBS's Cloud Functions (see firestore.rules, BBS section).
//
//   bbsHandler      the `bbs` callable: every sysop / co-sysop action, always logged
//   knockHandler    the `bbsKnock` callable: checks the passcode (when it's switched on)
//   requestEmail    a new request -> email the sysop right away
//   welcomeEmail    a new member -> "You're in" email to them
//
// Powers:
//   sysop (admins/)   everything
//   co-sysop          approve, deny, add, remove members, let denied / removed people in
//                     (and, later, moderate posts and chat)
//   sysop only        make / remove co-sysops, BBS settings, boards
// The sysop can't be removed or demoted here.
//
// Actions for `bbs({ action, ... })`:
//   enter                         first visit of the sysop: adds them to the Crew list
//   request.approve  { uid }      member now, request gone
//   request.deny     { uid }      request gone, can't ask again for 30 days
//   member.add       { uid }      any site account with a handle; in at once
//   member.remove    { uid }      access ends immediately; listed under Removed
//   member.role      { uid, role: 'cosysop' | 'member' }            sysop only
//   denied.letIn     { uid }      member now, wait cleared
//   denied.clear     { uid }      may ask again
//   removed.restore  { uid }      member again
//   accounts.search  { text }     site accounts by handle (for "+ Add a member")
//   settings.update  { doorWord?, requirePasscode?, notice? }      sysop only
//   board.save       { id?, name, description, order }  add (no id) or rename / reorder   sysop only
//   board.archive    { id, archived }   archived boards leave the home grid, read-only    sysop only
//   member.mute      { uid, minutes }   60, 1440, null = until unmuted, 0 = unmute    sysop / co-sysop
//   chat.save        { chatId, boardId, note }  any member: a Shop Talk message becomes a thread on a
//                    board, credited to whoever said it, with its photo copied out of the chat folder
//                    (so it outlives the 7-day clean-up). Not a moderation action, so not logged.

import { createHash, timingSafeEqual } from 'node:crypto';
import { getFirestore, FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { sendMail } from './resend.js';

export const SITE = 'https://garageterminal.com';
const FROM = 'Garage Terminal BBS <brief@garageterminal.com>';
const REPLY_TO = 'support@garageterminal.com';
const DAY = 24 * 60 * 60 * 1000;
export const DENY_DAYS = 30;
export const MAX_TRIES = 5;
export const LOCK_MINUTES = 15;
export const DOOR_WORD = /^[a-z0-9]{3,24}$/;
export const DEFAULT_CONFIG = { doorWord: 'backroom', requirePasscode: false, notice: '' };

const bad = (message) => new HttpsError('invalid-argument', message);
const uidArg = (v) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw bad('uid is not valid');
  return v;
};

const boardIdArg = (v) => {
  if (typeof v !== 'string' || !/^[a-z0-9-]{1,60}$/.test(v)) throw bad('board id is not valid');
  return v;
};

/** Who is calling: sysop? member doc? */
async function caller(db, uid) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const [admin, member, user] = await Promise.all([
    db.doc(`admins/${uid}`).get(), db.doc(`bbsMembers/${uid}`).get(), db.doc(`users/${uid}`).get(),
  ]);
  const isSysop = admin.exists;
  const role = isSysop ? 'sysop' : member.get('role') ?? null;
  return { uid, isSysop, isMod: isSysop || role === 'cosysop', member, handle: user.get('handle') ?? '' };
}

/** A site account's handle, or "not found". */
async function handleOf(db, uid) {
  const user = await db.doc(`users/${uid}`).get();
  if (!user.exists || !user.get('handle')) throw new HttpsError('not-found', 'No site account with a handle');
  return user.get('handle');
}

/** Make `uid` a member (or restore one). Clears any request, denial and removal. */
async function makeMember(db, uid, handle, byHandle) {
  const batch = db.batch();
  batch.set(db.doc(`bbsMembers/${uid}`), {
    handle, role: 'member', since: FieldValue.serverTimestamp(), addedBy: byHandle, lastSeen: null,
  });
  batch.delete(db.doc(`bbsRequests/${uid}`));
  batch.delete(db.doc(`bbsDenied/${uid}`));
  batch.delete(db.doc(`bbsRemoved/${uid}`));
  await batch.commit();
}

export async function bbsHandler(request) {
  const db = getFirestore();
  const me = await caller(db, request.auth?.uid);
  const data = request.data ?? {};
  const action = typeof data.action === 'string' ? data.action : '';

  const log = (targetPath, details = {}) => db.collection('modlog').add({
    action: `bbs.${action}`, targetPath, byUid: me.uid, byHandle: me.handle, reason: '', details,
    createdAt: FieldValue.serverTimestamp(),
  });
  const needMod = () => { if (!me.isMod) throw new HttpsError('permission-denied', 'Sysop or co-sysop only'); };
  const needSysop = () => { if (!me.isSysop) throw new HttpsError('permission-denied', 'Sysop only'); };
  /** Members a co-sysop may not touch: the sysop, and (unless you're the sysop) other co-sysops. */
  const guardTarget = async (uid) => {
    if (uid === me.uid) throw bad('That’s you');
    if ((await db.doc(`admins/${uid}`).get()).exists) throw new HttpsError('permission-denied', 'The sysop can’t be changed here');
    const m = await db.doc(`bbsMembers/${uid}`).get();
    if (m.exists && m.get('role') === 'cosysop' && !me.isSysop) throw new HttpsError('permission-denied', 'Only the sysop can remove a co-sysop');
    return m;
  };

  switch (action) {
    case 'enter': {
      if (!me.isSysop) return { role: me.member.get('role') ?? null };
      if (!me.member.exists) {
        await db.doc(`bbsMembers/${me.uid}`).set({
          handle: me.handle, role: 'sysop', since: FieldValue.serverTimestamp(), addedBy: me.handle, lastSeen: null,
        });
      } else if (me.member.get('role') !== 'sysop') {
        await me.member.ref.update({ role: 'sysop' });
      }
      return { role: 'sysop' };
    }

    case 'request.approve': {
      needMod();
      const uid = uidArg(data.uid);
      const req = await db.doc(`bbsRequests/${uid}`).get();
      if (!req.exists) throw new HttpsError('not-found', 'That request is gone');
      const handle = await handleOf(db, uid);
      await makeMember(db, uid, handle, me.handle);
      await log(`bbsMembers/${uid}`, { handle });
      return { ok: true };
    }

    case 'request.deny': {
      needMod();
      const uid = uidArg(data.uid);
      const req = await db.doc(`bbsRequests/${uid}`).get();
      if (!req.exists) throw new HttpsError('not-found', 'That request is gone');
      const handle = req.get('handle') ?? '';
      const batch = db.batch();
      batch.delete(req.ref);
      batch.set(db.doc(`bbsDenied/${uid}`), {
        handle, at: FieldValue.serverTimestamp(), until: Timestamp.fromMillis(Date.now() + DENY_DAYS * DAY), by: me.handle,
      });
      await batch.commit();
      await log(`bbsDenied/${uid}`, { handle });
      return { ok: true };
    }

    case 'member.add':
    case 'denied.letIn':
    case 'removed.restore': {
      needMod();
      const uid = uidArg(data.uid);
      if ((await db.doc(`bbsMembers/${uid}`).get()).exists) throw bad('Already a member');
      if ((await db.doc(`admins/${uid}`).get()).exists) throw bad('That’s the sysop');
      const handle = await handleOf(db, uid);
      await makeMember(db, uid, handle, me.handle);
      await log(`bbsMembers/${uid}`, { handle });
      return { ok: true };
    }

    case 'member.remove': {
      needMod();
      const uid = uidArg(data.uid);
      const m = await guardTarget(uid);
      if (!m.exists) throw new HttpsError('not-found', 'Not a member');
      const batch = db.batch();
      batch.delete(m.ref);
      batch.set(db.doc(`bbsRemoved/${uid}`), { handle: m.get('handle') ?? '', at: FieldValue.serverTimestamp(), by: me.handle });
      await batch.commit();
      await log(`bbsMembers/${uid}`, { handle: m.get('handle') });
      return { ok: true };
    }

    case 'member.role': {
      needSysop();
      const uid = uidArg(data.uid);
      const role = data.role;
      if (role !== 'cosysop' && role !== 'member') throw bad('role must be cosysop or member');
      const m = await guardTarget(uid);
      if (!m.exists) throw new HttpsError('not-found', 'Not a member');
      await m.ref.update({ role });
      await log(`bbsMembers/${uid}`, { handle: m.get('handle'), role });
      return { ok: true };
    }

    case 'denied.clear': {
      needMod();
      const uid = uidArg(data.uid);
      const d = await db.doc(`bbsDenied/${uid}`).get();
      if (!d.exists) throw new HttpsError('not-found', 'Not on the denied list');
      await d.ref.delete();
      await log(`bbsDenied/${uid}`, { handle: d.get('handle') });
      return { ok: true };
    }

    case 'accounts.search': {
      needMod();
      const text = String(data.text ?? '').trim().toLowerCase().slice(0, 20);
      if (!text) return { accounts: [] };
      const handles = await db.collection('handles')
        .where(FieldPath.documentId(), '>=', text)
        .where(FieldPath.documentId(), '<', `${text}\uf8ff`)
        .limit(15).get();
      const accounts = await Promise.all(handles.docs.map(async (h) => {
        const uid = h.get('uid');
        const [user, member, admin] = await Promise.all([
          db.doc(`users/${uid}`).get(), db.doc(`bbsMembers/${uid}`).get(), db.doc(`admins/${uid}`).get(),
        ]);
        return user.exists ? { uid, handle: user.get('handle'), member: member.exists || admin.exists } : null;
      }));
      return { accounts: accounts.filter(Boolean) };
    }

    case 'settings.update': {
      needSysop();
      const ref = db.doc('bbsConfig/main');
      const cur = { ...DEFAULT_CONFIG, ...((await ref.get()).data() ?? {}) };
      const next = { ...cur };
      if (data.doorWord !== undefined) {
        const w = String(data.doorWord).trim().toLowerCase();
        if (!DOOR_WORD.test(w)) throw bad('The door word must be 3–24 letters or numbers, no spaces');
        next.doorWord = w;
      }
      if (data.requirePasscode !== undefined) {
        if (typeof data.requirePasscode !== 'boolean') throw bad('requirePasscode must be true or false');
        next.requirePasscode = data.requirePasscode;
      }
      if (data.notice !== undefined) {
        const n = String(data.notice).trim();
        if (n.length > 1000) throw bad('The notice is too long (1,000 characters at most)');
        next.notice = n;
      }
      await ref.set(next);
      const changed = Object.fromEntries(Object.keys(next).filter((k) => next[k] !== cur[k]).map((k) => [k, next[k]]));
      await log('bbsConfig/main', changed);
      return { ok: true };
    }

    case 'board.save': {
      needSysop();
      const name = String(data.name ?? '').trim();
      const description = String(data.description ?? '').trim();
      const order = Number(data.order);
      if (name.length < 1 || name.length > 40) throw bad('A board name is 1–40 characters');
      if (description.length > 200) throw bad('The description is 200 characters at most');
      if (!Number.isInteger(order) || order < 1 || order > 99) throw bad('Order is a whole number from 1 to 99');
      if (data.id) {
        const ref = db.doc(`bbsBoards/${boardIdArg(data.id)}`);
        const cur = await ref.get();
        if (!cur.exists) throw new HttpsError('not-found', 'No such board');
        await ref.update({ name, description, order });
        await log(ref.path, { name, order, was: cur.get('name') });
        return { id: ref.id };
      }
      // New board: an address made from its name ("Small Engines" -> small-engines).
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';
      let id = base;
      for (let n = 2; (await db.doc(`bbsBoards/${id}`).get()).exists; n++) id = `${base}-${n}`;
      await db.doc(`bbsBoards/${id}`).set({ name, description, order, archived: false, createdAt: FieldValue.serverTimestamp() });
      await log(`bbsBoards/${id}`, { name, order });
      return { id };
    }

    case 'board.archive': {
      needSysop();
      const ref = db.doc(`bbsBoards/${boardIdArg(data.id)}`);
      const cur = await ref.get();
      if (!cur.exists) throw new HttpsError('not-found', 'No such board');
      if (typeof data.archived !== 'boolean') throw bad('archived must be true or false');
      await ref.update({ archived: data.archived });
      await log(ref.path, { name: cur.get('name'), archived: data.archived });
      return { ok: true };
    }

    case 'member.mute': {
      needMod();
      const uid = uidArg(data.uid);
      const m = await guardTarget(uid);
      if (!m.exists) throw new HttpsError('not-found', 'Not a member');
      const minutes = data.minutes;
      let until;
      if (minutes === 0) until = FieldValue.delete();
      else if (minutes === null) until = Timestamp.fromMillis(Date.UTC(2100, 0, 1)); // until unmuted
      else if (minutes === 60 || minutes === 1440) until = Timestamp.fromMillis(Date.now() + minutes * 60000);
      else throw bad('minutes must be 60, 1440, null (until unmuted) or 0 (unmute)');
      await m.ref.update({ mutedUntil: until });
      await log(m.ref.path, { handle: m.get('handle'), muted: minutes === 0 ? 'no' : minutes === null ? 'until unmuted' : `${minutes / 60} h` });
      return { ok: true };
    }

    case 'chat.save': {
      if (!me.isSysop && !me.member.exists) throw new HttpsError('permission-denied', 'Members only');
      const chatId = typeof data.chatId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.chatId) ? data.chatId : null;
      if (!chatId) throw bad('chatId is not valid');
      const boardId = boardIdArg(data.boardId);
      const note = String(data.note ?? '').trim();
      if (note.length > 500) throw bad('The note is 500 characters at most');
      const [msg, board] = await Promise.all([db.doc(`bbsChat/${chatId}`).get(), db.doc(`bbsBoards/${boardId}`).get()]);
      if (!msg.exists || msg.get('kind') !== 'msg') throw new HttpsError('not-found', 'That message is gone');
      if (!board.exists || board.get('archived')) throw bad('That board isn’t open');
      const m = msg.data();
      const threadRef = db.collection('bbsThreads').doc();
      // Copy the photo out of the chat folder, so it survives the 7-day clean-up.
      let photo = null;
      if (m.photo?.path) {
        const bucket = getStorage().bucket();
        const dest = `bbs/posts/${m.uid}/${threadRef.id}.jpg`;
        const [bytes] = await bucket.file(m.photo.path).download();
        await bucket.file(dest).save(bytes, { contentType: 'image/jpeg', resumable: false });
        photo = { path: dest, w: m.photo.w ?? 0, h: m.photo.h ?? 0 };
      }
      const from = (note || m.text || '').replace(/\s+/g, ' ').trim();
      // Title: the start of the note or message, cut at a word (60 characters at most).
      let title = from || 'Photo from Shop Talk';
      if (title.length > 60) {
        let cut = title.slice(0, 59);
        if (cut.lastIndexOf(' ') > 40) cut = cut.slice(0, cut.lastIndexOf(' '));
        title = `${cut.trimEnd()}…`;
      }
      const now = FieldValue.serverTimestamp();
      const batch = db.batch();
      batch.set(threadRef, {
        boardId, title, authorUid: m.uid, authorHandle: m.handle, createdAt: now, lastAt: now, lastBy: m.handle,
        replyCount: 0, pinned: false, locked: false, saved: true, savedBy: me.handle,
      });
      batch.set(threadRef.collection('posts').doc('op'), {
        authorUid: m.uid, authorHandle: m.handle, body: '', createdAt: now, ...(photo ? { photo } : {}),
        saved: { who: m.handle, at: m.createdAt, text: m.text ?? '', link: m.link ?? '', note, by: me.handle },
      });
      batch.update(msg.ref, { savedTo: { boardId, threadId: threadRef.id, by: me.handle } });
      await batch.commit();
      return { threadId: threadRef.id, boardName: board.get('name') };
    }

    default:
      throw bad('Unknown action');
  }
}

// ---------- the passcode (switched off unless the sysop turns it on) ---------------------

/** Equal-time comparison, so the answer time doesn't hint at the right code. */
function sameCode(a, b) {
  const h = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
}

/**
 * bbsKnock({ code }): with the passcode switched on, a right code files the join
 * request. 5 wrong tries lock the account out for 15 minutes (counted here, on
 * the server, in bbsKnocks/{uid}). `passcode` is the BBS_PASSCODE secret.
 * Returns { ok: true } or { ok: false, triesLeft } or { ok: false, lockedMinutes }.
 */
export async function knockHandler(request, passcode) {
  const db = getFirestore();
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const code = String(request.data?.code ?? '');
  if (!/^[0-9]{6}$/.test(code)) throw bad('The passcode is 6 digits');

  const config = { ...DEFAULT_CONFIG, ...((await db.doc('bbsConfig/main').get()).data() ?? {}) };
  if (!config.requirePasscode) throw new HttpsError('failed-precondition', 'No passcode is needed right now');
  const handle = await handleOf(db, uid);
  if ((await db.doc(`bbsMembers/${uid}`).get()).exists) return { ok: true, member: true };
  const denied = await db.doc(`bbsDenied/${uid}`).get();
  if (denied.exists && denied.get('until').toMillis() > Date.now()) {
    throw new HttpsError('permission-denied', 'You can’t ask again yet');
  }
  if (!/^[0-9]{6}$/.test(String(passcode ?? ''))) {
    logger.error('BBS_PASSCODE secret is missing or not 6 digits');
    throw new HttpsError('failed-precondition', 'The passcode isn’t set up yet. Ask the sysop.');
  }

  const knockRef = db.doc(`bbsKnocks/${uid}`);
  return db.runTransaction(async (tx) => {
    const reqRef = db.doc(`bbsRequests/${uid}`);
    const [knockSnap, reqSnap] = await Promise.all([tx.get(knockRef), tx.get(reqRef)]); // reads before writes
    const k = knockSnap.data() ?? { fails: 0, lockedUntil: null };
    const now = Date.now();
    if (k.lockedUntil && k.lockedUntil.toMillis() > now) {
      return { ok: false, lockedMinutes: Math.ceil((k.lockedUntil.toMillis() - now) / 60000) };
    }
    if (!sameCode(code, passcode)) {
      const fails = (k.lockedUntil ? 0 : k.fails || 0) + 1; // a finished lockout starts the count again
      if (fails >= MAX_TRIES) {
        tx.set(knockRef, { fails: 0, lockedUntil: Timestamp.fromMillis(now + LOCK_MINUTES * 60000) });
        return { ok: false, lockedMinutes: LOCK_MINUTES };
      }
      tx.set(knockRef, { fails, lockedUntil: null });
      return { ok: false, triesLeft: MAX_TRIES - fails };
    }
    tx.delete(knockRef);
    if (!reqSnap.exists) tx.set(reqRef, { handle, createdAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
}

// ---------- emails ---------------------------------------------------------------------

let mailer = sendMail;
/** Tests swap the mail sender for a fake one. */
export function setMailer(fn) { mailer = fn; }

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function letter(title, lines, button) {
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#1A1916;color:#EFEAE0;font-family:Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#23211D;border:2px solid #4A463F;border-radius:4px;padding:20px">
<div style="font-family:monospace;font-size:12px;letter-spacing:2px;color:#F2A65A">THE GARAGE_TERMINAL BBS</div>
<h1 style="margin:6px 0 12px;font-size:24px;text-transform:uppercase">${esc(title)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${esc(l)}</p>`).join('')}
${button ? `<p style="margin:16px 0 0"><a href="${esc(button.href)}" style="display:inline-block;background:#F07A2A;color:#140F0A;padding:12px 18px;border-radius:4px;font-weight:bold;text-decoration:none">${esc(button.label)}</a></p>` : ''}
</div></body></html>`;
  const text = [title.toUpperCase(), '', ...lines, ...(button ? ['', `${button.label}: ${button.href}`] : [])].join('\n');
  return { html, text };
}

async function emailOf(db, uid) {
  return (await db.doc(`private/${uid}`).get()).get('email') ?? '';
}

/** New request: email every sysop (admins/) right away. */
export async function requestEmail(event, apiKey) {
  const req = event.data?.data();
  if (!req) return;
  const db = getFirestore();
  const admins = await db.collection('admins').get();
  const handle = req.handle || 'someone';
  const mail = letter(`New BBS request: ${handle}`, [`${handle} knocked on the BBS door and is waiting to be let in.`], { label: 'Open the BBS tab', href: `${SITE}/mod#bbs` });
  for (const a of admins.docs) {
    const to = await emailOf(db, a.id);
    if (!to) continue;
    await send({ apiKey, to, subject: `New BBS request: ${handle}`, ...mail });
  }
}

/** New member (approved, added, let in or let back in): "You're in". Not for the sysop. */
export async function welcomeEmail(event, apiKey) {
  const m = event.data?.data();
  if (!m || m.role === 'sysop') return;
  const db = getFirestore();
  const to = await emailOf(db, event.params.uid);
  if (!to) return;
  const mail = letter('You’re in', [
    `Welcome to the Garage_Terminal BBS, ${m.handle}.`,
    'To get in, go to Garage Terminal and tap the >_ at the bottom of any page (next to the copyright). Since you’re signed in, it takes you straight in.',
  ], { label: 'Open Garage Terminal', href: SITE });
  await send({ apiKey, to, subject: 'You’re in: the Garage_Terminal BBS', ...mail });
}

async function send({ apiKey, to, subject, html, text }) {
  if (!apiKey) { logger.warn('RESEND_API_KEY not set; BBS email skipped', { subject }); return; }
  try {
    await mailer({ apiKey, from: FROM, to, replyTo: REPLY_TO, subject, html, text });
  } catch (err) {
    logger.error('BBS email failed', { subject, error: err.message });
  }
}

// ---------- Shop Talk clean-up -----------------------------------------------------------

export const CHAT_DAYS = 7;

/** Delete chat messages older than 7 days (with their photos) and stale "typing" marks. */
export async function cleanupChat(nowMs = Date.now()) {
  const db = getFirestore();
  const cutoff = Timestamp.fromMillis(nowMs - CHAT_DAYS * DAY);
  let deleted = 0;
  for (;;) {
    const old = await db.collection('bbsChat').where('createdAt', '<', cutoff).limit(300).get();
    if (old.empty) break;
    for (const d of old.docs) {
      const path = d.get('photo')?.path;
      if (path) await getStorage().bucket().file(path).delete({ ignoreNotFound: true }).catch((err) => logger.warn('chat photo', { path, error: err.message }));
    }
    const batch = db.batch();
    old.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += old.size;
  }
  const typing = await db.collection('bbsTyping').where('at', '<', Timestamp.fromMillis(nowMs - DAY)).get();
  await Promise.all(typing.docs.map((d) => d.ref.delete()));
  logger.info('Shop Talk clean-up', { deleted });
  return deleted;
}
