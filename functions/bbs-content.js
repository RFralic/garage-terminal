// bbs-content.js: keeps BBS boards tidy (see firestore.rules, BBS part 2).
//
//   postCreated   a reply bumps its thread's replyCount, lastAt and lastBy
//   postDeleted   lowers replyCount; deletes the post's photo from Storage
//   threadDeleted deletes the thread's posts (and so their photos)
//   fileDeleted   deletes a file cabinet upload when its entry is deleted
//
// Members can't change these numbers or other people's uploads themselves; these
// run with full access. Google may (rarely) run a trigger twice, so a count can
// drift by one; nothing security-related depends on it.

import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';

async function deleteUpload(path) {
  if (!path || typeof path !== 'string' || !path.startsWith('bbs/')) return;
  try {
    await getStorage().bucket().file(path).delete({ ignoreNotFound: true });
  } catch (err) {
    logger.warn('BBS: could not delete upload', { path, error: err.message });
  }
}

async function updateIfExists(ref, data) {
  try { await ref.update(data); } catch (err) { if (err.code !== 5 /* NOT_FOUND */) throw err; }
}

export async function postCreated(event) {
  const post = event.data?.data();
  if (!post || event.params.postId === 'op') return;
  await updateIfExists(getFirestore().doc(`bbsThreads/${event.params.threadId}`), {
    replyCount: FieldValue.increment(1),
    lastAt: post.createdAt ?? FieldValue.serverTimestamp(),
    lastBy: post.authorHandle ?? '',
  });
}

export async function postDeleted(event) {
  const post = event.data?.data();
  if (!post) return;
  await deleteUpload(post.photo?.path);
  if (event.params.postId !== 'op') {
    await updateIfExists(getFirestore().doc(`bbsThreads/${event.params.threadId}`), { replyCount: FieldValue.increment(-1) });
  }
}

export async function threadDeleted(event) {
  const db = getFirestore();
  const posts = await db.collection(`bbsThreads/${event.params.threadId}/posts`).get();
  // Each delete fires postDeleted, which removes the photo.
  await Promise.all(posts.docs.map((p) => p.ref.delete()));
}

export async function fileDeleted(event) {
  await deleteUpload(event.data?.data()?.path);
}
