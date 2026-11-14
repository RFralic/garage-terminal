// ics.js: reads a calendar's iCal (.ics) feed and lists the events in a time
// window, including repeating events. No libraries.
//
// Covers what Google, Apple and Outlook calendars normally publish: all-day
// and timed events, time zones (TZID), RRULE with FREQ DAILY / WEEKLY /
// MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (also "2TU", "-1FR"),
// BYMONTHDAY and BYMONTH, plus EXDATE, moved or cancelled single occurrences
// (RECURRENCE-ID) and STATUS:CANCELLED.
//
//   eventsInWindow(icsText, { fromMs, toMs, tz })
//     -> [{ title, location, allDay, startMs, endMs }] sorted by start

import { isValidTimeZone, zonedToMs } from './time.js';

const DAY = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ---------- parsing ---------------------------------------------------------------

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const colon = findValueColon(line);
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** The colon that starts the value (colons inside quoted parameters don't count). */
function findValueColon(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) return i;
  }
  return -1;
}

const unescapeText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

/** DTSTART-style value -> { date: {y,m,d}, time: {h,mi,s} | null, tz } */
function parseWhen(prop, fallbackTz) {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const date = { y: +m[1], m: +m[2], d: +m[3] };
  if (!m[4] || prop.params.VALUE === 'DATE') return { date, time: null, tz: fallbackTz };
  const tz = m[7] ? 'UTC' : (prop.params.TZID && isValidTimeZone(prop.params.TZID) ? prop.params.TZID : fallbackTz);
  return { date, time: { h: +m[4], mi: +m[5], s: +(m[6] || 0) }, tz };
}

function whenToMs(w, dateOverride) {
  const d = dateOverride || w.date;
  const t = w.time || { h: 0, mi: 0, s: 0 };
  return zonedToMs(d.y, d.m, d.d, t.h, t.mi, t.s, w.tz);
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRule(v) {
  const r = {};
  for (const part of String(v).split(';')) {
    const [k, val] = part.split('=');
    if (k && val !== undefined) r[k.toUpperCase()] = val.toUpperCase();
  }
  return r;
}

function parseEvents(text, tz) {
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { cur = { props: {}, exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'EXDATE') {
      for (const v of p.value.split(',')) cur.exdates.push({ ...p, value: v });
    } else if (!cur.props[p.name]) {
      cur.props[p.name] = p;
    }
  }

  return events.map((e) => {
    const start = e.props.DTSTART && parseWhen(e.props.DTSTART, tz);
    if (!start) return null;
    const allDay = !start.time;
    let durationMs;
    const end = e.props.DTEND && parseWhen(e.props.DTEND, tz);
    if (end) {
      durationMs = allDay
        ? (Date.UTC(end.date.y, end.date.m - 1, end.date.d) - Date.UTC(start.date.y, start.date.m - 1, start.date.d))
        : whenToMs(end) - whenToMs(start);
    } else if (e.props.DURATION) {
      durationMs = parseDuration(e.props.DURATION.value);
    }
    if (durationMs == null || durationMs < 0) durationMs = allDay ? DAY : 0;
    const recurrenceId = e.props['RECURRENCE-ID'] && parseWhen(e.props['RECURRENCE-ID'], start.tz);
    return {
      uid: e.props.UID ? e.props.UID.value : '',
      title: e.props.SUMMARY ? unescapeText(e.props.SUMMARY.value) : '(No title)',
      location: e.props.LOCATION ? unescapeText(e.props.LOCATION.value) : '',
      cancelled: e.props.STATUS ? e.props.STATUS.value.trim().toUpperCase() === 'CANCELLED' : false,
      start, allDay, durationMs,
      rule: e.props.RRULE ? parseRule(e.props.RRULE.value) : null,
      exdates: e.exdates.map((x) => parseWhen(x, start.tz)).filter(Boolean),
      recurrenceId,
    };
  }).filter(Boolean);
}

// ---------- repeating events ----------------------------------------------------------

const addDays = (d, n) => {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d) + n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const dow = (d) => new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dateNum = (d) => d.y * 10000 + d.m * 100 + d.d;

/** Days of one month matching BYDAY entries like "TU", "2TU", "-1FR". */
function monthDaysByDay(y, m, bydays) {
  const n = daysInMonth(y, m);
  const out = [];
  for (const spec of bydays) {
    const mm = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(spec);
    if (!mm) continue;
    const wd = WEEKDAYS.indexOf(mm[2]);
    const matches = [];
    for (let day = 1; day <= n; day++) if (dow({ y, m, d: day }) === wd) matches.push(day);
    if (!mm[1]) out.push(...matches);
    else {
      const k = +mm[1];
      const pick = k > 0 ? matches[k - 1] : matches[matches.length + k];
      if (pick) out.push(pick);
    }
  }
  return out;
}

function monthDays(y, m, rule, startDay) {
  if (rule.BYDAY) return monthDaysByDay(y, m, rule.BYDAY.split(','));
  const n = daysInMonth(y, m);
  const wanted = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : [startDay];
  return wanted.map((x) => (x < 0 ? n + 1 + x : x)).filter((x) => x >= 1 && x <= n);
}

/** Yields occurrence dates ({y,m,d}) of a repeating event, in order, from its start. */
function* occurrenceDates(start, rule) {
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const s = start.date;
  const freq = rule.FREQ;
  const limit = 3000;
  let i = 0;
  if (freq === 'DAILY') {
    for (; i < limit; i++) yield addDays(s, i * interval);
  } else if (freq === 'WEEKLY') {
    const days = (rule.BYDAY ? rule.BYDAY.split(',') : [WEEKDAYS[dow(s)]])
      .map((x) => WEEKDAYS.indexOf(x.replace(/^[+-]?\d+/, ''))).filter((x) => x >= 0)
      .map((x) => (x + 6) % 7).sort((a, b) => a - b); // Monday-first offsets
    const weekStart = addDays(s, -((dow(s) + 6) % 7));
    for (; i < limit; i++) {
      for (const off of days) {
        const d = addDays(weekStart, i * 7 * interval + off);
        if (dateNum(d) >= dateNum(s)) yield d;
      }
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const months = rule.BYMONTH ? rule.BYMONTH.split(',').map(Number).sort((a, b) => a - b) : null;
    for (; i < limit; i++) {
      const list = [];
      if (freq === 'MONTHLY') {
        const t = s.m - 1 + i * interval;
        list.push({ y: s.y + Math.floor(t / 12), m: (t % 12) + 1 });
      } else {
        for (const m of months || [s.m]) list.push({ y: s.y + i * interval, m });
      }
      for (const { y, m } of list) {
        const ds = (freq === 'YEARLY' && !rule.BYDAY && !rule.BYMONTHDAY) ? (s.d <= daysInMonth(y, m) ? [s.d] : []) : monthDays(y, m, rule, s.d);
        for (const day of [...new Set(ds)].sort((a, b) => a - b)) {
          const d = { y, m, d: day };
          if (dateNum(d) >= dateNum(s)) yield d;
        }
      }
    }
  } else {
    yield s; // unknown frequency: just the first one
  }
}

// ---------- the window --------------------------------------------------------------

/**
 * Events overlapping [fromMs, toMs). `tz` is the reader's time zone, used for
 * all-day events and for times written without a zone.
 */
export function eventsInWindow(icsText, { fromMs, toMs, tz }) {
  const all = parseEvents(icsText, tz);
  const instanceKey = (w, d) => `${dateNum(d)}|${w.time ? whenToMs(w, d) : ''}`;

  // Moved or cancelled single occurrences replace the series' own copy.
  const overridden = new Map(); // uid -> Set(instanceKey of the original)
  for (const e of all) {
    if (!e.recurrenceId) continue;
    if (!overridden.has(e.uid)) overridden.set(e.uid, new Set());
    const r = e.recurrenceId;
    overridden.get(e.uid).add(r.time ? `ms|${whenToMs(r)}` : `d|${dateNum(r.date)}`);
  }

  const out = [];
  const push = (e, startMs) => {
    const endMs = startMs + e.durationMs;
    const overlaps = e.durationMs > 0 ? (endMs > fromMs && startMs < toMs) : (startMs >= fromMs && startMs < toMs);
    if (overlaps) out.push({ title: e.title, location: e.location, allDay: e.allDay, startMs, endMs });
  };

  for (const e of all) {
    if (e.cancelled) continue;
    if (!e.rule || e.recurrenceId) { push(e, whenToMs(e.start)); continue; }

    const skip = new Set(e.exdates.map((x) => instanceKey(e.start, x.date)));
    const moved = overridden.get(e.uid) || new Set();
    const count = e.rule.COUNT ? parseInt(e.rule.COUNT, 10) : Infinity;
    const until = e.rule.UNTIL ? parseWhen({ value: e.rule.UNTIL, params: {} }, 'UTC') : null;
    const untilMs = until ? (until.time ? whenToMs(until) : Date.UTC(until.date.y, until.date.m - 1, until.date.d) + DAY - 1) : Infinity;
    let n = 0;
    for (const d of occurrenceDates(e.start, e.rule)) {
      const startMs = whenToMs(e.start, d);
      if (++n > count || startMs > untilMs || startMs >= toMs) break;
      if (skip.has(instanceKey(e.start, d))) continue;
      if (moved.has(e.allDay ? `d|${dateNum(d)}` : `ms|${startMs}`)) continue;
      push(e, startMs);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || (b.allDay - a.allDay));
}

/** Accepts the address people copy from Google/Apple/Outlook calendar settings. */
export function normalizeCalendarUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  u = u.replace(/^webcals?:\/\//i, 'https://');
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
