// seed.mjs: creates the starting forum data if it's missing. Runs on every
// deploy to main; it only ever ADDS missing docs and never overwrites edits.
//
//   areas/{id}     [1] General ... [5] Off-Topic
//   settings/site  sysop notice (empty), forum open, no banned words

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Against the local emulators (npm run seed:local) use the demo project;
// otherwise the live project with the deploy service account.
initializeApp(
  process.env.FIRESTORE_EMULATOR_HOST
    ? { projectId: 'demo-garage-terminal' }
    : { credential: applicationDefault(), projectId: 'garage-terminal-15499' },
);
const db = getFirestore();

const AREAS = [
  { id: 'general', key: '[1]', name: 'General', order: 1 },
  { id: 'app-support', key: '[2]', name: 'App Support', order: 2 },
  { id: 'releases', key: '[3]', name: 'Releases', order: 3 },
  { id: 'wiki-requests', key: '[4]', name: 'Wiki Requests', order: 4 },
  { id: 'off-topic', key: '[5]', name: 'Off-Topic', order: 5 },
];

/** Create the doc only if it doesn't exist yet. */
async function createIfMissing(path, data) {
  try {
    await db.doc(path).create(data);
    console.log(`created ${path}`);
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) return console.log(`exists  ${path}`);
    throw err;
  }
}

for (const { id, ...area } of AREAS) await createIfMissing(`areas/${id}`, area);
await createIfMissing('settings/site', { sysopNotice: '', forumOpen: true, bannedWords: [] });
