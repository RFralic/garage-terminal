// logic.js: the Pantry's rules for counts, expiration dates, barcodes and
// homemade batch codes. No Firebase and no page here, so it runs the same in
// the browser and in the tests (tests/pantry.logic.test.js).
//
// An item's count is kept in "lots": [{ qty, expires: "YYYY-MM-DD" | "" }].
// Two cans that expire in March and four that expire in June are two lots.
// "Used 1" always takes from the lot that expires first.

export const LOCATIONS = ['Pantry', 'Fridge', 'Freezer', 'Supplies', 'Basement'];

/** How homemade food was put up, and the default "use by" for each, in months. */
export const METHODS = [
  { name: 'Water bath', months: 12 },
  { name: 'Pressure canned', months: 12 },
  { name: 'Frozen', months: 6 },
  { name: 'Dehydrated', months: 6 },
  { name: 'Fermented', months: 3 },
  { name: 'Other', months: 3 },
];

/** Items that expire within this many days count as "expiring soon". */
export const SOON_DAYS = 7;

// ---------- barcodes -------------------------------------------------------------

/** Trims a scanned code and drops control characters some scanners add. */
export function cleanCode(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/** Store barcodes: all digits, 8, 12 or 13 long (EAN-8, UPC-A, EAN-13). */
export function isRetail(v) {
  return /^(\d{8}|\d{12}|\d{13})$/.test(cleanCode(v));
}

/**
 * The form a code is compared in. A UPC-A read as EAN-13 has an extra leading 0
 * (some scanners do that), so "0041331021551" and "041331021551" match.
 * Other codes ignore spaces, dashes and capitals.
 */
export function codeKey(v) {
  const c = cleanCode(v);
  if (/^\d{13}$/.test(c) && c.startsWith('0')) return c.slice(1);
  if (isRetail(c)) return c;
  return c.toUpperCase().replace(/[\s-]+/g, '');
}

/** Items that carry this barcode. */
export function findByCode(items, code) {
  const k = codeKey(code);
  if (!k) return [];
  return items.filter((it) => (it.barcodes || []).some((b) => codeKey(b) === k));
}

// ---------- homemade batch codes -------------------------------------------------

/**
 * Batch 42 → "20000042": 8 digits starting with 2. Codes starting 20–29 are kept
 * for in-store use, so they never clash with a real product's UPC/EAN.
 */
export function batchCode(n) {
  if (!Number.isInteger(n) || n < 1 || n > 9999999) throw new Error('Batch number must be 1–9,999,999');
  return '2' + String(n).padStart(7, '0');
}

/** "20000042" → 42; anything else → null. */
export function batchFromCode(code) {
  const c = cleanCode(code);
  if (!/^2\d{7}$/.test(c)) return null;
  const n = Number(c.slice(1));
  return n > 0 ? n : null;
}

/** "20000042" → "2000 0042" (how it's printed under the bars). */
export function spacedCode(code) {
  return code.length === 8 ? code.slice(0, 4) + ' ' + code.slice(4) : code;
}

// ---------- moving and bulk scanning ---------------------------------------------
// An item lives in one place. Moving some of it somewhere else either joins the same
// thing that's already there, or starts a new entry there with the same details.

/** Takes `n` from the lots, soonest-expiring first, keeping their dates. Returns { taken, left }. */
export function takeLots(lots, n) {
  const left = sortLots(lots);
  const taken = [];
  let want = Math.max(0, Math.floor(Number(n) || 0));
  for (const l of left) {
    if (!want) break;
    const t = Math.min(l.qty, want);
    if (t) { taken.push({ qty: t, expires: l.expires }); l.qty -= t; want -= t; }
  }
  return { taken, left: left.filter((l) => l.qty > 0) };
}

/** Adds lots (with their dates) to other lots. */
export function mergeLots(lots, more) {
  let out = sortLots(lots);
  for (const l of sortLots(more)) out = addToLots(out, l.qty, l.expires);
  return out;
}

const norm = (v) => String(v || '').trim().toLowerCase();
/** The same thing kept somewhere else: a shared barcode, or the same name, brand and size. */
export function sameThing(a, b) {
  const codes = new Set((a.barcodes || []).map(codeKey));
  if ((b.barcodes || []).some((c) => codes.has(codeKey(c)))) return true;
  return !!norm(a.name) && norm(a.name) === norm(b.name) && norm(a.brand) === norm(b.brand) && norm(a.size) === norm(b.size);
}

/** The details copied to a new entry for the same thing in another place. */
const COPY_KEYS = ['name', 'brand', 'size', 'barcodes', 'photo', 'notes', 'homemade', 'keepAtLeast'];
export function copyFor(item, location, lots) {
  const out = { location, lots };
  for (const k of COPY_KEYS) if (item[k] !== undefined && item[k] !== null) out[k] = JSON.parse(JSON.stringify(item[k]));
  // "keep at least" is about the place it came from; the new spot starts without one
  out.keepAtLeast = null;
  return out;
}

/**
 * Plan a move of `n` of `item` to `to`. Returns
 *   { update: [{ id, lots, location? }], create: [item], remove: [id], into: name of what it joined or '' }
 * The soonest-expiring ones move first and keep their dates.
 */
export function planMove(items, item, n, to) {
  const total = totalQty(item);
  const qty = Math.min(total, Math.max(1, Math.floor(Number(n) || 0)));
  const target = items.find((x) => x.id !== item.id && x.location === to && sameThing(x, item));
  const plan = { update: [], create: [], remove: [], into: target ? target.name : '' };
  if (!total || to === item.location) return plan;
  const { taken, left } = takeLots(item.lots, qty);
  if (target) {
    plan.update.push({ id: target.id, lots: mergeLots(target.lots, taken) });
    if (left.length) plan.update.push({ id: item.id, lots: left });
    // All of it joined the other one: the old entry goes, unless it has a "keep at least"
    // (then it stays at 0, so the shopping list still says to restock that spot).
    else if (item.keepAtLeast) plan.update.push({ id: item.id, lots: [] });
    else plan.remove.push(item.id);
  } else if (!left.length) {
    plan.update.push({ id: item.id, lots: taken, location: to }); // everything moves: the item just changes place
  } else {
    plan.update.push({ id: item.id, lots: left });
    plan.create.push(copyFor(item, to, taken));
  }
  return plan;
}

/**
 * Plan a bulk scan into `location`. `rows` are the review lines:
 *   { code, n, expires, itemId? (a known item), name, brand, size, photo (for a new one) }
 * A known item that already lives in `location` gets +n there. One that lives somewhere else
 * gets +n on the same thing in `location`, or a new entry there. Unknown codes become new items.
 * Returns { add: [{ id, n, expires }], create: [item] }.
 */
export function planBulk(items, rows, location) {
  const plan = { add: [], create: [] };
  const made = []; // new entries in this plan, so two lines for the same thing join up
  for (const r of rows) {
    const n = Math.max(0, Math.floor(Number(r.n) || 0));
    if (!n) continue;
    const lot = { qty: n, expires: r.expires || '' };
    const known = r.itemId && items.find((x) => x.id === r.itemId);
    const probe = known || { name: r.name, brand: r.brand, size: r.size, barcodes: r.code ? [r.code] : [] };
    const here = known && known.location === location ? known
      : items.find((x) => x.location === location && sameThing(x, probe));
    if (here) { plan.add.push({ id: here.id, n, expires: r.expires || '' }); continue; }
    const again = made.find((x) => sameThing(x, probe));
    if (again) { again.lots = mergeLots(again.lots, [lot]); continue; }
    const fresh = known ? copyFor(known, location, [lot])
      : { name: String(r.name || '').trim(), brand: r.brand || '', size: r.size || '', photo: r.photo || '', notes: '', homemade: null,
        keepAtLeast: null, barcodes: r.code ? [r.code] : [], location, lots: [lot] };
    if (known && r.code && !(fresh.barcodes || []).some((c) => codeKey(c) === codeKey(r.code))) fresh.barcodes = [...(fresh.barcodes || []), r.code];
    made.push(fresh);
    plan.create.push(fresh);
  }
  return plan;
}

// ---------- dates (plain "YYYY-MM-DD" strings, local calendar days) -------------

const pad = (n) => String(n).padStart(2, '0');

/** Today (or `d`) as "YYYY-MM-DD" in this device's time zone. */
export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

/** Whole days from `from` to `to` (both "YYYY-MM-DD"); negative if `to` is earlier. */
export function daysBetween(from, to) {
  const a = parseKey(from), b = parseKey(to);
  if (!a || !b) return null;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

/** "2026-06-14" + 12 months → "2027-06-14" (the 31st becomes the month's last day). */
export function addMonths(key, months) {
  const p = parseKey(key);
  if (!p) return '';
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12), m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(p.d, last))}`;
}

/** "2026-06-14" → "06/14/26". */
export function fmtMDY(key) {
  const p = parseKey(key);
  return p ? `${pad(p.m)}/${pad(p.d)}/${String(p.y).slice(2)}` : '';
}

/** "2027-06-14" → "06/2027". */
export function fmtMY(key) {
  const p = parseKey(key);
  return p ? `${pad(p.m)}/${p.y}` : '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-18" → "Nov 18" (this year) or "Nov 18, 2027". */
export function fmtShort(key, today = todayKey()) {
  const p = parseKey(key);
  if (!p) return '';
  const t = parseKey(today);
  return `${MONTHS[p.m - 1]} ${p.d}${t && t.y === p.y ? '' : ', ' + p.y}`;
}

/** Default "use by" for a homemade batch: made date + the method's months (or the pantry's own setting). */
export function useByFor(method, made, settings = {}) {
  const own = settings && Number.isInteger(settings[method]) ? settings[method] : null;
  const def = (METHODS.find((x) => x.name === method) || METHODS[METHODS.length - 1]).months;
  return addMonths(made, own ?? def);
}

// ---------- counts and lots ------------------------------------------------------

const qtyOf = (l) => Math.max(0, Math.floor(Number(l && l.qty) || 0));

/** Lots with something in them, soonest expiration first; no date goes last. */
export function sortLots(lots) {
  return (lots || [])
    .map((l) => ({ qty: qtyOf(l), expires: (l && l.expires) || '' }))
    .filter((l) => l.qty > 0)
    .sort((a, b) => (a.expires === b.expires ? 0 : !a.expires ? 1 : !b.expires ? -1 : a.expires < b.expires ? -1 : 1));
}

export function totalQty(item) {
  return (item.lots || []).reduce((s, l) => s + qtyOf(l), 0);
}

/** Takes `n` from the lots, soonest-expiring first. Returns { lots, taken }. */
export function useFromLots(lots, n = 1) {
  const out = sortLots(lots);
  let left = n;
  for (const l of out) {
    if (!left) break;
    const t = Math.min(l.qty, left);
    l.qty -= t;
    left -= t;
  }
  return { lots: out.filter((l) => l.qty > 0), taken: n - left };
}

/**
 * Adds `n`. With an expiration date it joins (or starts) the lot with that date.
 * Without one it joins the lot that expires last (the newest purchase), or a
 * lot with no date if there are none.
 */
export function addToLots(lots, n = 1, expires) {
  const out = sortLots(lots);
  if (n <= 0) return out;
  if (expires !== undefined) {
    const same = out.find((l) => l.expires === (expires || ''));
    if (same) same.qty += n;
    else out.push({ qty: n, expires: expires || '' });
    return sortLots(out);
  }
  const dated = out.filter((l) => l.expires);
  const target = dated.length ? dated[dated.length - 1] : out.find((l) => !l.expires);
  if (target) target.qty += n;
  else out.push({ qty: n, expires: '' });
  return sortLots(out);
}

/** The soonest expiration date among lots that still have something in them, or "". */
export function nextExpiry(item) {
  const l = sortLots(item.lots).find((x) => x.expires);
  return l ? l.expires : '';
}

/** "expired", "soon" (within SOON_DAYS), "ok", or "" when there's no date. */
export function expiryStatus(key, today = todayKey()) {
  if (!key) return '';
  const d = daysBetween(today, key);
  if (d == null) return '';
  if (d < 0) return 'expired';
  if (d <= SOON_DAYS) return 'soon';
  return 'ok';
}

/** How many to buy to get back to "keep at least"; 0 if there's enough. */
export function shortBy(item) {
  const keep = Math.floor(Number(item.keepAtLeast) || 0);
  return keep > 0 ? Math.max(0, keep - totalQty(item)) : 0;
}

/** Items that are below "keep at least", for the shopping list. */
export function lowItems(items) {
  return items.filter((it) => shortBy(it) > 0).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** Items with something expiring within SOON_DAYS (or already expired), soonest first. */
export function expiringItems(items, today = todayKey()) {
  return items
    .filter((it) => totalQty(it) > 0 && ['expired', 'soon'].includes(expiryStatus(nextExpiry(it), today)))
    .sort((a, b) => (nextExpiry(a) < nextExpiry(b) ? -1 : 1));
}

/** The shopping list as plain text, for "Copy list". */
export function shoppingText(low, extra) {
  const lines = [
    ...low.map((it) => `- ${it.name}${it.size ? ' (' + it.size + ')' : ''}: buy ${shortBy(it)}`),
    ...extra.filter((x) => !x.done).map((x) => `- ${x.name}`),
  ];
  return lines.length ? lines.join('\n') : 'Nothing on the list.';
}

// ---------- size or count ("8 oz", "1.5 lb", "12 pieces") ----------------------------

/** Units offered for an item's size, grouped. Counts are for bags or boxes of things. */
export const SIZE_UNITS = [
  ['Count', ['count', 'pieces', 'servings']],
  ['Weight', ['oz', 'lb', 'g', 'kg']],
  ['Volume', ['fl oz', 'cup', 'pt', 'qt', 'gal', 'ml', 'L']],
];
const ALL_UNITS = SIZE_UNITS.flatMap(([, u]) => u);
const UNIT_ALIASES = {
  ct: 'count', cnt: 'count', pcs: 'pieces', pc: 'pieces', piece: 'pieces', serving: 'servings',
  ounce: 'oz', ounces: 'oz', lbs: 'lb', pound: 'lb', pounds: 'lb', gram: 'g', grams: 'g',
  'fl. oz': 'fl oz', 'fl.oz': 'fl oz', floz: 'fl oz', cups: 'cup', pint: 'pt', pints: 'pt', quart: 'qt', quarts: 'qt',
  gallon: 'gal', gallons: 'gal', l: 'L', liter: 'L', liters: 'L', litre: 'L', mL: 'ml',
};

/** "8 oz" → { num: "8", unit: "oz" }; "12 ct" → { num: "12", unit: "count" }; anything else → { other: text }. */
export function parseSize(text) {
  const s = String(text || '').trim();
  if (!s) return { num: '', unit: '' };
  const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z. ]*?)\.?$/.exec(s);
  if (m) {
    const raw = m[2].trim();
    const unit = ALL_UNITS.find((u) => u === raw) || ALL_UNITS.find((u) => u.toLowerCase() === raw.toLowerCase()) || UNIT_ALIASES[raw] || UNIT_ALIASES[raw.toLowerCase()];
    if (unit) return { num: m[1], unit };
  }
  return { other: s };
}

/** ("12", "pieces") → "12 pieces"; no number → "". */
export function formatSize(num, unit) {
  const n = String(num || '').trim();
  if (!n) return '';
  return unit ? `${n} ${unit}` : n;
}

// ---------- invites ----------------------------------------------------------------

// No 0/O, 1/I/L: easy to read out loud and type.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A random 8-character invite code. `rand` returns 0 ≤ x < 1 (crypto by default). */
export function makeInviteCode(rand) {
  let r = rand;
  if (!r) {
    const buf = new Uint32Array(8);
    globalThis.crypto.getRandomValues(buf);
    let i = 0;
    r = () => buf[i++] / 2 ** 32;
  }
  let s = '';
  for (let i = 0; i < 8; i++) s += INVITE_ALPHABET[Math.floor(r() * INVITE_ALPHABET.length)];
  return s;
}

/** What someone typed (or a link carried) → "K7Q2MXAB", or "" if it can't be a code. */
export function normalizeInvite(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{8}$/.test(s) ? s : '';
}

/** "K7Q2MXAB" → "K7Q2-MXAB". */
export function spacedInvite(code) {
  return code ? code.slice(0, 4) + '-' + code.slice(4) : '';
}
