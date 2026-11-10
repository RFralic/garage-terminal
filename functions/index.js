// Cloud Functions for Garage Terminal.
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
import { setGlobalOptions, logger } from 'firebase-functions/v2';

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
