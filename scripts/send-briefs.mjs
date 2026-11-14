// send-briefs.mjs: emails each member's Morning Brief when it's due.
//
// Run every 30 minutes by .github/workflows/morning-brief.yml. For each member
// who turned the brief on (briefs/{uid}, set on /apps/morning-brief):
//   - due when it's past their chosen hour in their time zone, it hasn't gone
//     out today, and it's no more than 4 hours late (so turning it on in the
//     evening doesn't send one right away); "Send a test now" sends at once
//   - reads their own Logbook records and Project Tracker projects, and their
//     calendar's secret iCal address if they gave one
//   - builds the email with src/brief/brief.js (same as the page's preview)
//     and sends it from the site's Gmail account (scripts/lib/smtp.mjs)
//   - records what happened in briefStatus/{uid} (readable by the member)
//
// The brief only ever goes to the member's own verified Google address.
// Logs show counts only, never addresses or content (workflow logs are public).
//
// Needs: GOOGLE_APPLICATION_CREDENTIALS (deploy service account),
// GMAIL_ADDRESS and GMAIL_APP_PASSWORD (GitHub secrets).

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { buildBrief, renderBrief } from '../src/brief/brief.js';
import { eventsInWindow, normalizeCalendarUrl } from '../src/brief/ics.js';
import { dateKey, isValidTimeZone, zonedParts, zonedToMs } from '../src/brief/time.js';
import { sendMail } from './lib/smtp.mjs';

const SITE = 'https://garage-terminal-15499.web.app';
const LATE_HOURS = 4;
const user = process.env.GMAIL_ADDRESS;
const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
if (!user || !pass) {
  console.error('Add the GMAIL_ADDRESS and GMAIL_APP_PASSWORD secrets first (see README, Morning Brief).');
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: 'garage-terminal-15499' });
const db = getFirestore();
const auth = getAuth();

async function fetchCalendar(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { 'User-Agent': 'GarageTerminal-MorningBrief' } });
  if (!res.ok) throw new Error(`calendar ${res.status}`);
  const text = await res.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('calendar too large');
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not a calendar');
  return text;
}

const docs = new Map();
for (const q of [db.collection('briefs').where('enabled', '==', true), db.collection('briefs').where('sendNow', '==', true)]) {
  for (const d of (await q.get()).docs) docs.set(d.id, d);
}

const nowMs = Date.now();
const tally = { checked: 0, sent: 0, notDue: 0, failed: 0 };

for (const [uid, snap] of docs) {
  tally.checked++;
  const b = snap.data();
  const tz = isValidTimeZone(b.tz) ? b.tz : 'America/New_York';
  const today = dateKey(nowMs, tz);
  const statusRef = db.doc(`briefStatus/${uid}`);
  const status = (await statusRef.get()).data() || {};
  const hour = Number.isInteger(b.hour) ? b.hour : 6;
  const local = zonedParts(nowMs, tz);
  const dueAt = zonedToMs(local.y, local.m, local.d, hour, 0, 0, tz);
  const due = b.enabled === true && status.lastSentDate !== today && nowMs >= dueAt && nowMs < dueAt + LATE_HOURS * 3600000;
  const test = b.sendNow === true;
  if (!due && !test) { tally.notDue++; continue; }

  try {
    // Only ever to the account's own verified address.
    const account = await auth.getUser(uid);
    if (!account.email || !account.emailVerified || account.email.toLowerCase() !== String(b.email || '').toLowerCase()) {
      throw new Error('address does not match the account');
    }

    const [records, projects] = await Promise.all(['records', 'projects'].map(async (name) =>
      (await db.collection(`logbook/${uid}/${name}`).get()).docs.map((d) => ({ id: d.id, ...d.data() }))));

    let events = null;
    let calendar = 'none';
    const icsUrl = normalizeCalendarUrl(b.icsUrl);
    if (icsUrl) {
      try {
        const startOfDay = zonedToMs(local.y, local.m, local.d, 0, 0, 0, tz);
        events = eventsInWindow(await fetchCalendar(icsUrl), { fromMs: startOfDay, toMs: startOfDay + 15 * 86400000, tz });
        calendar = 'ok';
      } catch (err) {
        calendar = 'error';
        console.log(`Member ${tally.checked}: calendar not read (${String(err.message).slice(0, 60)})`);
      }
    }

    const brief = buildBrief({ records, projects, events, nowMs, tz, sections: b.sections, calendar });
    const mail = renderBrief(brief, { siteUrl: SITE });
    await sendMail({
      user, pass, to: account.email,
      subject: test ? `[Test] ${mail.subject}` : mail.subject,
      html: mail.html, text: mail.text,
      fromName: 'Garage Terminal Morning Brief',
      headers: { 'List-Unsubscribe': `<${SITE}/apps/morning-brief>` },
    });

    await statusRef.set({
      ...(test && !due ? {} : { lastSentDate: today }),
      lastSentAt: FieldValue.serverTimestamp(),
      lastResult: test ? 'test sent' : 'sent',
      lastCalendar: calendar,
    }, { merge: true });
    tally.sent++;
  } catch (err) {
    tally.failed++;
    console.log(`Member ${tally.checked}: not sent (${String(err.message).slice(0, 80)})`);
    await statusRef.set({ lastResult: `error: ${String(err.message).slice(0, 200)}`, lastErrorAt: FieldValue.serverTimestamp() }, { merge: true });
  } finally {
    if (test) await snap.ref.update({ sendNow: false });
  }
}

console.log(`Checked ${tally.checked} · sent ${tally.sent} · not due yet ${tally.notDue} · failed ${tally.failed}`);
if (tally.failed && !tally.sent) process.exitCode = 1;
