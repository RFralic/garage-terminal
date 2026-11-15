// morning-brief.js: the /apps/morning-brief page. A signed-in member turns the
// daily or weekly email on, picks the day, time, time zone and sections, optionally adds
// their calendar's secret iCal address, and sees a preview built from their
// Logbook, Project Tracker and Home Projects upkeep data with the same code the
// sender uses.
//
// Settings: briefs/{uid}. Last send: briefStatus/{uid} (written by
// scripts/send-briefs.mjs). Rules: MORNING BRIEF section of firestore.rules.

import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { db } from '../lib/firebase.js';
import { mountHeader } from '../lib/header.js';
import { watchSession } from '../lib/session.js';
import { DEFAULT_SECTIONS, SECTIONS, WEEKDAYS, buildAlert, buildBrief, renderBrief, upkeepStatus } from '../brief/brief.js';
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
WEEKDAYS.forEach((d, i) => $('mb-weekday').append(new Option(d, String(i))));
const showDay = () => { $('mb-weekday-wrap').hidden = $('mb-frequency').value !== 'weekly'; };
$('mb-frequency').addEventListener('change', showDay);
const showMode = () => {
  const alerts = $('mb-mode').value === 'maintenance';
  for (const id of ['mb-often', 'mb-sections-box', 'mb-calendar-box']) $(id).hidden = alerts;
  $('mb-mode-note').hidden = !alerts;
};
$('mb-mode').addEventListener('change', showMode);

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
  l.append(i, ` ${key === 'maintenance' ? 'Maintenance: Logbook services and Home Projects upkeep' : label}`);
  $('mb-sections').append(l);
}
const sectionBoxes = () => [...document.querySelectorAll('[data-section]')];

function fill(b) {
  $('mb-enabled').checked = !!b.enabled;
  $('mb-hour').value = String(Number.isInteger(b.hour) ? b.hour : 6);
  $('mb-frequency').value = b.frequency === 'weekly' ? 'weekly' : 'daily';
  $('mb-weekday').value = String(Number.isInteger(b.weekday) ? b.weekday : 0);
  showDay();
  $('mb-mode').value = b.mode === 'maintenance' ? 'maintenance' : 'brief';
  showMode();
  $('mb-tz').value = isValidTimeZone(b.tz) ? b.tz : here;
  $('mb-ics').value = b.icsUrl || '';
  const on = { ...DEFAULT_SECTIONS, ...(b.sections || {}) };
  for (const box of sectionBoxes()) box.checked = !!on[box.dataset.section];
}

function read() {
  return {
    enabled: $('mb-enabled').checked,
    mode: $('mb-mode').value === 'maintenance' ? 'maintenance' : 'brief',
    hour: parseInt($('mb-hour').value, 10),
    frequency: $('mb-frequency').value === 'weekly' ? 'weekly' : 'daily',
    weekday: parseInt($('mb-weekday').value, 10),
    tz: $('mb-tz').value,
    icsUrl: normalizeCalendarUrl($('mb-ics').value),
    sections: Object.fromEntries(sectionBoxes().map((b) => [b.dataset.section, b.checked])),
  };
}

// ---------- preview --------------------------------------------------------------------

let data = { records: [], projects: [], upkeep: [] };
function drawPreview() {
  const s = read();
  const brief = s.mode === 'maintenance'
    ? buildAlert({ records: data.records, upkeep: data.upkeep, tz: s.tz })
    : buildBrief({ ...data, events: null, tz: s.tz, sections: s.sections, calendar: s.icsUrl ? 'ok' : 'none', frequency: s.frequency });
  $('mb-preview').srcdoc = renderBrief(brief, { siteUrl: location.origin }).html;
  upkeepNote(brief.today);
}

/** Says what the preview found in Home Projects, so a quiet Maintenance section makes sense. */
function upkeepNote(today) {
  const list = data.upkeep || [];
  const el = $('mb-upkeep-note');
  if (data.upkeepError) { el.textContent = "Home Projects upkeep reminders couldn't be read just now. Reload to try again."; return; }
  if (!list.length) {
    el.replaceChildren('No upkeep reminders on this account yet. Add them on the Upkeep tab in ');
    const a = document.createElement('a'); a.href = '/apps/home-projects'; a.textContent = 'Home Projects';
    el.append(a, ' while signed in here.');
    return;
  }
  const st = list.map((r) => upkeepStatus(r, today));
  const due = st.filter((x) => x && x.state !== 'ok').length;
  const never = st.filter((x) => !x).length;
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  el.textContent = `Home Projects: ${n(list.length, 'upkeep reminder')}, ${due ? `${due} due soon or overdue (shown under Maintenance)` : 'none due soon'}`
    + (never ? `. ${n(never, 'reminder')} ${never === 1 ? "isn't" : "aren't"} included until you log a last-done date.` : '.');
}
$('mb-form').addEventListener('change', drawPreview);

// ---------- loading and saving -----------------------------------------------------------

let me = null;

async function load(user) {
  me = user;
  $('mb-email').textContent = user.email || '(no email on this account)';
  const [settings, status, records, projects, upkeep] = await Promise.all([
    getDoc(doc(db, 'briefs', user.uid)),
    getDoc(doc(db, 'briefStatus', user.uid)),
    getDocs(collection(db, 'logbook', user.uid, 'records')),
    getDocs(collection(db, 'logbook', user.uid, 'projects')),
    // Home Projects upkeep reminders; the preview still works if these can't be read
    getDocs(query(collection(db, 'homeprojects', user.uid, 'projects'), where('kind', '==', 'upkeep'))).catch((err) => { console.error(err); return { docs: [], failed: true }; }),
  ]);
  fill(settings.exists() ? settings.data() : { enabled: false, hour: 6, tz: here, sections: DEFAULT_SECTIONS });
  data = {
    records: records.docs.map((d) => ({ id: d.id, ...d.data() })),
    projects: projects.docs.map((d) => ({ id: d.id, ...d.data() })),
    upkeep: upkeep.docs.map((d) => ({ id: d.id, ...d.data() })),
    upkeepError: !!upkeep.failed,
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
      ? 'Saved. Your test email will arrive within the hour (or run Actions › Morning Brief to send it now).'
      : s.enabled && s.mode === 'maintenance'
        ? `Saved. You'll get an email when maintenance comes due (checked daily around ${hourLabel(s.hour)}).`
        : s.enabled
        ? `Saved. Your brief will arrive ${s.frequency === 'weekly' ? `every ${WEEKDAYS[s.weekday]}` : 'each day'} shortly after ${hourLabel(s.hour)}.`
        : 'Saved. The brief is off.', 'ok');
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
