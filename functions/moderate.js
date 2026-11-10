// moderate.js: the one Cloud Function every sysop action goes through.
//
// The page calls it like:  moderate({ action: 'thread.lock', threadId, value: true, reason })
// It:
//   1. checks the caller is signed in and listed in admins/ (otherwise refuses),
//   2. checks the input,
//   3. makes the change with full access (Admin SDK),
//   4. writes a modlog/ entry with who, what, when and why.
// The Firestore rules block all of these changes from the page directly, so
// this function is the only way to moderate, and every action is logged.
//
// Actions:
//   thread.pin     { threadId, value }             pin / unpin
//   thread.lock    { threadId, value }             lock / unlock
//   thread.move    { threadId, areaId }            move to another area
//   thread.hide    { threadId, value, reason }     hide / unhide (unhide also approves a held thread)
//   thread.delete  { threadId, reason }            delete thread and all its posts
//   post.hide      { threadId, postId, value, reason, reportId? }   hide / unhide (approves held)
//   post.delete    { threadId, postId, reason, reportId? }          delete a reply
//   report.dismiss { reportId }                    close a report without action
//   member.status  { uid, status, reason, reportId? }  active / muted / banned
//   member.hideAll { uid, reason }                 hide every post and thread by a member
//   member.rename  { uid, handle }                 change a member's handle everywhere
//   settings.update { sysopNotice?, forumOpen?, bannedWords? }

import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

const RESERVED_HANDLES = ['sysop', 'admin', 'moderator', 'garage', 'terminal'];
const HANDLE_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
const WORD_PATTERN = /^[a-z0-9]+(?: [a-z0-9]+)*$/; // letters, numbers, single spaces
const MAX_BANNED_WORDS = 200;
const MAX_NOTICE = 2000;
const MAX_REASON = 300;

// ---------- input checks -------------------------------------------------------

const bad = (message) => new HttpsError('invalid-argument', message);

function str(value, name, { max = 200, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return '';
    throw bad(`${name} is required`);
  }
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  const v = value.trim();
  if (v.length > max) throw bad(`${name} is too long`);
  return v;
}

// Firestore IDs: no slashes, not "." or "..", reasonable length.
function id(value, name) {
  const v = str(value, name, { max: 200 });
  if (v.includes('/') || v === '.' || v === '..') throw bad(`${name} is not valid`);
  return v;
}

function bool(value, name) {
  if (typeof value !== 'boolean') throw bad(`${name} must be true or false`);
  return value;
}

/** Clean a banned-words list: lowercase, trimmed, letters/numbers/spaces only, no duplicates. */
export function cleanBannedWords(list) {
  if (!Array.isArray(list)) throw bad('bannedWords must be a list');
  const words = [...new Set(list.map((w) => String(w).toLowerCase().trim().replace(/\s+/g, ' ')).filter(Boolean))];
  for (const w of words) {
    if (!WORD_PATTERN.test(w) || w.length > 40) {
      throw bad(`"${w}" can only use letters, numbers and spaces (max 40 characters)`);
    }
  }
  if (words.length > MAX_BANNED_WORDS) throw bad(`At most ${MAX_BANNED_WORDS} banned words`);
  return words;
}

// ---------- the function body --------------------------------------------------

export async function moderateHandler(request) {
  const db = getFirestore();
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  if (!(await db.doc(`admins/${uid}`).get()).exists) {
    throw new HttpsError('permission-denied', 'Sysop only');
  }
  const byHandle = (await db.doc(`users/${uid}`).get()).get('handle') ?? '';
  const data = request.data ?? {};
  const action = str(data.action, 'action', { max: 40 });
  const reason = str(data.reason, 'reason', { max: MAX_REASON, optional: true });

  /** Record the action. `targetPath` is the doc it was done to. */
  const log = (targetPath, details = {}) =>
    db.collection('modlog').add({
      action, targetPath, byUid: uid, byHandle, reason, details, createdAt: FieldValue.serverTimestamp(),
    });

  /** Mark a report as handled (if one was passed in). */
  const closeReport = async (status = 'actioned') => {
    if (!data.reportId) return;
    const ref = db.doc(`reports/${id(data.reportId, 'reportId')}`);
    if ((await ref.get()).exists) {
      await ref.update({ status, closedAt: FieldValue.serverTimestamp(), closedBy: uid });
    }
  };

  /** Load a doc or fail with "not found". */
  const mustGet = async (path) => {
    const snap = await db.doc(path).get();
    if (!snap.exists) throw new HttpsError('not-found', 'That item no longer exists');
    return snap;
  };

  switch (action) {
    // ---------- threads ----------
    case 'thread.pin':
    case 'thread.lock': {
      const threadId = id(data.threadId, 'threadId');
      const value = bool(data.value, 'value');
      const field = action === 'thread.pin' ? 'pinned' : 'locked';
      await mustGet(`threads/${threadId}`);
      await db.doc(`threads/${threadId}`).update({ [field]: value });
      await log(`threads/${threadId}`, { [field]: value });
      return { ok: true };
    }

    case 'thread.move': {
      const threadId = id(data.threadId, 'threadId');
      const areaId = id(data.areaId, 'areaId');
      await mustGet(`areas/${areaId}`);
      const thread = await mustGet(`threads/${threadId}`);
      await thread.ref.update({ areaId });
      await log(`threads/${threadId}`, { from: thread.get('areaId'), to: areaId });
      return { ok: true };
    }

    case 'thread.hide': {
      const threadId = id(data.threadId, 'threadId');
      const value = bool(data.value, 'value');
      const thread = await mustGet(`threads/${threadId}`);
      await thread.ref.update(
        value
          ? { hidden: true, hiddenReason: reason }
          : { hidden: false, held: FieldValue.delete(), hiddenReason: FieldValue.delete() },
      );
      await log(`threads/${threadId}`, { hidden: value, wasHeld: !!thread.get('held') });
      await closeReport();
      return { ok: true };
    }

    case 'thread.delete': {
      const threadId = id(data.threadId, 'threadId');
      const thread = await mustGet(`threads/${threadId}`);
      // Deleting posts fires onPostDeleted, which lowers each author's post count.
      await db.recursiveDelete(thread.ref);
      const reports = await db.collection('reports').where('threadId', '==', threadId).where('status', '==', 'open').get();
      await Promise.all(reports.docs.map((r) => r.ref.update({ status: 'actioned', closedAt: FieldValue.serverTimestamp(), closedBy: uid })));
      await log(`threads/${threadId}`, { title: thread.get('title'), author: thread.get('authorHandle') });
      return { ok: true };
    }

    // ---------- posts ----------
    case 'post.hide': {
      const threadId = id(data.threadId, 'threadId');
      const postId = id(data.postId, 'postId');
      const value = bool(data.value, 'value');
      const post = await mustGet(`threads/${threadId}/posts/${postId}`);
      await post.ref.update(
        value
          ? { hidden: true, hiddenReason: reason }
          : { hidden: false, held: FieldValue.delete(), hiddenReason: FieldValue.delete() },
      );
      await log(post.ref.path, { hidden: value, author: post.get('authorHandle'), wasHeld: !!post.get('held') });
      await closeReport();
      return { ok: true };
    }

    case 'post.delete': {
      const threadId = id(data.threadId, 'threadId');
      const postId = id(data.postId, 'postId');
      if (postId === 'op') throw bad('To remove an opening post, delete the whole thread');
      const post = await mustGet(`threads/${threadId}/posts/${postId}`);
      await post.ref.delete();
      await log(post.ref.path, { author: post.get('authorHandle'), excerpt: String(post.get('body')).slice(0, 200) });
      await closeReport();
      return { ok: true };
    }

    // ---------- reports ----------
    case 'report.dismiss': {
      const reportId = id(data.reportId, 'reportId');
      await mustGet(`reports/${reportId}`);
      await closeReport('dismissed');
      await log(`reports/${reportId}`);
      return { ok: true };
    }

    // ---------- members ----------
    case 'member.status': {
      const target = id(data.uid, 'uid');
      const status = str(data.status, 'status', { max: 10 });
      if (!['active', 'muted', 'banned'].includes(status)) throw bad('status must be active, muted or banned');
      if (target === uid) throw bad('You can’t change your own status');
      const user = await mustGet(`users/${target}`);
      await user.ref.update({ status });
      // Ban reason is kept with the email, where only the sysop can read it.
      await db.doc(`private/${target}`).set(
        status === 'banned' ? { bannedReason: reason } : { bannedReason: FieldValue.delete() },
        { merge: true },
      );
      await log(`users/${target}`, { handle: user.get('handle'), from: user.get('status'), to: status });
      await closeReport();
      return { ok: true };
    }

    case 'member.hideAll': {
      const target = id(data.uid, 'uid');
      const user = await mustGet(`users/${target}`);
      const hideReason = reason || `All posts by ${user.get('handle')} hidden`;
      const writer = db.bulkWriter();
      const posts = await db.collectionGroup('posts').where('authorUid', '==', target).get();
      posts.docs.filter((p) => !p.get('hidden')).forEach((p) => writer.update(p.ref, { hidden: true, hiddenReason: hideReason }));
      const threads = await db.collection('threads').where('authorUid', '==', target).get();
      threads.docs.filter((t) => !t.get('hidden')).forEach((t) => writer.update(t.ref, { hidden: true, hiddenReason: hideReason }));
      await writer.close();
      await log(`users/${target}`, { handle: user.get('handle'), posts: posts.size, threads: threads.size });
      return { ok: true, posts: posts.size, threads: threads.size };
    }

    case 'member.rename': {
      const target = id(data.uid, 'uid');
      const handle = str(data.handle, 'handle', { max: 20 });
      if (!HANDLE_PATTERN.test(handle)) throw bad('Handles are 3–20 letters, numbers or underscores');
      if (RESERVED_HANDLES.includes(handle.toLowerCase())) throw bad('That handle is reserved');

      let oldHandle;
      await db.runTransaction(async (tx) => {
        const userRef = db.doc(`users/${target}`);
        const user = await tx.get(userRef);
        if (!user.exists) throw new HttpsError('not-found', 'No such member');
        oldHandle = user.get('handle');
        const newRef = db.doc(`handles/${handle.toLowerCase()}`);
        const existing = await tx.get(newRef);
        if (existing.exists && existing.get('uid') !== target) throw new HttpsError('already-exists', 'That handle is taken');
        if (oldHandle.toLowerCase() !== handle.toLowerCase()) tx.delete(db.doc(`handles/${oldHandle.toLowerCase()}`));
        tx.set(newRef, { uid: target });
        tx.update(userRef, { handle });
      });

      // Update the handle shown on their existing threads and posts.
      const writer = db.bulkWriter();
      (await db.collectionGroup('posts').where('authorUid', '==', target).get()).docs
        .forEach((p) => writer.update(p.ref, { authorHandle: handle }));
      (await db.collection('threads').where('authorUid', '==', target).get()).docs
        .forEach((t) => writer.update(t.ref, { authorHandle: handle }));
      await writer.close();
      await log(`users/${target}`, { from: oldHandle, to: handle });
      return { ok: true };
    }

    // ---------- site settings ----------
    case 'settings.update': {
      const changes = {};
      if ('sysopNotice' in data) changes.sysopNotice = str(data.sysopNotice, 'sysopNotice', { max: MAX_NOTICE, optional: true });
      if ('forumOpen' in data) changes.forumOpen = bool(data.forumOpen, 'forumOpen');
      if ('bannedWords' in data) changes.bannedWords = cleanBannedWords(data.bannedWords);
      if (!Object.keys(changes).length) throw bad('Nothing to change');
      await db.doc('settings/site').set(changes, { merge: true });
      // Log what changed (not the full notice text, just its length).
      const details = { ...changes };
      if ('sysopNotice' in details) details.sysopNotice = `${details.sysopNotice.length} characters`;
      if ('bannedWords' in details) details.bannedWords = `${details.bannedWords.length} words`;
      await log('settings/site', details);
      return { ok: true, ...('bannedWords' in changes ? { bannedWords: changes.bannedWords } : {}) };
    }

    default:
      throw bad(`Unknown action: ${action}`);
  }
}

