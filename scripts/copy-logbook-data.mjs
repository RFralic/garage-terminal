// copy-logbook-data.mjs: one-time copy of every Logbook and Project Tracker
// record from the old Logbook project (vehicle-logbook-c7e27) to this site.
//
//   old: users/{oldUid}/records|projects|trackerSettings/{id}
//   new: logbook/{newUid}/records|projects|trackerSettings/{id}
//
// Each old account is matched to its Garage Terminal account by the Google
// account behind it (the same Google sign-in in both places). Someone who has
// never signed in to Garage Terminal is skipped and listed as "not matched";
// they can be copied later by running this again after they sign in once.
//
// Safe to run more than once: a record that's already here and newer here
// (updatedAt) is left alone; everything else is copied over. Nothing in the old
// project is changed or deleted.
//
// Run from GitHub: Actions -> "Copy Logbook data" -> Run workflow. The first
// run is a dry run that only counts; untick "Dry run" to copy.
// Needs two service account keys (GitHub secrets):
//   FIREBASE_SERVICE_ACCOUNT  this site's deploy key (already set)
//   LOGBOOK_SERVICE_ACCOUNT   the old Logbook project's key (Firebase console ->
//                             vehicle-logbook-c7e27 -> Project settings ->
//                             Service accounts -> Generate new private key)
// Logs show counts only, never emails or names (workflow logs are public).

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const dryRun = process.argv.includes('--dry-run');
const oldKey = JSON.parse(readFileSync(process.env.OLD_CREDENTIALS, 'utf8'));
const newKey = JSON.parse(readFileSync(process.env.NEW_CREDENTIALS, 'utf8'));
if (oldKey.project_id !== 'vehicle-logbook-c7e27') throw new Error('LOGBOOK_SERVICE_ACCOUNT is not a key for vehicle-logbook-c7e27.');
if (newKey.project_id !== 'garage-terminal-15499') throw new Error('FIREBASE_SERVICE_ACCOUNT is not a key for garage-terminal-15499.');

const oldApp = initializeApp({ credential: cert(oldKey), projectId: oldKey.project_id }, 'old');
const newApp = initializeApp({ credential: cert(newKey), projectId: newKey.project_id }, 'new');
const oldAuth = getAuth(oldApp);
const newAuth = getAuth(newApp);
const oldDb = getFirestore(oldApp);
const newDb = getFirestore(newApp);

const PARTS = ['records', 'projects', 'trackerSettings'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Every account in the old project. */
async function allOldUsers() {
  const users = [];
  let token;
  do {
    const page = await oldAuth.listUsers(1000, token);
    users.push(...page.users);
    token = page.pageToken;
  } while (token);
  return users;
}

/** The Garage Terminal account for the same Google account, or null. */
async function matchingUser(oldUser) {
  const google = oldUser.providerData.find((p) => p.providerId === 'google.com');
  if (google) {
    try { return await newAuth.getUserByProviderUid('google.com', google.uid); } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
    }
  }
  if (oldUser.email && oldUser.emailVerified) {
    try {
      const u = await newAuth.getUserByEmail(oldUser.email);
      if (u.emailVerified) return u;
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
    }
  }
  return null;
}

const newer = (a, b) => String(a?.updatedAt ?? '') > String(b?.updatedAt ?? '');

let matched = 0;
let unmatched = 0;
const totals = { copied: 0, keptNewer: 0, badId: 0 };

for (const oldUser of await allOldUsers()) {
  const newUser = await matchingUser(oldUser);
  if (!newUser) { unmatched++; continue; }
  matched++;
  const counts = {};
  for (const part of PARTS) {
    const snap = await oldDb.collection(`users/${oldUser.uid}/${part}`).get();
    let n = 0;
    let writer = newDb.batch();
    let inBatch = 0;
    for (const d of snap.docs) {
      if (!ID.test(d.id)) { totals.badId++; continue; }
      const target = newDb.doc(`logbook/${newUser.uid}/${part}/${d.id}`);
      const here = await target.get();
      if (here.exists && newer(here.data(), d.data())) { totals.keptNewer++; continue; }
      n++;
      if (dryRun) continue;
      writer.set(target, d.data());
      if (++inBatch === 400) { await writer.commit(); writer = newDb.batch(); inBatch = 0; }
    }
    if (!dryRun && inBatch) await writer.commit();
    counts[part] = n;
    totals.copied += n;
  }
  console.log(`Account ${matched}: ${dryRun ? 'would copy' : 'copied'} ${counts.records} records, ${counts.projects} projects, ${counts.trackerSettings} tracker settings.`);
}

console.log(`\n${dryRun ? 'DRY RUN, nothing written. ' : ''}Accounts matched: ${matched}. Not matched (never signed in to Garage Terminal): ${unmatched}.`);
console.log(`Documents ${dryRun ? 'to copy' : 'copied'}: ${totals.copied}. Left alone (newer here already): ${totals.keptNewer}. Skipped (unusual ID): ${totals.badId}.`);
