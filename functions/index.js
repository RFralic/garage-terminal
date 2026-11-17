// Cloud Functions for Garage Terminal.
//
//   onPostCreated / onPostDeleted: keep the forum counters up to date (below)
//   moderate: every sysop moderation action, always logged (see moderate.js)
//   bbs, bbsKnock, bbsRequestEmail, bbsWelcomeEmail: the BBS (see bbs.js)
//   bbsPostCreated, bbsPostDeleted, bbsThreadDeleted, bbsFileDeleted: BBS boards and files (bbs-content.js)
//
// These run on Google's servers (not in the browser) with full access, so they
// can update numbers that members are never allowed to touch directly:
//   - thread.replyCount and thread.lastReplyAt
//   - user.postCount
//
// They react to posts being created or deleted under threads/{threadId}/posts.
// The opening post of a thread has the id "op" and isn't counted as a reply.
//
// Note: Google may (rarely) run a trigger twice for the same event, so a count
// can drift by one. That's acceptable for a forum; the sysop can't see a
// difference that matters, and nothing security-related depends on the counts.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onCall } from 'firebase-functions/v2/https';
import { setGlobalOptions, logger } from 'firebase-functions/v2';
import { moderateHandler } from './moderate.js';
import { bbsHandler, knockHandler, requestEmail, welcomeEmail } from './bbs.js';
import { postCreated, postDeleted, threadDeleted, fileDeleted } from './bbs-content.js';

initializeApp();
const db = getFirestore();

// Same region as the Firestore database; keep instances tiny and capped.
setGlobalOptions({ region: 'us-east1', memory: '256MiB', maxInstances: 5 });

const POST_PATH = 'threads/{threadId}/posts/{postId}';

/** Update a doc, ignoring "not found" (e.g. the thread or user was deleted). */
async function updateIfExists(ref, data) {
  try {
    await ref.update(data);
  } catch (err) {
    if (err.code === 5 /* NOT_FOUND */) return;
    throw err;
  }
}

export const onPostCreated = onDocumentCreated(POST_PATH, async (event) => {
  const post = event.data?.data();
  if (!post) return;
  const { threadId, postId } = event.params;

  await updateIfExists(db.doc(`users/${post.authorUid}`), { postCount: FieldValue.increment(1) });

  if (postId !== 'op') {
    await updateIfExists(db.doc(`threads/${threadId}`), {
      replyCount: FieldValue.increment(1),
      lastReplyAt: post.createdAt ?? FieldValue.serverTimestamp(),
    });
  }
  logger.info('post created', { threadId, postId });
});

export const onPostDeleted = onDocumentDeleted(POST_PATH, async (event) => {
  const post = event.data?.data();
  if (!post) return;
  const { threadId, postId } = event.params;

  await updateIfExists(db.doc(`users/${post.authorUid}`), { postCount: FieldValue.increment(-1) });

  if (postId !== 'op') {
    // lastReplyAt is left alone: it means "last activity", which still happened.
    await updateIfExists(db.doc(`threads/${threadId}`), { replyCount: FieldValue.increment(-1) });
  }
  logger.info('post deleted', { threadId, postId });
});

// ---------- moderation ---------------------------------------------------------
// Called from the page by the sysop. Checks the caller is sysop itself, so it's
// safe for it to be reachable from the internet (that's how pages call it).
export const moderate = onCall({ maxInstances: 3 }, moderateHandler);

// ---------- the BBS ------------------------------------------------------------------
// Secrets live in Google Cloud Secret Manager (see README.md, "BBS"), never in the repo:
//   RESEND_API_KEY  sends the BBS emails (same Resend account as the Morning Brief)
//   BBS_PASSCODE    the 6-digit passcode, used only when the sysop switches it on
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const BBS_PASSCODE = defineSecret('BBS_PASSCODE');

export const bbs = onCall({ maxInstances: 3 }, bbsHandler);
export const bbsKnock = onCall({ maxInstances: 3, secrets: [BBS_PASSCODE] }, (request) => knockHandler(request, BBS_PASSCODE.value()));
export const bbsRequestEmail = onDocumentCreated({ document: 'bbsRequests/{uid}', secrets: [RESEND_API_KEY] },
  (event) => requestEmail(event, RESEND_API_KEY.value()));
export const bbsWelcomeEmail = onDocumentCreated({ document: 'bbsMembers/{uid}', secrets: [RESEND_API_KEY] },
  (event) => welcomeEmail(event, RESEND_API_KEY.value()));

export const bbsPostCreated = onDocumentCreated('bbsThreads/{threadId}/posts/{postId}', postCreated);
export const bbsPostDeleted = onDocumentDeleted('bbsThreads/{threadId}/posts/{postId}', postDeleted);
export const bbsThreadDeleted = onDocumentDeleted('bbsThreads/{threadId}', threadDeleted);
export const bbsFileDeleted = onDocumentDeleted('bbsFiles/{fileId}', fileDeleted);
