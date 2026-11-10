// recount.mjs: rebuilds the forum counters from the actual posts.
//
// Normally Cloud Functions keep these up to date. Run this if they ever drift
// (or for posts made before the functions were deployed):
//   GitHub -> Actions -> "Recount forum" -> Run workflow
//
// Sets, from scratch:
//   threads/{id}.replyCount   number of posts other than the opening post
//   threads/{id}.lastReplyAt  newest post time (or the thread's own time)
//   users/{uid}.postCount     number of posts by that member
// Counts every post, hidden or not, the same way the functions do.

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp(
  process.env.FIRESTORE_EMULATOR_HOST
    ? { projectId: 'demo-garage-terminal' }
    : { credential: applicationDefault(), projectId: 'garage-terminal-15499' },
);
const db = getFirestore();

const postsByUser = new Map();
const writer = db.bulkWriter();

const threads = await db.collection('threads').get();
for (const thread of threads.docs) {
  const posts = await thread.ref.collection('posts').get();
  let replies = 0;
  let last = thread.get('createdAt');
  for (const post of posts.docs) {
    const uid = post.get('authorUid');
    postsByUser.set(uid, (postsByUser.get(uid) ?? 0) + 1);
    if (post.id === 'op') continue;
    replies += 1;
    const at = post.get('createdAt');
    if (at && (!last || at.toMillis() > last.toMillis())) last = at;
  }
  writer.update(thread.ref, { replyCount: replies, ...(last ? { lastReplyAt: last } : {}) });
}

const users = await db.collection('users').get();
for (const user of users.docs) {
  writer.update(user.ref, { postCount: postsByUser.get(user.id) ?? 0 });
}

await writer.close();
console.log(`Recounted ${threads.size} threads and ${users.size} members.`);
