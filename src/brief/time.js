// time.js: small time-zone helpers for the Morning Brief, with no libraries.
// Works the same in the browser and in Node (both have Intl time zones).

const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

/** Wall-clock parts of an instant in a time zone: {y, m (1-12), d, h, mi, s, dow (0=Sun)}. */
export function zonedParts(ms, tz) {
  const o = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  const y = +o.year, m = +o.month, d = +o.day;
  return { y, m, d, h: +o.hour % 24, mi: +o.minute, s: +o.second, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** The instant (ms) for a wall-clock time in a time zone (handles daylight saving). */
export function zonedToMs(y, m, d, h = 0, mi = 0, s = 0, tz = 'UTC') {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  if (tz === 'UTC') return guess;
  const off = (ms) => {
    const p = zonedParts(ms, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ms;
  };
  let t = guess - off(guess);
  t = guess - off(t); // second pass settles daylight-saving edges
  return t;
}

/** "2026-11-14" for an instant in a time zone. */
export function dateKey(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Whole days from one "YYYY-MM-DD" to another. */
export function daysBetween(fromKey, toKey) {
  const ms = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(toKey) - ms(fromKey)) / 86400000);
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** "8:30 AM" in a time zone. */
export function fmtTime(ms, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** "Saturday, November 14, 2026" for a "YYYY-MM-DD" key. */
export function fmtLongDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** "Wed, Nov 18" for a "YYYY-MM-DD" key. */
export function fmtShortDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}
