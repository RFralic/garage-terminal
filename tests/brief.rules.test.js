// Morning Brief rules tests: settings are private, and the brief can only go
// to the member's own verified address.
// Run with:  npm test

import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { startEnv, seed as seedRaw } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(() => env.cleanup());

const as = (uid, token = { email: `${uid}@example.com`, email_verified: true }) =>
  env.authenticatedContext(uid, token).firestore();
const guest = () => env.unauthenticatedContext().firestore();
const settings = (uid, extra = {}) => ({
  enabled: true,
  email: `${uid}@example.com`,
  hour: 6,
  tz: 'America/New_York',
  icsUrl: '',
  sections: { today: true, upcoming: true, lowStock: true, maintenance: true, projects: false },
  sendNow: false,
  updatedAt: serverTimestamp(),
  ...extra,
});

beforeEach(async () => {
  await env.clearFirestore();
  await seedRaw(env, async (db) => {
    await setDoc(doc(db, 'briefs', 'bob'), { ...settings('bob'), updatedAt: new Date() });
    await setDoc(doc(db, 'briefStatus', 'bob'), { lastResult: 'sent', lastSentDate: '2026-11-14' });
    await setDoc(doc(db, 'admins', 'boss'), { addedAt: new Date() });
  });
});

describe('Morning Brief settings', () => {
  test('a member can save, read and delete their own settings', async () => {
    const db = as('bob');
    await assertSucceeds(setDoc(doc(db, 'briefs', 'bob'), settings('bob', { icsUrl: 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics', sendNow: true })));
    await assertSucceeds(getDoc(doc(db, 'briefs', 'bob')));
    await assertSucceeds(getDoc(doc(db, 'briefStatus', 'bob')));
    await assertSucceeds(deleteDoc(doc(db, 'briefs', 'bob')));
  });

  test('nobody else can read or change them, not even the sysop', async () => {
    for (const db of [guest(), as('mallory'), as('boss')]) {
      await assertFails(getDoc(doc(db, 'briefs', 'bob')));
      await assertFails(getDoc(doc(db, 'briefStatus', 'bob')));
      await assertFails(setDoc(doc(db, 'briefs', 'bob'), settings('bob')));
    }
  });

  test('the brief only goes to your own verified address', async () => {
    await assertFails(setDoc(doc(as('bob'), 'briefs', 'bob'), settings('bob', { email: 'victim@example.com' })));
    await assertFails(setDoc(doc(as('carl', { email: 'carl@example.com', email_verified: false }), 'briefs', 'carl'), settings('carl')));
  });

  test('settings must be well-formed', async () => {
    const db = as('bob');
    await assertFails(setDoc(doc(db, 'briefs', 'bob'), settings('bob', { hour: 24 })));
    await assertFails(setDoc(doc(db, 'briefs', 'bob'), settings('bob', { hour: '6' })));
    await assertFails(setDoc(doc(db, 'briefs', 'bob'), settings('bob', { icsUrl: 'http://example.com/cal.ics' })));
    await assertFails(setDoc(doc(db, 'briefs', 'bob'), settings('bob', { sections: { today: 'yes' } })));
    await assertFails(setDoc(doc(db, 'briefs', 'bob'), settings('bob', { sections: { weather: true } })));
    await assertFails(setDoc(doc(db, 'briefs', 'bob'), settings('bob', { lastSentDate: '2026-11-14' })));
    await assertFails(setDoc(doc(db, 'briefs', 'bob'), settings('bob', { updatedAt: new Date(0) })));
  });

  test('members cannot write the send status', async () => {
    await assertFails(setDoc(doc(as('bob'), 'briefStatus', 'bob'), { lastResult: 'sent' }));
  });
});
