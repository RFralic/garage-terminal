// pantry.js: the /apps/pantry page. A household's food and supplies, shared by
// everyone in the pantry, logged in and out with the Logbook's barcode scanner
// (public/apps/scanner.js: phone camera or a Bluetooth scanner).
//
//   Pantry tab     search, Scan, expiring / running low, items by location; Bulk scan in
//                  (scan a load into one place, check the list, save it all) and Move (an
//                  item, or some of it, to another place: logic.js planMove / planBulk)
//   Shopping tab   running low (automatic) + things added by hand, Scan groceries in
//   Household tab  people and roles, invite codes, use-by defaults, activity
//
// Homemade batches get their own barcode (batch 42 → 20000042, see logic.js) and
// a label image sized for a thermal label printer (label.js).
//
// Data and who may change it: src/pantry/store.js and the PANTRY section of
// firestore.rules. Everything is built with textContent (el()), never innerHTML.

import { mountHeader } from '../lib/header.js';
import { watchSession } from '../lib/session.js';
import { el, timeAgo } from '../lib/ui.js';
import * as L from '../pantry/logic.js';
import * as St from '../pantry/store.js';
import { lookupProduct } from '../pantry/off.js';
import { DIRECTIONS, LABEL_SIZES, canShareImages, renderDirections, fontsReady, labelBlob, labelFileName, renderLabel, saveToPhone, shareImage } from '../pantry/label.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not saved; fine */ } },
};

const S = {
  me: null, pantries: [], pid: '', pantry: null, items: [], shopping: [], activity: [],
  tab: 'pantry', filter: 'All', search: '', unsubs: [],
};

const role = () => (S.pantry && S.me && S.pantry.members ? S.pantry.members[S.me.uid] : '');
const canEdit = () => ['owner', 'member'].includes(role());
const isOwner = () => role() === 'owner';
const errText = (e) => (e && e.code === 'permission-denied' ? "you don't have permission for that" : (e && (e.message || e.code)) || 'unknown error');

// ---------- small UI pieces ---------------------------------------------------------

// No signal: say so, so nobody wonders why a change hasn't reached the rest of the household yet.
const showOffline = () => { const b = $('pt-offline'); if (b) b.hidden = !St.isOffline(); };
window.addEventListener('online', () => { showOffline(); toast('Back online. Your changes are syncing.'); });
window.addEventListener('offline', showOffline);
showOffline();

let toastTimer;
function toast(msg) {
  const t = $('pt-toast');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ''; }, 4000);
}

const ICON_SCAN = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '20'); s.setAttribute('height', '20'); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M17 8v8');
  s.append(p);
  return s;
};

function btn(label, onclick, cls = '', extra = {}) {
  return el('button', { type: 'button', class: 'pt-b ' + cls, onclick, ...extra }, label);
}

function avatar(uid, name) {
  const i = Math.max(0, (S.pantry?.memberIds || []).indexOf(uid)) % 5;
  return el('span', { class: `pt-av pt-c${i}`, 'aria-hidden': 'true' }, (name || '?').trim().charAt(0).toUpperCase() || '?');
}

function field(label, input) {
  return el('label', { class: 'f' }, el('span', { class: 'field-label' }, label), input);
}

function input(attrs = {}) {
  const i = el('input', { class: 'field', ...attrs });
  if (attrs.value !== undefined) i.value = attrs.value;
  return i;
}

function select(options, value) {
  const s = el('select', { class: 'field' });
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    s.append(new Option(t, v));
  }
  s.value = value;
  return s;
}

/**
 * "Size or count": a number and a unit (8 oz, 1.5 lb, 12 pieces…), or "Other…" to type
 * anything. Returns { node, get() } where get() gives the text that's saved ("12 pieces").
 */
function sizeField(value, { disabled = false, label = 'Size or count' } = {}) {
  const p = L.parseSize(value);
  const num = input({ type: 'text', inputmode: 'decimal', value: p.num || '', placeholder: '12', 'aria-label': `${label}: amount`, maxlength: '8', disabled, style: 'width:90px;flex:none' });
  const unit = el('select', { class: 'field', 'aria-label': `${label}: unit`, disabled, style: 'flex:1;min-width:0' });
  for (const [group, units] of L.SIZE_UNITS) {
    const g = el('optgroup', { label: group });
    for (const u of units) g.append(new Option(u, u));
    unit.append(g);
  }
  unit.append(new Option('Other…', '__other'));
  const other = input({ value: p.other || '', placeholder: 'e.g. 8 oz (half-pint), family size', maxlength: '40', 'aria-label': label, disabled });
  unit.value = p.other ? '__other' : p.unit || store.get('ptSizeUnit', 'count');
  const sync = () => { const o = unit.value === '__other'; other.hidden = !o; num.hidden = o; };
  unit.addEventListener('change', () => {
    if (unit.value === '__other') { if (!other.value && num.value) other.value = num.value; sync(); other.focus(); return; }
    store.set('ptSizeUnit', unit.value);
    sync();
  });
  sync();
  const node = el('div', { class: 'f' }, el('span', { class: 'field-label' }, label),
    el('div', { style: 'display:flex;gap:8px' }, num, unit), other);
  return {
    node,
    get: () => (unit.value === '__other' ? other.value.trim() : L.formatSize(num.value.replace(',', '.').trim(), unit.value)),
  };
}

// ---------- pop-up sheets ------------------------------------------------------------

let sheet = null;
function openSheet(title, sub, body, opts = {}) {
  closeSheet();
  const close = el('button', { type: 'button', class: 'pt-x', 'aria-label': 'Close', onclick: closeSheet }, '✕');
  const head = el('div', { class: 'pt-sheethead' }, el('div', {}, sub ? el('small', {}, sub) : null, el('h2', { id: 'pt-sheet-title' }, title)), close);
  const box = el('div', { class: 'pt-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pt-sheet-title' }, head, ...body);
  const wrap = el('div', { class: 'pt-sheetwrap' }, box);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeSheet(); });
  const back = document.activeElement;
  document.body.append(wrap);
  document.body.classList.add('pt-sheet-open');
  sheet = { wrap, back, onClose: opts.onClose };
  const first = box.querySelector(opts.focus || 'input,select,textarea') || close;
  try { first.focus({ preventScroll: true }); } catch { /* fine */ }
  return box;
}
function closeSheet() {
  if (!sheet) return;
  const s = sheet; sheet = null;
  s.wrap.remove();
  document.body.classList.remove('pt-sheet-open');
  if (s.onClose) s.onClose();
  if (s.back && s.back.isConnected) { try { s.back.focus({ preventScroll: true }); } catch { /* fine */ } }
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet && !(window.GTScan && GTScan.isOpen)) closeSheet();
});

// ---------- screens ----------------------------------------------------------------

function show(which) {
  for (const k of ['loading', 'guest', 'start', 'join', 'app']) $('pt-' + k).hidden = k !== which;
  $('pt-tabs').hidden = which !== 'app';
  navCheck();
}

function showTab(tab) {
  S.tab = tab;
  for (const t of ['pantry', 'shopping', 'household']) $('tab-' + t).hidden = t !== tab;
  for (const b of document.querySelectorAll('#pt-tabs button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  renderTab();
  window.scrollTo({ top: 0 });
  navCheck();
}
for (const b of document.querySelectorAll('#pt-tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
$('pt-people').addEventListener('click', () => showTab('household'));

// ---------- phone back button -------------------------------------------------------
// While a pop-up, the scanner, or the Shopping or Household tab is showing, one extra
// history entry sits on top. The phone's back button removes it, and we close what is
// open (or go back to the Pantry tab) instead of leaving the app. Closing things with
// their own buttons takes the entry away again, so the next back press isn't wasted.
let navSkip = false, navTimer = 0;
function navNeeded() {
  if (window.GTScan && GTScan.isOpen) return true;
  if (sheet) return true;
  return !$('pt-app').hidden && !!S.tab && S.tab !== 'pantry';
}
function navCheck() {
  clearTimeout(navTimer);
  navTimer = setTimeout(() => {
    const top = !!(history.state && history.state.ptBack);
    try {
      if (navNeeded() && !top) history.pushState({ ptBack: 1 }, '');
      else if (!navNeeded() && top) { navSkip = true; history.back(); }
    } catch { /* fine */ }
  }, 0);
}
window.addEventListener('popstate', () => {
  if (navSkip) { navSkip = false; navCheck(); return; }
  if (window.GTScan && GTScan.isOpen) GTScan.close();
  else if (sheet) closeSheet();
  else if (!$('pt-app').hidden && S.tab && S.tab !== 'pantry') showTab('pantry');
  navCheck();
});
// The pop-ups and the scanner both mark <body> while open, so watch that.
new MutationObserver(navCheck).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---------- session and start-up ---------------------------------------------------

let bootedFor = '';
watchSession((s) => {
  if (s.state === 'loading') { show('loading'); return; }
  if (s.state === 'guest') {
    bootedFor = '';
    stopWatching();
    $('pt-signin').href = '/join?next=' + encodeURIComponent(location.pathname + location.search);
    show('guest');
    return;
  }
  const first = (s.user.displayName || '').trim().split(/\s+/)[0];
  S.me = { uid: s.user.uid, name: (s.profile && s.profile.handle) || first || 'Member' };
  if (bootedFor === s.user.uid) return;
  bootedFor = s.user.uid;
  boot();
});

async function boot() {
  show('loading');
  const code = L.normalizeInvite(new URLSearchParams(location.search).get('join'));
  try {
    S.pantries = await St.myPantries(S.me.uid);
  } catch (e) {
    S.pantries = [];
    showStart(`Couldn't load your pantries: ${errText(e)}`);
    return;
  }
  if (code) { offerJoin(code); return; }
  openFromList();
}

function openFromList() {
  if (!S.pantries.length) { showStart(); return; }
  const saved = store.get('ptPantry', '');
  openPantry(S.pantries.some((p) => p.id === saved) ? saved : S.pantries[0].id);
}

function showStart(msg = '') {
  stopWatching();
  $('pt-start-title').textContent = S.pantries.length ? 'Start or join another pantry' : 'Set up your pantry';
  $('pt-new-name').value = S.pantries.length ? '' : 'Household';
  $('pt-start-msg').textContent = msg;
  $('pt-start-msg').dataset.kind = msg ? 'bad' : '';
  $('pt-start-back').hidden = !S.pantries.length;
  show('start');
}
$('pt-start-back').addEventListener('click', openFromList);

$('pt-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = e.submitter || $('pt-new').querySelector('button');
  b.disabled = true;
  try {
    const id = await St.createPantry(S.me, $('pt-new-name').value);
    St.log(id, S.me, 'started the pantry');
    S.pantries = await St.myPantries(S.me.uid);
    openPantry(id);
  } catch (err) {
    $('pt-start-msg').textContent = `Couldn't start it: ${errText(err)}`;
    $('pt-start-msg').dataset.kind = 'bad';
  } finally { b.disabled = false; }
});

$('pt-code').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = L.normalizeInvite($('pt-code-in').value);
  if (!code) {
    $('pt-start-msg').textContent = 'Invite codes are 8 letters and numbers, like K7Q2-MXAB.';
    $('pt-start-msg').dataset.kind = 'bad';
    return;
  }
  offerJoin(code);
});

function clearJoinParam() {
  const u = new URL(location.href);
  if (u.searchParams.has('join')) { u.searchParams.delete('join'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
}

async function offerJoin(code) {
  clearJoinParam();
  let inv;
  try { inv = await St.lookupInvite(code); } catch (e) { showStart(`Couldn't check that code: ${errText(e)}`); return; }
  if (!inv) { showStart(`No pantry has the code ${L.spacedInvite(code)}. Check it with whoever sent it.`); return; }
  if (S.pantries.some((p) => p.id === inv.pantryId)) { openPantry(inv.pantryId); toast(`You're already in ${inv.pantryName}.`); return; }
  if (inv.expiresAt && inv.expiresAt.toMillis() < Date.now()) { showStart('That invite code has expired. Ask for a new one.'); return; }
  stopWatching();
  $('pt-join-name').textContent = inv.pantryName || 'this pantry';
  $('pt-join-msg').textContent = '';
  show('join');
  $('pt-join-yes').onclick = async () => {
    $('pt-join-yes').disabled = true;
    try {
      await St.joinPantry(inv.pantryId, code, S.me);
      St.log(inv.pantryId, S.me, 'joined the pantry');
      S.pantries = await St.myPantries(S.me.uid);
      openPantry(inv.pantryId);
      toast(`Welcome to ${inv.pantryName}.`);
    } catch (e) {
      $('pt-join-msg').textContent = e && e.code === 'permission-denied'
        ? "Couldn't join: the code may have just been replaced or expired. Ask for a new one."
        : `Couldn't join: ${errText(e)}`;
      $('pt-join-msg').dataset.kind = 'bad';
    } finally { $('pt-join-yes').disabled = false; }
  };
  $('pt-join-no').onclick = openFromList;
}

// ---------- one pantry, live -------------------------------------------------------

function stopWatching() {
  for (const u of S.unsubs) u();
  S.unsubs = [];
}

function openPantry(pid) {
  stopWatching();
  closeSheet();
  Object.assign(S, { pid, pantry: null, items: [], shopping: [], activity: [], filter: 'All', search: '' });
  store.set('ptPantry', pid);
  show('loading');
  const fail = (e) => toast(`Lost the connection to the pantry: ${errText(e)}`);
  S.unsubs.push(St.watchPantry(pid, async (p) => {
    if (!p || !(p.memberIds || []).includes(S.me.uid)) {
      // Deleted, or someone took us out.
      S.pantries = await St.myPantries(S.me.uid).catch(() => []);
      if (S.pid === pid) { toast("You're no longer in that pantry."); openFromList(); }
      return;
    }
    const firstLoad = !S.pantry;
    S.pantry = p;
    S.pantries = S.pantries.map((x) => (x.id === p.id ? p : x));
    if (firstLoad) { show('app'); buildTabs(); showTab(S.tab); }
    renderTop();
    renderTab();
  }, async (e) => {
    // Usually: we were just taken out of this pantry.
    S.pantries = await St.myPantries(S.me.uid).catch(() => []);
    if (S.pantries.some((x) => x.id === pid)) showStart(`Couldn't open the pantry: ${errText(e)}`);
    else { toast("You're no longer in that pantry."); openFromList(); }
  }));
  S.unsubs.push(St.watchItems(pid, (items) => { S.items = items; renderTop(); renderTab(); }, fail));
  S.unsubs.push(St.watchShopping(pid, (list) => { S.shopping = list; renderTop(); if (S.tab === 'shopping') renderShopping(); }, fail));
  S.unsubs.push(St.watchActivity(pid, (list) => { S.activity = list; if (S.tab === 'household') renderActivity(); }, () => {}));
}

function renderTop() {
  const p = S.pantry;
  if (!p) return;
  $('pt-name').textContent = p.name;
  const sw = $('pt-switch');
  $('pt-switch-wrap').hidden = S.pantries.length < 2;
  if (S.pantries.length > 1) {
    sw.replaceChildren(...S.pantries.map((x) => new Option(x.name, x.id)));
    sw.value = p.id;
  }
  const ppl = $('pt-people');
  ppl.replaceChildren(...(p.memberIds || []).slice(0, 4).map((uid) => avatar(uid, (p.memberNames || {})[uid])));
  ppl.setAttribute('aria-label', `${(p.memberIds || []).length} ${(p.memberIds || []).length === 1 ? 'person' : 'people'} in this pantry`);
  const n = L.lowItems(S.items).length + S.shopping.filter((x) => !x.done).length;
  const c = $('pt-shop-count');
  c.textContent = n ? String(n) : '≡';
  c.classList.toggle('has', n > 0);
}
$('pt-switch').addEventListener('change', (e) => openPantry(e.target.value));

function renderTab() {
  if (!S.pantry) return;
  if (S.tab === 'pantry') renderPantry();
  else if (S.tab === 'shopping') renderShopping();
  else renderHousehold();
}

// Parts of each tab that must survive re-renders (what someone is typing) are built once.
const T = {};
function buildTabs() {
  // Pantry tab
  const search = input({ type: 'search', placeholder: 'Search the pantry', 'aria-label': 'Search the pantry', autocomplete: 'off' });
  search.addEventListener('input', () => { S.search = search.value; renderPantry(); });
  const scan = window.GTScan ? btn('Scan', () => startScan('look'), 'primary') : null;
  if (scan) scan.prepend(ICON_SCAN());
  const searchWrap = el('div', { class: 'pt-search' }, search);
  searchWrap.prepend(svgSearch());
  T.tiles = el('div', { class: 'pt-tiles' });
  T.chips = el('div', { class: 'pt-chips', role: 'group', 'aria-label': 'Show' });
  T.list = el('div', { class: 'pt-list' });
  T.adds = el('div', { class: 'pt-adds' });
  $('tab-pantry').replaceChildren(el('div', { class: 'pt-bar' }, searchWrap, scan), T.adds, T.tiles, T.chips, T.list);

  // Shopping tab
  T.low = el('div', {});
  T.extra = el('div', {});
  const add = input({ placeholder: 'Add something to buy', 'aria-label': 'Add something to buy', maxlength: '120', autocomplete: 'off' });
  const addForm = el('form', { class: 'pt-addrow' }, add, el('button', { type: 'submit', class: 'pt-b primary' }, 'Add'));
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = add.value.trim();
    if (!name) return;
    add.value = '';
    try { await St.addShopping(S.pid, S.me, name); } catch (err) { toast(`Couldn't add it: ${errText(err)}`); add.value = name; }
  });
  T.shopBtns = el('div', { class: 'pt-adds' });
  T.shopNote = el('div', {});
  $('tab-shopping').replaceChildren(
    el('div', { class: 'pt-top' }, el('div', { class: 'pt-title' }, el('h1', {}, 'Shopping list'))),
    T.low, T.extra, addForm, T.shopBtns, T.shopNote,
  );

  // Household tab
  T.house = el('div', {});
  T.act = el('div', {});
  $('tab-household').replaceChildren(T.house, el('h2', { class: 'pt-h2' }, 'Activity'), T.act);
}

function svgSearch() {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': 'true' })) s.setAttribute(k, v);
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '7');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M20 20l-3.5-3.5');
  s.append(c, p);
  return s;
}

// ---------- Pantry tab ----------------------------------------------------------------

function itemNote(it, today) {
  const exp = L.nextExpiry(it);
  const st = L.expiryStatus(exp, today);
  const total = L.totalQty(it);
  if (total > 0 && st === 'expired') return ['st-expired', `expired ${L.fmtShort(exp, today)}`];
  if (total > 0 && st === 'soon') {
    const d = L.daysBetween(today, exp);
    return ['st-soon', d === 0 ? 'expires today' : d === 1 ? 'expires tomorrow' : `expires ${L.fmtShort(exp, today)}`];
  }
  if (L.shortBy(it) > 0) return ['st-low', total ? `low · keep ${it.keepAtLeast}` : `out · keep ${it.keepAtLeast}`];
  if (it.homemade) return ['st-home', `batch ${it.homemade.batch}${it.homemade.made ? ' · made ' + L.fmtMDY(it.homemade.made) : ''}`];
  if (!total) return ['', 'none left'];
  if (exp) return ['', `exp ${L.fmtShort(exp, today)}`];
  return ['', it.brand || ''];
}

function locationsInUse() {
  const extra = [...new Set(S.items.map((i) => i.location).filter((l) => l && !L.LOCATIONS.includes(l)))].sort();
  return [...L.LOCATIONS, ...extra];
}

function renderPantry() {
  if (!T.list) return;
  const today = L.todayKey();
  const expiring = L.expiringItems(S.items, today);
  const low = L.lowItems(S.items);
  T.tiles.replaceChildren(
    el('button', { type: 'button', class: 'pt-tile' + (expiring.length ? ' warn' : ''), onclick: () => { S.filter = 'Expiring'; renderPantry(); } },
      el('b', {}, String(expiring.length)), el('span', {}, 'Expiring this week')),
    el('button', { type: 'button', class: 'pt-tile', onclick: () => showTab('shopping') },
      el('b', {}, String(low.length)), el('span', {}, 'Running low → list')),
  );

  const filters = ['All', 'Expiring', ...locationsInUse(), ...(S.items.some((i) => i.homemade) ? ['Homemade'] : [])];
  if (!filters.includes(S.filter)) S.filter = 'All';
  T.chips.replaceChildren(...filters.map((f) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(S.filter === f), onclick: () => { S.filter = f; renderPantry(); },
  }, f)));

  const q = S.search.trim().toLowerCase();
  let list = S.filter === 'Expiring' ? expiring
    : S.items.filter((i) => S.filter === 'All' || (S.filter === 'Homemade' ? !!i.homemade : i.location === S.filter));
  if (q) list = list.filter((i) => [i.name, i.brand, i.size, i.location, i.notes, ...(i.barcodes || [])].join(' ').toLowerCase().includes(q));
  // Things you have first (A–Z), then the ones that ran out.
  if (S.filter !== 'Expiring') list = [...list].sort((a, b) => ((L.totalQty(b) > 0) - (L.totalQty(a) > 0)) || (a.name || '').localeCompare(b.name || ''));

  T.list.replaceChildren(...(list.length ? list.map((it) => {
    const [cls, note] = itemNote(it, today);
    const total = L.totalQty(it);
    return el('button', { type: 'button', class: 'pt-row' + (total ? '' : ' zero'), onclick: () => openItem(it) },
      el('span', { class: 'pt-row-main' },
        el('span', { class: 'pt-row-name' }, it.name),
        el('span', { class: 'pt-row-sub' }, it.location || '', note ? ' · ' : '', note ? el('span', { class: cls }, note) : null)),
      el('span', { class: 'pt-row-qty' }, el('b', {}, String(total)), el('small', {}, it.size || '')));
  }) : [el('p', { class: 'pt-empty' }, S.items.length ? 'Nothing matches.' : canEdit()
    ? 'Nothing here yet. Scan something you have, or add it by hand.' : 'Nothing here yet.')]));

  T.adds.replaceChildren(...(canEdit() ? [
    window.GTScan ? btn('Bulk scan in', openBulkStart, 'primary') : null,
    btn('+ Add an item', () => openItem(null)),
    btn('+ Homemade batch', openBatch),
    window.GTScan ? btn('Scan to use up (−1 each)', () => startScan('use')) : null,
  ] : [el('p', { class: 'mutedt small' }, 'You can look but not change things here (viewer). The shopping list is open to you.')]));
}

// ---------- scanning ---------------------------------------------------------------

const VIA = { camera: 'Camera', bluetooth: 'Bluetooth scanner', typed: 'Typed in' };
let pending = [];
let pendingTimer = 0;

/** mode: "look" (show what it is), "use" (−1 each), "add" (+1 each, groceries in). */
function startScan(mode) {
  if (!window.GTScan) return;
  if (mode !== 'look' && !canEdit()) { toast('Viewers can\'t change counts.'); return; }
  const title = { look: 'Scan an item', use: 'Scan to use up', add: 'Scan groceries in' }[mode];
  GTScan.open({
    title,
    allowKeep: true,
    onCode: (r, { keep }) => {
      const hits = L.findByCode(S.items, r.text);
      if (mode === 'look') {
        if (keep) return hits.length ? hits.map((h) => `${h.name}: ${L.totalQty(h)} on hand`).join(' · ') : `Not in the pantry: ${r.text}`;
        if (hits.length) openFound(r, hits); else openNewCode(r);
        return '';
      }
      if (!hits.length) {
        if (keep) { if (!pending.includes(r.text)) pending.push(r.text); watchPending(); return `Not in the pantry yet: ${r.text}. Add it after.`; }
        openNewCode(r);
        return '';
      }
      const it = hits[0];
      const delta = mode === 'use' ? -1 : 1;
      if (delta < 0 && L.totalQty(it) <= 0) return `Not in the pantry: none of ${it.name} left`;
      applyDelta(it, delta, keep ? null : r);
      return `${it.name}: ${delta < 0 ? '−1' : '+1'} → ${Math.max(0, L.totalQty(it) + delta)} on hand`;
    },
  });
}

async function applyDelta(it, delta, showAfter) {
  try {
    const res = await St.changeQty(S.pid, S.me, it.id, delta);
    if (res.changed) St.log(S.pid, S.me, `${res.changed > 0 ? '+' : '−'} ${Math.abs(res.changed)} ${res.name}`);
    if (showAfter) openFound(showAfter, [S.items.find((x) => x.id === it.id) || it], `${delta < 0 ? 'Used 1' : 'Added 1'}: ${res.total} on hand now.`);
    return res;
  } catch (e) {
    toast(`Couldn't change ${it.name}: ${errText(e)}`);
    return null;
  }
}

// After "Keep scanning", codes that weren't in the pantry are offered once the scanner closes.
function watchPending() {
  if (pendingTimer) return;
  pendingTimer = setInterval(() => {
    if (window.GTScan && GTScan.isOpen) return;
    clearInterval(pendingTimer); pendingTimer = 0;
    if (pending.length) openPending();
  }, 400);
}

function openPending() {
  const codes = pending.slice();
  const box = openSheet('Not in the pantry yet', `${codes.length} scanned`, [
    el('p', { class: 'mutedt small' }, 'These codes aren\'t on anything in the pantry. Add each one (it\'s looked up for you), or skip it.'),
    el('div', { class: 'pt-pick' }, ...codes.map((code) => el('button', {
      type: 'button', onclick: () => { pending = pending.filter((c) => c !== code); openNewCode({ text: code, via: 'bluetooth' }); },
    }, el('b', { class: 'mono' }, code), ' · Add…'))),
    el('div', { class: 'pt-btns' }, btn('Skip these', () => { pending = []; closeSheet(); })),
  ]);
  return box;
}

function lotsBox(it) {
  const lots = L.sortLots(it.lots);
  if (!lots.length) return null;
  const today = L.todayKey();
  return el('div', { class: 'pt-lots' }, ...lots.map((l, i) => {
    const st = L.expiryStatus(l.expires, today);
    return el('div', {},
      el('span', {}, `${l.qty} · ${l.expires ? 'exp ' + L.fmtShort(l.expires, today) : 'no date'}`),
      el('span', { class: st === 'expired' ? 'st-expired' : st === 'soon' ? 'st-soon' : '' },
        i === 0 && lots.length > 1 ? 'used first' : st === 'expired' ? 'expired' : ''));
  }));
}

function openFound(r, hits, message = '') {
  const it = hits[0];
  const count = el('b', {}, String(L.totalQty(it)));
  const msg = el('p', { class: 'pt-msg', role: 'status' }, message);
  const lotsSlot = el('div', {}, lotsBox(it));
  const refresh = (res) => {
    const fresh = S.items.find((x) => x.id === it.id) || it;
    count.textContent = String(res ? res.total : L.totalQty(fresh));
  };
  const act = (delta) => async (e) => {
    e.currentTarget.disabled = true;
    const target = e.currentTarget;
    const res = await applyDelta(it, delta);
    target.disabled = false;
    if (res) {
      refresh(res);
      msg.textContent = res.changed ? `${delta < 0 ? 'Used 1' : 'Added 1'}: ${res.total} on hand now.` : 'None left to use.';
      it.lots = delta < 0 ? L.useFromLots(it.lots, 1).lots : L.addToLots(it.lots, 1);
      lotsSlot.replaceChildren(lotsBox(it) || '');
    }
  };
  const actions = canEdit()
    ? el('div', { class: 'pt-two' }, btn('− Used 1', act(-1), 'amber big'), btn('+ Got 1', act(1), 'primary big'))
    : el('p', { class: 'mutedt small' }, 'Viewers can look but not change counts.');
  openSheet(hits.length > 1 ? `Found ${hits.length} items` : 'Found', `Scanned ${r.text}${r.via ? ' · ' + (VIA[r.via] || r.via) : ''}`, [
    el('div', { class: 'pt-count' },
      el('div', {}, el('h3', { style: 'margin:0;font-size:20px' }, it.name), el('p', { class: 'mutedt small', style: 'margin:0' },
        [it.brand, it.size, it.location].filter(Boolean).join(' · '))),
      el('div', { style: 'text-align:right' }, count, el('div', { class: 'mutedt small' }, 'on hand'))),
    lotsSlot,
    actions,
    msg,
    hits.length > 1 ? el('p', { class: 'mutedt small' }, `Also on: ${hits.slice(1).map((h) => h.name).join(', ')}`) : null,
    el('div', { class: 'pt-btns' },
      btn('Open item', () => openItem(S.items.find((x) => x.id === it.id) || it)),
      window.GTScan ? btn('Scan another', () => { closeSheet(); startScan('look'); }) : null,
      btn('Done', closeSheet, 'ghost')),
  ], { focus: '.pt-b' });
}

function openNewCode(r) {
  const code = L.cleanCode(r.text);
  const retail = L.isRetail(code);
  const batch = L.batchFromCode(code);
  const status = el('p', { class: 'mutedt small' }, retail ? 'Looking it up in Open Food Facts…' : '');
  const found = el('div', {});
  let product = null;
  const addBtn = btn('+ Add to the pantry', () => openItem(null, {
    name: product ? product.name : '', brand: product ? product.brand : '', size: product ? product.size : '',
    photo: product ? product.photo : '', barcodes: [code],
  }), 'primary');
  const body = [
    batch ? el('p', { class: 'small' }, `This looks like a homemade batch label (batch ${batch}), but no item in this pantry has it. It may be from a batch that was deleted or from another pantry.`) : null,
    status, found,
    canEdit() ? el('div', { class: 'pt-btns' }, addBtn, btn('Link to an item I have', () => openLink(code))) : el('p', { class: 'mutedt small' }, 'Viewers can\'t add items.'),
    el('div', { class: 'pt-btns' }, window.GTScan ? btn('Scan again', () => { closeSheet(); startScan('look'); }, 'ghost') : null, btn('Done', closeSheet, 'ghost')),
  ];
  openSheet('Not in the pantry', `Scanned ${code}${r.via ? ' · ' + (VIA[r.via] || r.via) : ''}`, body, { focus: '.pt-b' });
  if (retail) {
    lookupProduct(code).then((p) => {
      product = p;
      if (!status.isConnected) return;
      if (!p) { status.textContent = 'Not found online. Add it and type the name in once; next time it\'s found right away.'; return; }
      status.textContent = '';
      found.replaceChildren(el('div', { class: 'pt-found' },
        p.photo ? el('img', { class: 'pt-photo', src: p.photo, alt: '', referrerpolicy: 'no-referrer' }) : null,
        el('div', {}, el('small', {}, '✓ Found online'), el('div', { style: 'font-weight:700' }, p.name),
          el('div', { class: 'mutedt small' }, [p.brand, p.size].filter(Boolean).join(' · ')))));
    });
  }
}

function openLink(code) {
  const q = input({ type: 'search', placeholder: 'Find the item', 'aria-label': 'Find the item', autocomplete: 'off' });
  const list = el('div', { class: 'pt-pick' });
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const items = S.items.filter((i) => !s || [i.name, i.brand, i.size].join(' ').toLowerCase().includes(s))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    list.replaceChildren(...(items.length ? items.map((it) => el('button', {
      type: 'button',
      onclick: async () => {
        try {
          await St.addBarcode(S.pid, S.me, it.id, code);
          toast(`Linked: scanning ${code} now finds ${it.name}.`);
          openFound({ text: code }, [{ ...it, barcodes: [...(it.barcodes || []), code] }]);
        } catch (e) { toast(`Couldn't link it: ${errText(e)}`); }
      },
    }, el('b', {}, it.name), el('span', { class: 'mutedt small' }, ` · ${[it.size, it.location].filter(Boolean).join(' · ')}`))) : [el('p', { class: 'mutedt' }, 'No items match.')]));
  };
  q.addEventListener('input', draw);
  draw();
  openSheet('Link this barcode', `Code ${code}`, [
    el('p', { class: 'small mutedt' }, 'Pick the item this barcode is on. Next time it\'s scanned, that item comes up.'),
    q, list,
    el('div', { class: 'pt-btns' }, btn('Back', () => openNewCode({ text: code }), 'ghost')),
  ]);
}

// ---------- an item: view and edit --------------------------------------------------

function openItem(item, prefill = {}) {
  const isNew = !item;
  const d = isNew
    ? { name: '', brand: '', size: '', location: S.filter && L.LOCATIONS.includes(S.filter) ? S.filter : 'Pantry', keepAtLeast: null,
      barcodes: [], lots: [{ qty: 1, expires: '' }], photo: '', notes: '', homemade: null, ...prefill }
    : JSON.parse(JSON.stringify({ ...item, createdAt: undefined, updatedAt: undefined }));
  if (!isNew) d.id = item.id;
  const ro = !canEdit();
  const msg = el('p', { class: 'pt-msg', role: 'status' });

  const name = input({ value: d.name, maxlength: '120', required: true, disabled: ro });
  const brand = input({ value: d.brand || '', maxlength: '60', disabled: ro });
  const size = sizeField(d.size || '', { disabled: ro });
  const locs = locationsInUse();
  if (d.location && !locs.includes(d.location)) locs.push(d.location);
  const where = select([...locs, ['__other', 'Somewhere else…']], d.location || 'Pantry');
  where.disabled = ro;
  const whereOther = input({ placeholder: 'e.g. Basement shelf', maxlength: '40', hidden: true });
  where.addEventListener('change', () => { whereOther.hidden = where.value !== '__other'; if (!whereOther.hidden) whereOther.focus(); });
  const keep = input({ type: 'number', min: '0', max: '999', inputmode: 'numeric', value: d.keepAtLeast ?? '', placeholder: 'none', disabled: ro });
  const notes = el('textarea', { class: 'field', rows: '2', maxlength: '500', disabled: ro });
  notes.value = d.notes || '';

  // count + lots
  const lotRows = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const drawLots = () => {
    lotRows.replaceChildren(...d.lots.map((l, i) => {
      const q = input({ type: 'number', min: '0', max: '9999', inputmode: 'numeric', value: l.qty, 'aria-label': 'How many', disabled: ro });
      const x = input({ type: 'date', value: l.expires || '', 'aria-label': 'Expires', disabled: ro });
      q.addEventListener('input', () => { l.qty = Math.max(0, parseInt(q.value, 10) || 0); });
      x.addEventListener('change', () => { l.expires = x.value; });
      return el('div', { class: 'pt-lot' }, q, x,
        ro ? el('span') : el('button', { type: 'button', class: 'pt-x', 'aria-label': 'Remove this line', onclick: () => { d.lots.splice(i, 1); drawLots(); } }, '✕'));
    }));
  };
  drawLots();

  // barcodes
  const codes = el('div', { class: 'pt-codes' });
  const drawCodes = () => codes.replaceChildren(...(d.barcodes.length ? d.barcodes.map((c, i) => el('span', { class: 'pt-code' }, c,
    ro ? null : el('button', { type: 'button', class: 'pt-x', 'aria-label': `Remove barcode ${c}`, onclick: () => { d.barcodes.splice(i, 1); drawCodes(); } }, '✕')))
    : [el('span', { class: 'mutedt small' }, 'No barcode yet.')]));
  drawCodes();
  const addCode = (c) => {
    c = L.cleanCode(c);
    if (!c) return;
    if (!d.barcodes.some((b) => L.codeKey(b) === L.codeKey(c))) d.barcodes.push(c);
    drawCodes();
    const other = L.findByCode(S.items, c).find((x) => x.id !== d.id);
    msg.textContent = other ? `Heads up: ${c} is also on ${other.name}.` : '';
  };
  const typed = input({ placeholder: 'Type a code', 'aria-label': 'Type a barcode', autocomplete: 'off', spellcheck: 'false' });
  typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCode(typed.value); typed.value = ''; } });

  const quick = (delta) => async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    const res = await applyDelta(item, delta);
    b.disabled = false;
    if (res && res.changed) {
      d.lots = delta < 0 ? L.useFromLots(d.lots, 1).lots : L.addToLots(d.lots, 1);
      drawLots();
      countB.textContent = String(res.total);
      msg.textContent = `${delta < 0 ? 'Used 1' : 'Added 1'}: ${res.total} on hand now.`;
    }
  };
  const countB = el('b', {}, String(L.totalQty(d)));

  const hm = d.homemade;
  const recipe = hm ? recipeFields(hm, ro) : null;
  const curHm = () => (hm ? { ...hm, ...recipe.get() } : hm);
  const body = [
    d.photo ? el('img', { class: 'pt-photo', src: d.photo, alt: '', referrerpolicy: 'no-referrer' }) : null,
    !isNew ? el('div', { class: 'pt-count' }, el('span', { class: 'mutedt' }, 'On hand'), countB) : null,
    !isNew && !ro ? el('div', { class: 'pt-two' }, btn('− Used 1', quick(-1), 'amber'), btn('+ Got 1', quick(1), 'primary')) : null,
    !isNew && !ro && L.totalQty(d) > 0 ? btn(`Move to another place…`, () => openMove(item), 'pt-move') : null,
    hm ? el('div', { class: 'pt-lots' },
      el('div', {}, el('b', {}, `Homemade · batch ${hm.batch}`), el('span', { class: 'mono' }, L.spacedCode(L.batchCode(hm.batch)))),
      el('div', {}, el('span', {}, hm.method || ''), el('span', {}, [hm.made && 'made ' + L.fmtMDY(hm.made), hm.useBy && 'use by ' + L.fmtMY(hm.useBy)].filter(Boolean).join(' · '))),
      hm.recipeUrl ? el('div', {}, el('a', { href: hm.recipeUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open the recipe ↗')) : null,
      el('div', {}, btn('Print labels', () => openLabels({ ...item, ...d, notes: notes.value.trim(), homemade: curHm() }), 'primary'))) : null,
    field('Name', name),
    field('Brand', brand),
    size.node,
    el('div', { class: 'pt-two' }, field('Where', el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, where, whereOther)), field('Keep at least', keep)),
    el('div', { class: 'f' }, el('span', { class: 'field-label' }, 'How many, by expiration date'), lotRows,
      ro ? null : btn('+ Another date', () => { d.lots.push({ qty: 1, expires: '' }); drawLots(); }, 'ghost')),
    el('div', { class: 'f' }, el('span', { class: 'field-label' }, 'Barcodes'), codes,
      ro ? null : el('div', { class: 'pt-addrow' }, typed,
        window.GTScan ? btn('Scan', () => GTScan.open({ title: 'Scan this item\'s barcode', onCode: (r) => addCode(r.text) })) : null)),
    field(hm ? 'Notes (on the medium and large labels)' : 'Notes', notes),
    ...(recipe ? (ro ? [hm.directions ? el('div', { class: 'f' }, el('span', { class: 'field-label' }, 'Directions'), el('p', { class: 'pt-dirs' }, hm.directions)) : null] : recipe.nodes) : []),
    msg,
    ro ? el('div', { class: 'pt-btns' }, btn('Close', closeSheet)) : el('div', { class: 'pt-btns' },
      btn(isNew ? 'Add to the pantry' : 'Save', save, 'primary'),
      btn('Cancel', closeSheet, 'ghost'),
      !isNew ? btn('Delete', del, 'danger') : null),
  ];

  async function save(e) {
    const b = e.currentTarget;
    d.name = name.value.trim();
    if (!d.name) { msg.textContent = 'Give it a name.'; msg.classList.add('bad'); name.focus(); return; }
    d.brand = brand.value.trim(); d.size = size.get(); d.notes = notes.value.trim();
    if (hm && !ro) {
      const r = recipe.get();
      d.homemade = { ...hm };
      delete d.homemade.recipeUrl; delete d.homemade.directions;
      if (r.recipeUrl) d.homemade.recipeUrl = r.recipeUrl;
      if (r.directions) d.homemade.directions = r.directions;
    }
    d.location = where.value === '__other' ? (whereOther.value.trim() || 'Pantry') : where.value;
    const k = parseInt(keep.value, 10);
    d.keepAtLeast = Number.isFinite(k) && k > 0 ? Math.min(k, 999) : null;
    d.lots = L.sortLots(d.lots);
    if (typed.value.trim()) { addCode(typed.value); typed.value = ''; }
    b.disabled = true;
    try {
      await St.saveItem(S.pid, S.me, d);
      St.log(S.pid, S.me, isNew ? `added ${d.name} (${L.totalQty(d)})` : `edited ${d.name}`);
      closeSheet();
      toast(isNew ? `Added ${d.name}.` : `Saved ${d.name}.`);
    } catch (err) {
      b.disabled = false;
      msg.textContent = `Couldn't save: ${errText(err)}`; msg.classList.add('bad');
    }
  }
  let confirmDel = false;
  async function del(e) {
    if (!confirmDel) { confirmDel = true; e.currentTarget.textContent = 'Tap again to delete'; return; }
    try {
      await St.deleteItem(S.pid, d.id);
      St.log(S.pid, S.me, `deleted ${d.name}`);
      closeSheet();
      toast(`Deleted ${d.name}.`);
    } catch (err) { msg.textContent = `Couldn't delete: ${errText(err)}`; msg.classList.add('bad'); }
  }

  openSheet(isNew ? 'Add an item' : d.name, isNew ? (d.barcodes[0] ? `Code ${d.barcodes[0]}` : 'Pantry') : d.location || '', body,
    { focus: isNew ? 'input' : '.pt-b' });
}

// ---------- moving things ---------------------------------------------------------------
// "Move…" on an item: how many (the soonest-expiring go first, keeping their dates) and
// where to. If the same thing is already kept there, they join up (logic.js planMove).

function placeChips(places, value, onPick) {
  const wrap = el('div', { class: 'pt-placechips', role: 'group', 'aria-label': 'Where' });
  const draw = () => wrap.replaceChildren(...places.map((p) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(p === value),
    onclick: () => { value = p; draw(); onPick(p); },
  }, p)));
  draw();
  return wrap;
}

function stepper(value, max, onChange, label) {
  const box = input({ type: 'number', min: '1', max: String(max), inputmode: 'numeric', value, 'aria-label': label, style: 'width:80px;text-align:center' });
  const set = (v) => { const n = Math.min(max, Math.max(1, Math.floor(Number(v) || 1))); box.value = String(n); onChange(n); };
  box.addEventListener('change', () => set(box.value));
  return el('div', { class: 'pt-stepper' },
    el('button', { type: 'button', class: 'pt-b', 'aria-label': 'One less', onclick: () => set(Number(box.value) - 1) }, '−'), box,
    el('button', { type: 'button', class: 'pt-b', 'aria-label': 'One more', onclick: () => set(Number(box.value) + 1) }, '+'));
}

function openMove(item) {
  const it = S.items.find((x) => x.id === item.id) || item;
  const total = L.totalQty(it);
  const places = locationsInUse().filter((p) => p !== it.location);
  let qty = total, to = places[0] || '';
  const other = input({ placeholder: 'Somewhere else, e.g. Garage shelf', maxlength: '40', 'aria-label': 'Somewhere else' });
  const plan = el('p', { class: 'pt-msg', role: 'status' });
  const draw = () => {
    const dest = other.value.trim() || to;
    if (!dest) { plan.textContent = 'Pick where it’s going.'; return; }
    const p = L.planMove(S.items, it, qty, dest);
    const moved = L.takeLots(it.lots, qty).taken;
    const dates = moved.filter((l) => l.expires).map((l) => `${l.qty} exp ${L.fmtShort(l.expires)}`).join(', ');
    plan.textContent = `${qty} of ${total} move${qty === 1 ? 's' : ''} to ${dest}`
      + (p.into ? `, joining the ${p.into} already there.` : p.create.length ? ' as a new entry there.' : '.')
      + (dates ? ` (${dates}.)` : '');
  };
  other.addEventListener('input', draw);
  const go = btn('Move', async (e) => {
    const dest = other.value.trim() || to;
    if (!dest) { plan.textContent = 'Pick where it’s going.'; return; }
    e.currentTarget.disabled = true;
    try {
      await St.applyMove(S.pid, S.me, L.planMove(S.items, it, qty, dest));
      St.log(S.pid, S.me, `moved ${qty} ${it.name}: ${it.location} → ${dest}`);
      closeSheet();
      toast(`Moved ${qty} ${it.name} to ${dest}.`);
    } catch (err) { e.currentTarget.disabled = false; plan.textContent = `Couldn't move it: ${errText(err)}`; }
  }, 'primary');
  openSheet(`Move ${it.name}`, `${total} in ${it.location || 'no place'}`, [
    el('div', { class: 'f' }, el('span', { class: 'field-label' }, 'How many'),
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        stepper(qty, total, (n) => { qty = n; draw(); }, 'How many to move'),
        total > 1 ? el('span', { class: 'mutedt small' }, `of ${total}. The soonest-expiring go first.`) : null)),
    el('div', { class: 'f' }, el('span', { class: 'field-label' }, 'To'),
      placeChips(places, to, (p) => { to = p; other.value = ''; draw(); }), other),
    plan,
    el('div', { class: 'pt-btns' }, go, btn('Cancel', () => openItem(it), 'ghost')),
  ], { focus: '.chip[aria-pressed="true"]' });
  draw();
}

// ---------- bulk scan in ------------------------------------------------------------------
// Pick a place (Pantry, Fridge, Basement…), scan everything going there one after another
// (the scanner stays open), then check the list and save it all at once (logic.js planBulk).
// Codes the pantry doesn't know are looked up in Open Food Facts and become new items.

let bulk = null; // { location, rows: [{ key, code, itemId, n, expires, name, brand, size, photo, looking }] }

function openBulkStart() {
  if (!canEdit()) { toast('Viewers can\'t change counts.'); return; }
  if (bulk && bulk.rows.length) { openBulkReview(); return; }
  let place = L.LOCATIONS.includes(S.filter) ? S.filter : (store.get('ptBulkPlace', 'Pantry'));
  const places = locationsInUse();
  if (!places.includes(place)) place = 'Pantry';
  openSheet('Bulk scan in', 'Scan a load of groceries or supplies in one go', [
    el('p', { class: 'small' }, 'Pick where it’s all going, then scan each thing (the scanner stays open). You’ll check the list before anything is saved.'),
    el('div', { class: 'f' }, el('span', { class: 'field-label' }, 'Going into'), placeChips(places, place, (p) => { place = p; })),
    el('div', { class: 'pt-btns' },
      btn('Start scanning', () => { store.set('ptBulkPlace', place); bulk = { location: place, rows: [] }; closeSheet(); startBulk(); }, 'primary'),
      btn('Cancel', closeSheet, 'ghost')),
  ], { focus: '.pt-b.primary' });
}

function lookUpRow(row) {
  if (!L.isRetail(row.code) || row.looking) return;
  row.looking = true;
  lookupProduct(row.code).then((p) => {
    row.looking = false;
    row.looked = true;
    if (p && !row.name) Object.assign(row, { name: p.name || '', brand: p.brand || '', size: p.size || '', photo: p.photo || '' });
    // On the review list already: fill in just that name box (if it's still empty), so nobody's typing is interrupted.
    const box = bulkSheetOpen && document.querySelector(`[data-bulkkey="${CSS.escape(row.key)}"]`);
    if (box) { if (!box.value && row.name) box.value = row.name; box.placeholder = 'What is it?'; }
  });
}

function startBulk() {
  if (!window.GTScan || !bulk) return;
  GTScan.open({
    title: `Bulk scan into ${bulk.location}`,
    allowKeep: true,
    keep: true,
    onCode: (r) => {
      const hits = L.findByCode(S.items, r.text);
      const hit = hits.find((h) => h.location === bulk.location) || hits[0];
      const key = hit ? `i:${hit.id}` : `c:${L.codeKey(r.text)}`;
      let row = bulk.rows.find((x) => x.key === key);
      if (!row) {
        row = { key, code: L.cleanCode(r.text), itemId: hit ? hit.id : '', n: 0, expires: '', name: '', brand: '', size: '', photo: '' };
        bulk.rows.push(row);
        if (!hit) lookUpRow(row);
      }
      row.n += 1;
      return hit ? `${hit.name}: ${row.n} so far` : `New: ${row.code} (${row.n}). You’ll name it next.`;
    },
    // a scan with "Keep scanning" unticked arrives just after the screen closes
    onClose: () => setTimeout(openBulkReview, 0),
  });
}

let bulkSheetOpen = false;
function openBulkReview() {
  if (!bulk) return;
  bulk.rows = bulk.rows.filter((r) => r.n > 0);
  if (!bulk.rows.length) { bulk = null; return; }
  const total = bulk.rows.reduce((t, r) => t + r.n, 0);
  const msg = el('p', { class: 'pt-msg', role: 'status' });
  const where = select(locationsInUse(), bulk.location);
  where.setAttribute('aria-label', 'Going into');
  where.addEventListener('change', () => { bulk.location = where.value; openBulkReview(); });
  const lines = bulk.rows.map((r, i) => {
    const it = r.itemId && S.items.find((x) => x.id === r.itemId);
    const n = input({ type: 'number', min: '0', max: '999', inputmode: 'numeric', value: r.n, 'aria-label': 'How many', style: 'width:70px;text-align:center' });
    n.addEventListener('change', () => { r.n = Math.max(0, Math.min(999, Math.floor(Number(n.value) || 0))); });
    const date = input({ type: 'date', value: r.expires, 'aria-label': 'Expires (optional)' });
    date.addEventListener('change', () => { r.expires = date.value; });
    const x = el('button', { type: 'button', class: 'pt-x', 'aria-label': 'Remove this line', onclick: () => { bulk.rows.splice(i, 1); openBulkReview(); } }, '✕');
    let head;
    if (it) {
      const here = it.location === bulk.location ? it : S.items.find((y) => y.location === bulk.location && L.sameThing(y, it));
      head = el('div', {}, el('b', {}, it.name),
        el('div', { class: 'mutedt small' }, here ? `${L.totalQty(here)} in ${bulk.location} now` : `Kept in ${it.location}; starts a new entry in ${bulk.location}`));
    } else {
      const name = input({ value: r.name, placeholder: r.looking ? 'Looking it up…' : 'What is it?', maxlength: '120', 'aria-label': `Name for ${r.code}`, 'data-bulkname': String(i), 'data-bulkkey': r.key });
      name.addEventListener('input', () => { r.name = name.value; });
      head = el('div', {}, name, el('div', { class: 'mutedt small mono' }, `New · ${r.code}${r.brand || r.size ? ' · ' + [r.brand, r.size].filter(Boolean).join(' · ') : ''}`));
    }
    return el('div', { class: 'pt-bulkrow' + (it ? '' : ' new') }, head, el('div', { class: 'pt-bulkctl' }, n, date, x));
  });
  let sure = false;
  const save = btn(`Save all (${total})`, async (e) => {
    const missing = bulk.rows.findIndex((r) => !r.itemId && r.n > 0 && !r.name.trim());
    if (missing >= 0) {
      msg.textContent = 'Give each new thing a name (or remove that line).';
      const f = document.querySelector(`[data-bulkname="${missing}"]`); if (f) f.focus();
      return;
    }
    e.currentTarget.disabled = true;
    msg.textContent = 'Saving…';
    try {
      const into = bulk.location;
      const n = await St.applyBulk(S.pid, S.me, L.planBulk(S.items, bulk.rows, into));
      St.log(S.pid, S.me, `bulk scanned ${n} into ${into}`);
      bulk = null;
      bulkSheetOpen = false;
      closeSheet();
      toast(`Added ${n} to the ${into}.`);
    } catch (err) {
      e.currentTarget.disabled = false;
      msg.textContent = `Couldn't save it all: ${errText(err)}. Try Save all again.`;
    }
  }, 'primary');
  bulkSheetOpen = true;
  openSheet('Check the list', `${total} scanned · nothing is saved until Save all`, [
    el('div', { class: 'f' }, el('span', { class: 'field-label' }, 'Going into'), where),
    el('div', { class: 'pt-bulk' }, ...lines),
    el('p', { class: 'mutedt small' }, 'Dates are optional: things with the same date are counted together.'),
    msg,
    el('div', { class: 'pt-btns' }, save,
      btn('Scan more', () => { bulkSheetOpen = false; closeSheet(); startBulk(); }),
      btn('Discard', (e) => {
        if (!sure) { sure = true; e.currentTarget.textContent = 'Tap again to discard'; return; }
        bulk = null; bulkSheetOpen = false; closeSheet(); toast('Bulk scan discarded.');
      }, 'ghost')),
  ], { focus: '.pt-b.primary', onClose: () => { bulkSheetOpen = false; } });
}

// ---------- homemade batches and labels -----------------------------------------------

/* Recipe link and typed directions for homemade batches (kept in item.homemade). */
const DIR_MAX = 4000;
function cleanUrl(v) {
  let u = String(v || '').trim();
  if (!u) return '';
  if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 500) : ''; } catch { return ''; }
}
function recipeFields(init = {}, ro = false) {
  const url = input({ type: 'url', inputmode: 'url', maxlength: '500', placeholder: 'Website or video, e.g. ballmasonjars.com/…', value: init.recipeUrl || '', disabled: ro });
  const dirs = el('textarea', { class: 'field', rows: '6', maxlength: String(DIR_MAX), disabled: ro,
    placeholder: '1. Wash and hull the berries.\n2. Crush, add pectin, boil hard 1 minute.\n3. Fill jars, 1/4 in headspace. Water bath 10 min.' });
  dirs.value = init.directions || '';
  return {
    url, dirs,
    nodes: [field('Recipe link (optional)', url), field('Directions (optional; on the large label, or print them on their own)', dirs)],
    get: () => ({ recipeUrl: cleanUrl(url.value), directions: dirs.value.replace(/\s+$/, '').slice(0, DIR_MAX) }),
  };
}

function openBatch() {
  const today = L.todayKey();
  const methods = L.METHODS.map((m) => m.name);
  const lastMethod = store.get('ptMethod', 'Water bath');
  const name = input({ maxlength: '120', placeholder: 'Strawberry jam' });
  const method = select(methods, methods.includes(lastMethod) ? lastMethod : 'Water bath');
  const qty = input({ type: 'number', min: '1', max: '999', inputmode: 'numeric', value: 12 });
  const size = sizeField('');
  const made = input({ type: 'date', value: today });
  const useBy = input({ type: 'date', value: L.useByFor(method.value, today, S.pantry.useBy) });
  let useByTouched = false;
  useBy.addEventListener('change', () => { useByTouched = true; });
  const suggest = () => { if (!useByTouched) useBy.value = L.useByFor(method.value, made.value || today, S.pantry.useBy); };
  method.addEventListener('change', suggest);
  made.addEventListener('change', suggest);
  const where = select(locationsInUse(), method.value === 'Frozen' ? 'Freezer' : 'Pantry');
  method.addEventListener('change', () => { if (method.value === 'Frozen') where.value = 'Freezer'; else if (method.value === 'Fermented') where.value = 'Fridge'; });
  const notes = el('textarea', { class: 'field', rows: '2', maxlength: '500', placeholder: 'Low sugar. Refrigerate after opening.' });
  const recipe = recipeFields();
  // Making the same thing again: bring over the recipe link and directions from the last batch of it.
  const filledFrom = el('p', { class: 'mutedt small', style: 'margin:-6px 0 0', hidden: true });
  name.addEventListener('change', () => {
    const n = name.value.trim().toLowerCase();
    if (!n || recipe.url.value.trim() || recipe.dirs.value.trim()) return;
    const prev = S.items.filter((i) => i.homemade && (i.name || '').trim().toLowerCase() === n && (i.homemade.recipeUrl || i.homemade.directions))
      .sort((a, b) => (b.homemade.batch || 0) - (a.homemade.batch || 0))[0];
    if (!prev) return;
    recipe.url.value = prev.homemade.recipeUrl || '';
    recipe.dirs.value = prev.homemade.directions || '';
    filledFrom.textContent = `Recipe and directions filled in from batch ${prev.homemade.batch}. Change them if this batch is different.`;
    filledFrom.hidden = false;
  });
  const msg = el('p', { class: 'pt-msg', role: 'status' });
  const next = (S.pantry.nextBatch || 0) + 1;

  const go = async (e) => {
    const b = e.currentTarget;
    const data = {
      name: name.value.trim(), method: method.value, qty: Math.max(1, Math.min(999, parseInt(qty.value, 10) || 1)),
      size: size.get(), made: made.value || today, useBy: useBy.value, location: where.value, notes: notes.value.trim(), ...recipe.get(),
    };
    if (!data.name) { msg.textContent = 'What is it?'; msg.classList.add('bad'); name.focus(); return; }
    b.disabled = true;
    try {
      store.set('ptMethod', data.method);
      const r = await St.addBatch(S.pid, S.me, data);
      St.log(S.pid, S.me, `made batch ${r.batch}: ${data.name} (${data.qty})`);
      openLabels({
        id: r.id, name: data.name, size: data.size, notes: data.notes, lots: [{ qty: data.qty, expires: data.useBy }],
        homemade: { batch: r.batch, method: data.method, made: data.made, useBy: data.useBy, recipeUrl: data.recipeUrl, directions: data.directions },
      }, `Saved batch ${r.batch}. Now the labels:`);
    } catch (err) {
      b.disabled = false;
      msg.textContent = `Couldn't save: ${errText(err)}`; msg.classList.add('bad');
    }
  };

  openSheet('New homemade batch', `Batch ${next} · code ${L.spacedCode(L.batchCode(next))}`, [
    field('What is it', name),
    field('How it was put up', method),
    field('Jars / bags / packs', qty),
    el('div', {}, size.node, el('p', { class: 'mutedt small', style: 'margin:4px 0 0' }, 'What\'s in each one: a weight or volume (8 oz), or a count for bags of things (12 pieces).')),
    el('div', { class: 'pt-two' }, field('Made', made), field('Use by', useBy)),
    el('p', { class: 'mutedt small', style: 'margin:-6px 0 0' }, 'Use by is suggested from how it was put up; change it if you like. Defaults are under Household.'),
    field('Where', where),
    field('Notes (on the medium and large labels)', notes),
    ...recipe.nodes,
    filledFrom,
    msg,
    el('div', { class: 'pt-btns' }, btn('Save + make labels', go, 'primary'), btn('Cancel', closeSheet, 'ghost')),
  ]);
}

function labelData(it) {
  const hm = it.homemade || {};
  return {
    name: it.name, method: hm.method || '', size: it.size || '', made: hm.made || '', useBy: hm.useBy || '',
    notes: it.notes || '', directions: hm.directions || '', household: S.pantry ? S.pantry.name : '', code: L.batchCode(hm.batch), batch: hm.batch,
  };
}

async function openLabels(it, intro = '') {
  const data = labelData(it);
  const choices = { ...LABEL_SIZES, ...(data.directions ? { [DIRECTIONS.key]: DIRECTIONS } : {}) };
  let size = store.get('ptLabelSize', '40x30');
  if (!choices[size]) size = '40x30';
  const sizeName = () => (size === DIRECTIONS.key ? '50 × 80 mm' : LABEL_SIZES[size].name);
  const preview = el('div', { class: 'pt-preview' });
  const sizes = el('div', { class: 'pt-sizes', role: 'group', 'aria-label': 'Label size' });
  const msg = el('p', { class: 'pt-msg', role: 'status' });
  const copies = L.totalQty(it);
  const step2 = el('li', {});
  const step5 = el('li', {});
  let canvases = [];
  const shareBtn = canShareImages() ? btn('Share…', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await shareImage(await labelBlob(canvases[0]), labelFileName(data, size)); } catch (err) { msg.textContent = `Couldn't share it: ${errText(err)}`; }
    b.disabled = false;
  }) : null;
  const draw = () => {
    step2.textContent = `In Katasymbol, start a new label and set it to ${sizeName()} (the size of the roll that's loaded).`;
    step5.textContent = size === DIRECTIONS.key ? 'Print as many as you need (one for the shelf or recipe binder, or one per jar).' : `Print ${copies > 0 ? copies : 'one per jar'}${copies > 0 ? (copies === 1 ? ' copy' : ' copies') : ''}.`;
    canvases = size === DIRECTIONS.key ? renderDirections(data) : [renderLabel(data, size)];
    canvases.forEach((c, i) => {
      c.style.width = Math.min(c.width * 2, 480) + 'px';
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', size === DIRECTIONS.key
        ? `Directions label${canvases.length > 1 ? ` ${i + 1} of ${canvases.length}` : ''}: ${data.name}`
        : `Label preview, ${sizeName()}: ${data.name}, barcode ${L.spacedCode(data.code)}`);
    });
    preview.replaceChildren(canvases.length > 1
      ? el('div', { class: 'pt-pages' }, el('p', { class: 'mutedt small', style: 'margin:0' }, `The directions take ${canvases.length} labels. Save to phone saves all ${canvases.length}; print one of each.`), ...canvases)
      : canvases[0]);
    if (shareBtn) shareBtn.hidden = canvases.length > 1;
    sizes.replaceChildren(...Object.entries(choices).map(([k, s]) => el('button', {
      type: 'button', 'aria-pressed': String(k === size), onclick: () => { size = k; store.set('ptLabelSize', k); draw(); },
    }, el('b', {}, s.name), el('span', {}, s.hint))));
  };
  openSheet(`Labels: ${data.name}`, `Batch ${data.batch} · ${L.spacedCode(data.code)}`, [
    intro ? el('p', { class: 'pt-msg' }, intro) : null,
    sizes, preview,
    el('div', { class: 'pt-btns' },
      btn('Save to phone', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          const names = [];
          for (let i = 0; i < canvases.length; i++) {
            const name = labelFileName(data, size, i, canvases.length);
            saveToPhone(await labelBlob(canvases[i]), name);
            names.push(name);
            if (i < canvases.length - 1) await new Promise((r) => setTimeout(r, 600)); // one download at a time
          }
          msg.textContent = names.length > 1
            ? `Saved ${names.length} images to Downloads (${names.join(', ')}). If the phone asks, allow more than one download. Add each to a ${sizeName()} label in Katasymbol (steps below).`
            : `Saved ${names[0]} to Downloads. Now add it to a ${sizeName()} label in Katasymbol (steps below).`;
        } catch (err) { msg.textContent = `Couldn't save the image: ${errText(err)}`; }
        b.disabled = false;
      }, 'primary'),
      shareBtn,
      btn('Done', closeSheet, 'ghost')),
    msg,
    el('ol', { class: 'pt-steps' },
      el('li', {}, 'Tap Save to phone. The image goes to Downloads (in the Gallery too, under Download).'),
      step2,
      el('li', {}, 'Add a picture to the label (its Image tool) and pick the saved label from Downloads.'),
      el('li', {}, 'Stretch it to fill the whole label; turn off any photo or dither effect.'),
      step5),
    el('p', { class: 'mutedt small', style: 'margin:0' }, 'Sharing the image straight to Katasymbol opens it as a full-page picture print instead of a label, so add it to a label as above. Tip: save the finished label as a template in Katasymbol, then just swap the image next time.'),
  ], { focus: '.pt-b' });
  draw();
  await fontsReady();
  if (preview.isConnected) draw();
}

// ---------- Shopping tab ------------------------------------------------------------

function renderShopping() {
  if (!S.pantry || !T.low) return;
  const low = L.lowItems(S.items);
  const cartKey = 'ptCart:' + S.pid;
  const cart = new Set(store.get(cartKey, []));
  // Restocked items drop off by themselves; forget their ticks.
  for (const id of [...cart]) if (!low.some((i) => i.id === id)) cart.delete(id);
  store.set(cartKey, [...cart]);

  T.low.replaceChildren(
    el('h2', { class: 'pt-h2 low' }, `Running low · automatic (${low.length})`),
    ...(low.length ? low.map((it) => {
      const box = el('input', { type: 'checkbox', checked: cart.has(it.id) });
      const row = el('label', { class: 'pt-check' + (cart.has(it.id) ? ' done' : '') }, box,
        el('span', { class: 'pt-row-main' }, el('span', { class: 'pt-row-name' }, it.name),
          el('span', { class: 'pt-row-sub' }, `have ${L.totalQty(it)} · keep ${it.keepAtLeast}${it.size ? ' · ' + it.size : ''}`)),
        el('span', { class: 'pt-buy' }, `buy ${L.shortBy(it)}`));
      box.addEventListener('change', () => {
        if (box.checked) cart.add(it.id); else cart.delete(it.id);
        store.set(cartKey, [...cart]);
        row.classList.toggle('done', box.checked);
      });
      return row;
    }) : [el('p', { class: 'pt-empty' }, 'Nothing is below its "keep at least" number. Set one on an item to have it show up here.')]),
  );

  const extra = [...S.shopping].sort((a, b) => (a.done - b.done) || ((a.at?.toMillis?.() || 0) - (b.at?.toMillis?.() || 0)));
  T.extra.replaceChildren(
    el('h2', { class: 'pt-h2' }, 'Added by hand'),
    ...(extra.length ? extra.map((x) => {
      const box = el('input', { type: 'checkbox', checked: !!x.done });
      box.addEventListener('change', () => St.setShoppingDone(S.pid, x.id, box.checked).catch((e) => toast(`Couldn't update: ${errText(e)}`)));
      return el('div', { class: 'pt-check' + (x.done ? ' done' : '') },
        el('label', { style: 'display:flex;align-items:center;gap:12px;flex:1;min-height:56px;cursor:pointer' }, box,
          el('span', { class: 'pt-row-main' }, el('span', { class: 'pt-row-name' }, x.name),
            el('span', { class: 'pt-row-sub' }, `added by ${x.who || 'someone'}${x.at ? ' · ' + timeAgo(x.at) : ''}`))),
        el('button', { type: 'button', class: 'pt-x', 'aria-label': `Remove ${x.name}`, onclick: () => St.deleteShopping(S.pid, x.id).catch((e) => toast(`Couldn't remove: ${errText(e)}`)) }, '✕'));
    }) : [el('p', { class: 'pt-empty' }, 'Nothing added by hand.')]),
  );

  T.shopBtns.replaceChildren(
    btn('Copy list', async () => {
      const notInCart = low.filter((i) => !cart.has(i.id));
      try { await navigator.clipboard.writeText(L.shoppingText(notInCart, S.shopping)); toast('Copied the list.'); } catch { toast('Couldn\'t copy on this device.'); }
    }),
    btn('Clear checked', async () => {
      store.set(cartKey, []);
      await Promise.all(S.shopping.filter((x) => x.done).map((x) => St.deleteShopping(S.pid, x.id))).catch((e) => toast(`Couldn't clear: ${errText(e)}`));
      renderShopping();
    }, 'ghost'),
  );
  T.shopNote.replaceChildren(canEdit() && window.GTScan ? el('div', { class: 'pt-note' },
    el('span', {}, 'Home from the store? Scan things as you put them away: each scan adds 1. Tick "Keep scanning" to do several in a row; anything new is offered after.'),
    btn('Scan groceries in', () => startScan('add'), 'primary')) : '');
}

// ---------- Household tab ------------------------------------------------------------

function renderHousehold() {
  const p = S.pantry;
  if (!p || !T.house) return;
  const me = S.me.uid;
  const owner = isOwner();
  const parts = [];

  parts.push(el('h2', { class: 'pt-h2' }, 'People'));
  for (const uid of p.memberIds || []) {
    const name = (p.memberNames || {})[uid] || 'Someone';
    const r = p.members[uid];
    let control;
    if (owner && uid !== me) {
      const s = select([['member', 'Member'], ['viewer', 'Viewer']], r);
      s.setAttribute('aria-label', `Role for ${name}`);
      s.addEventListener('change', () => St.setRole(p.id, uid, s.value)
        .then(() => St.log(p.id, S.me, `made ${name} a ${s.value}`)).catch((e) => toast(`Couldn't change it: ${errText(e)}`)));
      let sure = false;
      const rm = el('button', { type: 'button', class: 'pt-x', 'aria-label': `Remove ${name}` }, '✕');
      rm.addEventListener('click', async () => {
        if (!sure) { sure = true; rm.textContent = 'Remove?'; rm.style.fontSize = '13px'; return; }
        try { await St.removeMember(p.id, uid); St.log(p.id, S.me, `removed ${name}`); } catch (e) { toast(`Couldn't remove: ${errText(e)}`); }
      });
      control = el('span', { style: 'display:flex;align-items:center;gap:4px' }, s, rm);
    } else {
      control = el('span', { class: 'pt-role' }, r === 'owner' ? 'Owner' : r === 'viewer' ? 'Viewer' : 'Member');
    }
    parts.push(el('div', { class: 'pt-person' }, avatar(uid, name),
      el('span', { class: 'pt-row-main' }, el('span', { class: 'pt-row-name' }, name), el('span', { class: 'pt-row-sub' }, uid === me ? 'you' : '')),
      control));
  }
  parts.push(el('p', { class: 'mutedt small' }, 'Members scan, add and edit. Viewers can look and use the shopping list. Only the owner invites people and changes roles.'));

  if (owner) {
    parts.push(el('h2', { class: 'pt-h2' }, 'Invite someone'));
    const live = p.inviteCode && p.inviteExpires && p.inviteExpires.toMillis() > Date.now();
    if (live) {
      const link = `${location.origin}/apps/pantry?join=${p.inviteCode}`;
      parts.push(el('div', { class: 'pt-note' },
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' },
          el('span', { class: 'pt-invite' }, L.spacedInvite(p.inviteCode)),
          el('span', { class: 'mutedt small' }, `works until ${p.inviteExpires.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)),
        el('div', { class: 'pt-btns' },
          btn('Share link', async () => {
            const text = `Join our pantry "${p.name}" on Garage Terminal: ${link}`;
            if (navigator.share) { try { await navigator.share({ title: 'Pantry invite', text, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
            try { await navigator.clipboard.writeText(link); toast('Copied the invite link.'); } catch { toast(link); }
          }, 'primary'),
          btn('New code', newCode),
          btn('Stop this code', () => St.cancelInvite(p).then(() => toast('That code no longer works.')).catch((e) => toast(errText(e))), 'ghost')),
        el('span', { class: 'small' }, 'They open the link and sign in with Google (or type the code on the Pantry page), then join as a Member. The code works for 7 days and for as many people as you share it with.')));
    } else {
      parts.push(el('div', { class: 'pt-btns' }, btn('Make an invite code', newCode, 'primary')));
    }
  }

  if (owner) {
    parts.push(el('h2', { class: 'pt-h2' }, 'Settings'));
    const nm = input({ value: p.name, maxlength: '60', 'aria-label': 'Pantry name' });
    const months = {};
    const grid = el('div', { class: 'pt-grid2' }, ...L.METHODS.map((m) => {
      const v = p.useBy && Number.isInteger(p.useBy[m.name]) ? p.useBy[m.name] : m.months;
      months[m.name] = input({ type: 'number', min: '1', max: '120', inputmode: 'numeric', value: v });
      return el('label', {}, el('span', { class: 'field-label' }, `${m.name} (months)`), months[m.name]);
    }));
    const save = btn('Save settings', async (e) => {
      const b = e.currentTarget;
      const useBy = {};
      for (const m of L.METHODS) {
        const n = parseInt(months[m.name].value, 10);
        if (Number.isInteger(n) && n >= 1 && n <= 120) useBy[m.name] = n;
      }
      b.disabled = true;
      try { await St.updatePantry(p.id, { name: nm.value, useBy }); toast('Saved.'); } catch (err) { toast(`Couldn't save: ${errText(err)}`); }
      b.disabled = false;
    }, 'primary');
    parts.push(field('Pantry name', nm), el('span', { class: 'field-label' }, 'Homemade "use by" defaults'), grid, el('div', { class: 'pt-btns', style: 'margin-top:10px' }, save));
  }

  parts.push(el('h2', { class: 'pt-h2' }, 'More'));
  const more = [btn('Start or join another pantry', () => showStart())];
  if (!owner) {
    let sure = false;
    const leave = btn('Leave this pantry', async () => {
      if (!sure) { sure = true; leave.textContent = 'Tap again to leave'; return; }
      try {
        St.log(p.id, S.me, 'left the pantry');
        await St.leavePantry(p.id, me);
        S.pantries = S.pantries.filter((x) => x.id !== p.id);
        openFromList();
      } catch (e) { toast(`Couldn't leave: ${errText(e)}`); }
    }, 'danger');
    more.push(leave);
  }
  parts.push(el('div', { class: 'pt-btns' }, ...more));

  T.house.replaceChildren(...parts);
  renderActivity();
}

async function newCode() {
  try {
    const code = await St.makeInvite(S.pantry, S.me);
    toast(`New invite code: ${L.spacedInvite(code)}`);
  } catch (e) { toast(`Couldn't make a code: ${errText(e)}`); }
}

function renderActivity() {
  if (!T.act) return;
  T.act.replaceChildren(...(S.activity.length ? S.activity.map((a) => el('div', { class: 'pt-act' },
    el('b', {}, a.who || 'Someone'), el('span', {}, a.what), el('time', {}, a.at ? timeAgo(a.at) : 'just now')))
    : [el('p', { class: 'pt-empty' }, 'Nothing yet.')]));
}
