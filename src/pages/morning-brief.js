// morning-brief.js: the /apps/morning-brief page. A signed-in member turns the
// daily email on, picks the time, time zone and sections, optionally adds
// their calendar's secret iCal address, and sees a preview built from their
// Logbook and Project Tracker data with the same code the sender uses.
//
// Settings: briefs/{uid}. Last send: briefStatus/{uid} (written by
// scripts/send-briefs.mjs). Rules: MORNING BRIEF section of firestore.rules.

import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase.js';
import { mountHeader } from '../lib/header.js';
import { watchSession } from '../lib/session.js';
import { DEFAULT_SECTIONS, SECTIONS, buildBrief, renderBrief } from '../brief/brief.js';
import { normalizeCalendarUrl } from '../brief/ics.js';
import { isValidTimeZone } from '../brief/time.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const show = (which) => {
  $('mb-loading').hidden = which !== 'loading';
  $('mb-guest').hidden = which !== 'guest';
  $('mb-form').hidden = which !== 'form';
  $('mb-preview-block').hidden = which !== 'form';
};
const setStatus = (text, kind = 'wait') => { const s = $('mb-status'); s.textContent = text; s.dataset.kind = kind; };

// ---------- form controls -------------------------------------------------------

const hourLabel = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;
for (let h = 0; h < 24; h++) $('mb-hour').append(new Option(hourLabel(h), String(h)));

const here = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
const zones = (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [])
  .concat([here, 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']);
for (const z of [...new Set(zones)].sort()) $('mb-tz').append(new Option(z.replace(/_/g, ' '), z));

for (const [key, label] of Object.entries(SECTIONS)) {
  const l = document.createElement('label');
  l.className = 'check';
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.dataset.section = key;
  l.append(i, ` ${label}`);
  $('mb-sections').append(l);
}
const sectionBoxes = () => [...document.querySelectorAll('[data-section]')];

function fill(b) {
  $('mb-enabled').checked = !!b.enabled;
  $('mb-hour').value = String(Number.isInteger(b.hour) ? b.hour : 6);
  $('mb-tz').value = isValidTimeZone(b.tz) ? b.tz : here;
  $('mb-ics').value = b.icsUrl || '';
  const on = { ...DEFAULT_SECTIONS, ...(b.sections || {}) };
  for (const box of sectionBoxes()) box.checked = !!on[box.dataset.section];
}

function read() {
  return {
    enabled: $('mb-enabled').checked,
    hour: parseInt($('mb-hour').value, 10),
    tz: $('mb-tz').value,
    icsUrl: normalizeCalendarUrl($('mb-ics').value),
    sections: Object.fromEntries(sectionBoxes().map((b) => [b.dataset.section, b.checked])),
  };
}

// ---------- preview --------------------------------------------------------------------

let data = { records: [], projects: [] };
function drawPreview() {
  const s = read();
  const brief = buildBrief({ ...data, events: null, tz: s.tz, sections: s.sections, calendar: s.icsUrl ? 'ok' : 'none' });
  $('mb-preview').srcdoc = renderBrief(brief, { siteUrl: location.origin }).html;
}
$('mb-form').addEventListener('change', drawPreview);

// ---------- loading and saving -----------------------------------------------------------

let me = null;

async function load(user) {
  me = user;
  $('mb-email').textContent = user.email || '(no email on this account)';
  const [settings, status, records, projects] = await Promise.all([
    getDoc(doc(db, 'briefs', user.uid)),
    getDoc(doc(db, 'briefStatus', user.uid)),
    getDocs(collection(db, 'logbook', user.uid, 'records')),
    getDocs(collection(db, 'logbook', user.uid, 'projects')),
  ]);
  fill(settings.exists() ? settings.data() : { enabled: false, hour: 6, tz: here, sections: DEFAULT_SECTIONS });
  data = {
    records: records.docs.map((d) => ({ id: d.id, ...d.data() })),
    projects: projects.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
  showLast(status.exists() ? status.data() : null);
  show('form');
  drawPreview();
}

function showLast(st) {
  if (!st) { $('mb-last').textContent = 'No brief sent yet.'; return; }
  const when = st.lastSentAt && st.lastSentAt.toDate ? st.lastSentAt.toDate().toLocaleString() : '';
  $('mb-last').textContent = String(st.lastResult || '').startsWith('error')
    ? `Last try didn't send: ${st.lastResult.replace(/^error:\s*/, '')}`
    : `Last ${st.lastResult === 'test sent' ? 'test ' : ''}brief sent ${when}.${st.lastCalendar === 'error' ? " Your calendar couldn't be read that time; check the address." : ''}`;
}

async function save(sendNow) {
  if (!me) return;
  const s = read();
  if ($('mb-ics').value.trim() && !s.icsUrl) {
    setStatus("That calendar address doesn't look right. It should start with https:// or webcal://.", 'bad');
    return;
  }
  if (!me.email || !me.emailVerified) {
    setStatus('This account has no verified email address to send to.', 'bad');
    return;
  }
  setStatus('Saving…');
  try {
    await setDoc(doc(db, 'briefs', me.uid), { ...s, email: me.email, sendNow: !!sendNow, updatedAt: serverTimestamp() });
    setStatus(sendNow
      ? 'Saved. Your test brief will arrive within about 30 minutes.'
      : s.enabled ? `Saved. Your brief will arrive each day shortly after ${hourLabel(s.hour)}.` : 'Saved. The daily email is off.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus("Couldn't save. Check your connection and try again.", 'bad');
  }
}

$('mb-form').addEventListener('submit', (e) => { e.preventDefault(); save(false); });
$('mb-test').addEventListener('click', () => save(true));

let loadedFor = null;
watchSession((s) => {
  if (s.state === 'loading') { show('loading'); return; }
  if (s.state === 'guest') { loadedFor = null; me = null; show('guest'); return; }
  if (loadedFor === s.user.uid) return;
  loadedFor = s.user.uid;
  load(s.user).catch((err) => {
    console.error(err);
    const e = $('mb-error');
    e.textContent = "Couldn't load your settings. Reload the page to try again.";
    e.hidden = false;
    show('none');
  });
});
