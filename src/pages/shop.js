// /shop: Garage Terminal as one shop app (beta).
//
//  Home      built here, live from the same records the Logbook and Job_Board use
//            (logbook/{uid}/records and logbook/{uid}/projects), with the Morning Brief's
//            rules for low parts and maintenance due (src/brief/brief.js)
//  Jobs      /apps/job-board?shop=1             (Job_Board in shop mode)
//  Machines  /apps/logbook?shop=1&view=machines (Logbook: engines, vehicles, Due)
//  Parts     /apps/logbook?shop=1&view=parts    (Logbook inventory)
//  Tools     Torque Chart, Fuel Mix, Tap Drill Chart open inside
//
// The framed pages are this site's own (firebase.json allows same-site framing only).
// Nothing is copied: a change in the shop app shows in the Logbook and Job_Board and back.
//
// Open to everyone signed in (beta). Set sysopOnly to true to limit it to the sysop again
// (others then see "coming soon"); also put data-sysop back on the home page card.
// Each member only ever sees their own records: firestore.rules allow logbook/{uid} to its owner only.
const sysopOnly = false;

import { onAuthStateChanged } from 'firebase/auth';
import { collection, deleteDoc, doc, getDoc, onSnapshot, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
// (the shop clock below also uses these)
import { auth, db } from '../lib/firebase.js';
import { finishRedirectSignIn, logOff, signInWithGoogle, watchSession } from '../lib/session.js';
import { buildBrief } from '../brief/brief.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const dayKey = (ms = Date.now()) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
// Shop mode = Job_Board's "Customer jobs" switch (same saved setting on this device, so both stay in step)
// Employees always work in shop mode (it's the owner's shop), so there's no switch for them.
const custOn = () => { if (shopOf) return true; try { return localStorage.getItem('jb-customers') !== 'off'; } catch { return true; } };
const setCustOn = (on) => { try { localStorage.setItem('jb-customers', on ? 'on' : 'off'); } catch { /* private window: this visit only */ } };

// ---------- tabs ------------------------------------------------------------------------

const TITLES = { home: 'Home', jobs: 'Job_Board', schedule: 'Schedule', timesheet: 'Timesheet', machines: 'Machines', parts: 'Parts', tools: 'Tools', settings: 'Settings' };
const FRAMES = {
  jobs: '/apps/job-board?shop=1',
  machines: '/apps/logbook?shop=1&view=machines',
  parts: '/apps/logbook?shop=1&view=parts',
};
let tab = 'home';
let lastTab = 'home';

function frameFor(name) {
  const box = $('p-' + name);
  let f = box.querySelector('iframe');
  if (!f) {
    f = document.createElement('iframe');
    f.className = 'sh-frame';
    f.title = TITLES[name];
    f.src = FRAMES[name];
    box.append(f);
  }
  return f;
}

function show(name, { again = false } = {}) {
  if (!TITLES[name] || access !== 'ok') name = 'home';
  if (again && name === tab) {
    // Tapping the tab you're on goes back to its start
    if (FRAMES[name]) frameFor(name).src = FRAMES[name];
    if (name === 'tools') renderTools();
    if (name === 'home') $('p-home').scrollTo({ top: 0 });
    return;
  }
  if (name !== 'settings') lastTab = name;
  tab = name;
  $('shGear').setAttribute('aria-pressed', String(name === 'settings'));
  $('shTitle').textContent = TITLES[name];
  for (const t of Object.keys(TITLES)) $('p-' + t).hidden = t !== name;
  for (const b of document.querySelectorAll('.sh-tabs [data-tab]')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (FRAMES[name]) frameFor(name);
  if (name === 'home') renderHome();
  if (name === 'tools' && !$('p-tools').childElementCount) renderTools();
  if (name === 'settings') renderSettings();
  if (name === 'schedule') renderSchedule();
  if (name === 'timesheet') renderTimesheet();
  try { history.replaceState(null, '', name === 'home' ? location.pathname : '#' + name); } catch { /* fine */ }
}

document.querySelector('.sh-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) show(b.dataset.tab, { again: true });
});

// ---------- data ------------------------------------------------------------------------

let user = null;
let access = 'loading'; // loading | guest | waiting (signed in, not allowed yet) | ok
let records = null;
let projects = null;
let loadErr = '';
let unsubs = [];
let dayLimit = 0; // Job_Board shop info: warn when a day has this many drop-offs (0 = no limit)
// Job_Board shop info: Pickup and delivery + Delivery fees (the same fields as tracker.html's Settings)
let del = { delivery: false, delivFees: false, delRate: '', delMin: '', delFree: '', delRound: true };
const delOn = () => del.delivery === true;
let delMsg = ''; // last save result, kept across redraws

// ---------- Employees (step 1 of 4: the switch and the team list) ----------
// Saved at logbook/{owner uid}/trackerSettings/team:
//   { on, members: [{ id, name, email, role, perms, status, addedAt }], roles: {tech, counter, manager: perms},
//   (perms = {prices, phones, inventory, settings, deleteJobs, approveTime}; each person gets their role's perms)
//     options: { assign, doneBy, ownTime, approveTime } }
// The owner is the account the shop's data lives under (whoever runs this shop app); never in members.
// Off (the default) = a one-person shop: nothing about employees shows anywhere.
// Step 2 (invites + sign-ins): while Employees is on, each person gets an invite at shopInvites/{email}
// (role + permissions) and shops/{owner} = {on, name}. The invited Google account opens /shop, sees
// "Join <shop>?", and joining makes shops/{owner}/members/{their uid}. From then on the shop app (and the
// Job_Board / Logbook inside it, via localStorage gt-shop-of) opens the owner's data; firestore.rules
// decide what each role may do. Removing someone, or switching Employees off, cuts access at once.
// Coming next: 3 Assigned to / Done by, 4 time per person + approval (approveTime: a Tech's time needs the Owner's or a Manager's OK before it goes on an invoice).
const ROLES = {
  tech: { label: 'Tech', perms: { prices: false, phones: false, inventory: false, settings: false, deleteJobs: false, approveTime: false }, does: 'Works jobs, clocks in and out, takes parts off the shelf' },
  counter: { label: 'Front counter', perms: { prices: true, phones: true, inventory: false, settings: false, deleteJobs: false, approveTime: false }, does: 'Books drop-offs and pickups, customers, invoices' },
  manager: { label: 'Manager', perms: { prices: true, phones: true, inventory: true, settings: true, deleteJobs: true, approveTime: true }, does: 'Runs the shop with you' },
};
const PERMS = [['prices', 'See prices, invoices and totals'], ['phones', "See customers' phone, email and address"], ['inventory', 'Add and edit inventory parts'], ['settings', 'Change shop info'], ['deleteJobs', 'Delete jobs'], ['approveTime', "Approve employees' time"]];
const roleDefaults = () => Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { ...r.perms }]));
const permsOf = (role) => ({ ...ROLES.tech.perms, ...((team.roles || {})[role] || (ROLES[role] || ROLES.tech).perms) });
const OPTS = [['hideMine', 'Hide My equipment from employees (they see customer jobs only)'], ['assign', 'Assign jobs to people'], ['doneBy', 'Mark who did each task (Done by)'], ['ownTime', 'Each person clocks their own time'], ['approveTime', "Time needs a manager's OK before it goes on an invoice"]];
let team = { on: false, members: [], roles: roleDefaults(), options: { assign: true, doneBy: true, ownTime: true, approveTime: true } };
let roleOpen = ''; // the role whose permissions are open in Settings
let teamEdit = null; // null, 'new' or a member id
let shopName = ''; // Job_Board shop info name
let joinedBy = {}; // owner: memberId -> joined uid (from shops/{me}/members)
let inviteErr = {}; // owner: memberId -> why their invite couldn't be saved
let shopOf = null; // signed in as a member of someone else's shop: {owner, ownerName, shopName, memberId, role, perms}
// An employee can step out to their own garage on this device (still signed in, still on
// the team) and come back: localStorage gt-shop-away = {uid, owner}.
let awayFrom = null; // { owner, shopName, role } while on your own garage
const isAway = (uid, owner) => { try { const v = JSON.parse(localStorage.getItem('gt-shop-away') || 'null'); return !!v && v.uid === uid && v.owner === owner; } catch { return false; } };
const setAway = (owner) => { try { if (owner) localStorage.setItem('gt-shop-away', JSON.stringify({ uid: user.uid, owner })); else localStorage.removeItem('gt-shop-away'); } catch { /* private window */ } };
let pendingInvite = null; // invited but not joined yet: the invite, plus its email
let memberUnsubs = [];
const lower = (e) => String(e || '').trim().toLowerCase();
const myShopName = () => shopName || ((user && user.displayName ? user.displayName.split(' ')[0] + "'s" : 'My') + ' shop');
const saveTeam = async () => {
  for (const m of team.members) m.perms = permsOf(m.role); // everyone follows their role
  await setDoc(doc(db, 'logbook', user.uid, 'trackerSettings', 'team'), JSON.parse(JSON.stringify(team)));
  await syncShop();
};
/* Owner: keep shops/{me} and everyone's invites in step with the team list */
let lastInvites = null;
async function syncShop() {
  if (!user || shopOf) return;
  const me = user.uid;
  // the team members can see: names and roles (for Assigned to / Done by), and the options
  const people = [{ id: 'owner', name: String(user.displayName || 'Owner').slice(0, 60), role: 'owner' }, ...team.members.map((m) => ({ id: m.id, name: String(m.name || '').slice(0, 60), role: m.role }))].slice(0, 50);
  try { await setDoc(doc(db, 'shops', me), { on: !!team.on, name: myShopName().slice(0, 80), people, options: { ...team.options }, updatedAt: new Date().toISOString() }); } catch { /* shown via inviteErr below if it matters */ }
  if (!team.on && !team.members.length) return;
  const want = new Map(team.members.map((m) => [lower(m.email), m]));
  const had = lastInvites || new Set();
  for (const email of had) if (!want.has(email)) { try { await deleteDoc(doc(db, 'shopInvites', email)); } catch { /* gone already */ } }
  for (const [email, m] of want) {
    try {
      await setDoc(doc(db, 'shopInvites', email), { owner: me, ownerName: String((user.displayName || 'Your boss')).slice(0, 80), shopName: myShopName().slice(0, 80), memberId: m.id, name: String(m.name || '').slice(0, 60), role: m.role, perms: m.perms, updatedAt: new Date().toISOString() });
      delete inviteErr[m.id];
      const uid = joinedBy[m.id];
      if (uid) await setDoc(doc(db, 'shops', me, 'members', uid), { role: m.role, perms: m.perms, name: String(m.name || '').slice(0, 60) }, { merge: true });
    } catch { inviteErr[m.id] = 'That email is already on another shop\'s team.'; }
  }
  lastInvites = new Set(want.keys());
  if (tab === 'settings' && !teamEdit) renderSettings();
}
/* Owner: remove a person (their invite and, if they joined, their membership) */
async function dropMember(m) {
  try { await deleteDoc(doc(db, 'shopInvites', lower(m.email))); } catch { /* not there */ }
  const uid = joinedBy[m.id];
  if (uid) { try { await deleteDoc(doc(db, 'shops', user.uid, 'members', uid)); } catch { /* not there */ } }
}
/* Signed in: am I a member of someone else's shop (or invited to one)? */
async function findShop(u) {
  memberUnsubs.forEach((x) => x()); memberUnsubs = [];
  shopOf = null; pendingInvite = null; awayFrom = null;
  const email = lower(u.email);
  if (!email) return;
  let inv = null;
  try { const s = await getDoc(doc(db, 'shopInvites', email)); inv = s.exists() ? s.data() : null; } catch { inv = null; }
  if (!inv || inv.owner === u.uid) return;
  let mem = null;
  try { const s = await getDoc(doc(db, 'shops', inv.owner, 'members', u.uid)); mem = s.exists() ? s.data() : null; } catch { mem = null; }
  if (!mem) { pendingInvite = { ...inv, email }; return; }
  let on = false;
  try { const s = await getDoc(doc(db, 'shops', inv.owner)); on = s.exists() && s.data().on === true; shopOpts = (s.exists() && s.data().options) || {}; peopleOf = (s.exists() && s.data().people) || []; } catch { on = false; }
  if (!on) return; // Employees switched off: back to your own data
  if (isAway(u.uid, inv.owner)) { awayFrom = { owner: inv.owner, shopName: inv.shopName, role: mem.role }; return; }
  shopOf = { owner: inv.owner, ownerName: inv.ownerName, shopName: inv.shopName, memberId: mem.memberId, role: mem.role, perms: mem.perms || {} };
  // removed, or Employees switched off: drop back to your own data right away
  memberUnsubs.push(onSnapshot(doc(db, 'shops', inv.owner, 'members', u.uid), (d) => { if (!d.exists()) leftShop('You were removed from ' + (inv.shopName || 'the shop') + '.'); else if (shopOf) { const was = JSON.stringify([shopOf.role, shopOf.perms]); shopOf.role = d.data().role; shopOf.perms = d.data().perms || {}; if (was !== JSON.stringify([shopOf.role, shopOf.perms])) { rememberShop(); for (const k of Object.keys(FRAMES)) { const f = $('p-' + k).querySelector('iframe'); if (f) f.src = FRAMES[k]; } renderHome(); } } }, () => leftShop('')));
  memberUnsubs.push(onSnapshot(doc(db, 'shops', inv.owner), (d) => { const hidWas = !!shopOpts.hideMine; shopOpts = (d.exists() && d.data().options) || {}; if (shopOf && hidWas !== !!shopOpts.hideMine) { rememberShop(); listen(shopOf.owner); for (const k of Object.keys(FRAMES)) { const f = $('p-' + k).querySelector('iframe'); if (f) f.src = FRAMES[k]; } } peopleOf = (d.exists() && d.data().people) || []; if (!d.exists() || d.data().on !== true) leftShop((inv.shopName || 'The shop') + ' switched Employees off.'); }, () => leftShop('')));
}
let leftMsg = '';
function leftShop(msg) { if (!shopOf) return; leftMsg = msg; startData(); }
function rememberShop() {
  try { if (shopOf && user) localStorage.setItem('gt-shop-of', JSON.stringify({ member: user.uid, owner: shopOf.owner, memberId: shopOf.memberId, role: shopOf.role, perms: shopOf.perms || {}, hideMine: !!shopOpts.hideMine })); else localStorage.removeItem('gt-shop-of'); } catch { /* private window */ }
}
/* Work out whose data to open, then open it (and reload any open Job_Board / Logbook tabs) */
let starting = 0;
async function startData() {
  if (!user || access !== 'ok') return;
  const n = ++starting;
  if (shopOf && leftMsg) { shopOf = null; memberUnsubs.forEach((x) => x()); memberUnsubs = []; }
  else await findShop(user);
  if (n !== starting) return;
  rememberShop();
  $('shEyebrow').textContent = shopOf ? (shopOf.shopName || 'Shop') : 'Garage Terminal · Shop';
  listen(shopOf ? shopOf.owner : user.uid);
  for (const k of Object.keys(FRAMES)) { const f = $('p-' + k).querySelector('iframe'); if (f) f.src = FRAMES[k]; }
  if (tab === 'settings') renderSettings();
}

function listen(uid) {
  unsubs.forEach((u) => u());
  records = null; projects = null; loadErr = '';
  const fail = (what) => (err) => { console.warn('shop: ' + what, err); loadErr = (what ? what + ': ' : '') + (err.message || err.code || 'unknown error'); renderHome(); };
  const gotJobs = (q) => { projects = q.docs.map((d) => ({ id: d.id, ...d.data() })); if (loadErr.startsWith('jobs')) loadErr = ''; renderHome(); };
  const member = shopOf && uid === shopOf.owner;
  const custOnly = () => query(collection(db, 'logbook', uid, 'projects'), where('kind', '==', 'customer'));
  // An employee whose shop hides My equipment may only ask for customer jobs. If the
  // shop's setting changed before this device heard about it, the full list is refused:
  // fall back to customer jobs instead of showing an error.
  const jobsFail = (err) => {
    if (member && err && err.code === 'permission-denied') {
      const i = unsubs.indexOf(stopJobs);
      stopJobs = onSnapshot(custOnly(), gotJobs, fail('jobs'));
      if (i >= 0) unsubs[i] = stopJobs; else unsubs.push(stopJobs);
      return;
    }
    fail('jobs')(err);
  };
  let stopJobs = onSnapshot(member && shopOpts.hideMine ? custOnly() : collection(db, 'logbook', uid, 'projects'), gotJobs, member && !shopOpts.hideMine ? jobsFail : fail('jobs'));
  unsubs = [
    onSnapshot(collection(db, 'logbook', uid, 'records'), (q) => { records = q.docs.map((d) => ({ id: d.id, ...d.data() })); renderHome(); }, fail('machines and parts')),
    stopJobs,
    // Job_Board's shop info (only the daily drop-off limit is used here)
    ...(user && uid === user.uid ? [onSnapshot(doc(db, 'logbook', uid, 'trackerSettings', 'team'), (d) => {
      const v = d.exists() ? d.data() || {} : {};
      team = { on: !!v.on, members: Array.isArray(v.members) ? v.members.filter((m) => m && m.id) : [], roles: { ...roleDefaults(), ...Object.fromEntries(Object.entries(v.roles || {}).filter(([k]) => ROLES[k]).map(([k, p]) => [k, { ...ROLES[k].perms, ...p }])) }, options: { assign: true, doneBy: true, ownTime: true, approveTime: true, ...(v.options || {}) } };
      if (lastInvites === null && (team.on || team.members.length)) syncShop(); // first load: make sure the invites match the list
      if (tab === 'settings' && !teamEdit) renderSettings();
    }, () => {})] : []),
    onSnapshot(doc(db, 'logbook', uid, 'trackerSettings', 'shop'), (d) => { const v = d.exists() ? d.data() || {} : {}; dayLimit = +v.dayLimit > 0 ? Math.round(+v.dayLimit) : 0; del = { delivery: v.delivery === true, delivFees: v.delivFees === true, delRate: +v.delRate > 0 ? +v.delRate : '', delMin: +v.delMin > 0 ? +v.delMin : '', delFree: +v.delFree > 0 ? +v.delFree : '', delRound: v.delRound !== false }; shopName = String(v.name || ''); if (tab === 'settings') renderSettings(); renderHome(); }, () => {}),
  ];
  if (user && uid === user.uid) {
    unsubs.push(onSnapshot(collection(db, 'shops', uid, 'members'), (q) => {
      joinedBy = {}; q.docs.forEach((d) => { const v = d.data() || {}; if (v.memberId) joinedBy[v.memberId] = d.id; });
      if (tab === 'settings' && !teamEdit) renderSettings();
    }, () => {}));
  }
}

watchSession((s) => {
  const before = access;
  access = s.state === 'loading' ? 'loading' : s.state === 'guest' ? 'guest' : (!sysopOnly || (s.state === 'member' && s.isSysop)) ? 'ok' : 'waiting';
  document.querySelector('.sh-tabs').hidden = access !== 'ok';
  $('shGear').hidden = access !== 'ok';
  if (access === 'ok' && before !== 'ok' && user) startData();
  if (access !== 'ok') { unsubs.forEach((x) => x()); unsubs = []; records = projects = null; show('home'); }
  renderHome();
});

onAuthStateChanged(auth, (u) => {
  const was = user && user.uid;
  user = u;
  if (u && access === 'ok') startData();
  else { unsubs.forEach((x) => x()); unsubs = []; records = projects = null; memberUnsubs.forEach((x) => x()); memberUnsubs = []; shopOf = null; pendingInvite = null; rememberShop(); }
  // pages already open in a tab sign in or out with the app (startData reloads them once it knows whose shop)
  if (!u && was) for (const n of Object.keys(FRAMES)) { const f = $('p-' + n).querySelector('iframe'); if (f) f.src = FRAMES[n]; }
  renderHome();
});
finishRedirectSignIn().catch(() => { /* shown as signed out */ });

// ---------- home ------------------------------------------------------------------------

// job parts (p.parts) plus parts on each task (t.parts), like Job_Board's allParts
const allParts = (p) => [
  ...(Array.isArray(p.parts) ? p.parts : []),
  ...(Array.isArray(p.tasks) ? p.tasks : []).flatMap((t) => (t && Array.isArray(t.parts) ? t.parts : [])),
];
// your own clock: entries say who (e.by = person id; missing = the owner) once Employees' own-time is on
const myPid = () => (shopOf ? shopOf.memberId : 'owner');
const tlog = (p) => (p && p.time && Array.isArray(p.time.log) ? p.time.log : []);
const running = (p) => tlog(p).find((e) => e && !e.manual && !e.end && e.start && (e.by || 'owner') === myPid());
// time waiting for approval (Employees step 4): who may approve, and the shop's options
let shopOpts = {};
let peopleOf = []; // member: the shop's people (names for the approval list)
const canApproveTime = () => (shopOf ? !!(shopOf.perms && shopOf.perms.approveTime) && shopOpts.approveTime !== false : team.on && team.options.approveTime !== false);
const tMsOf = (e) => (e.manual ? (Number(e.minutes) || 0) * 60000 : Math.max(0, (e.end || Date.now()) - e.start));
const jobNo = (p) => (p.kind === 'customer' && p.jobNo ? 'J-' + String(p.jobNo).padStart(3, '0') : '');
const dur = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const shortDay = (key) => new Date(key + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

function whenLabel(key, today) {
  if (key < today) return { text: 'Overdue · ' + shortDay(key), cls: 'late' };
  if (key === today) return { text: 'Today', cls: 'hot' };
  if (key === addDays(today, 1)) return { text: 'Tomorrow', cls: 'hot' };
  return { text: shortDay(key), cls: '' };
}

const card = (go, main, sub, right) =>
  `<button type="button" class="sh-card" data-go="${go}"><span><b>${main}</b>${sub ? `<span class="sh-sub">${sub}</span>` : ''}</span>${right || ''}</button>`;

// ---------- schedule ---------------------------------------------------------------------
// Customer jobs' drop-offs, pickups and promised dates (the same fields as Job_Board's Schedule):
// 4 weeks (this week + the next 3) or a whole month; pick a day to see it and book a drop-off on it.
// Only with Shop mode on (the tab is hidden otherwise).
let schedView = (() => { try { return localStorage.getItem('gt-sched-view') === 'month' ? 'month' : '4w'; } catch { return '4w'; } })();
let schedDay = '';   // picked day (YYYY-MM-DD), '' = today
let schedShift = 0;  // 4 weeks: weeks moved from this week; month: months moved from this month
// weeks start on Sunday
const weekStart = (k) => { const d = new Date(k + 'T12:00:00'); return addDays(k, -d.getDay()); };
function schedTabShown() {
  const b = document.querySelector('.sh-tabs [data-tab="schedule"]');
  if (b) b.hidden = !custOn();
  if (!custOn() && tab === 'schedule') show('home');
}
function schedItems(k) {
  const out = [];
  for (const p of projects || []) {
    if (!p || p.kind !== 'customer') continue;
    const c = p.customer || {};
    if (c.dropOff === k) out.push({ t: 'drop', p, time: c.dropTime || '' });
    if (c.pickup === k && p.status !== 'Done') out.push({ t: 'pick', p, time: c.pickupTime || '' });
    if (c.promised && String(c.promised).slice(0, 10) === k && p.status !== 'Done' && p.status !== 'Ready for pickup') out.push({ t: 'prom', p, time: '' });
  }
  const key = (x) => (x.time || '99:99') + (x.t === 'prom' ? '1' : '0');
  return out.sort((a, b) => key(a).localeCompare(key(b)));
}
function renderSchedule() {
  const box = $('p-schedule');
  if (!box) return;
  if (!projects) { box.innerHTML = `<p class="sh-muted sh-pad">${loadErr ? esc("Couldn't load the schedule: " + loadErr) : 'Loading…'}</p>`; return; }
  const today = dayKey(), day = schedDay || today;
  const fmt = (k, o) => new Date(k + 'T12:00:00').toLocaleDateString('en-US', o);
  let first, last, label, inMonth = () => true;
  if (schedView === 'month') {
    const t = new Date(today + 'T12:00:00'); const m = new Date(t.getFullYear(), t.getMonth() + schedShift, 1, 12);
    const mEnd = new Date(m.getFullYear(), m.getMonth() + 1, 0, 12);
    first = weekStart(dayKey(m.getTime())); last = addDays(weekStart(dayKey(mEnd.getTime())), 6);
    label = m.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const mm = m.getMonth(); inMonth = (k) => new Date(k + 'T12:00:00').getMonth() === mm;
  } else {
    first = addDays(weekStart(today), schedShift * 7); last = addDays(first, 27);
    label = `${fmt(first, { month: 'short', day: 'numeric' })} – ${fmt(last, { month: 'short', day: 'numeric' })}`;
  }
  const cells = [];
  for (let k = first; k <= last; k = addDays(k, 1)) cells.push(k);
  const drops = (k) => schedItems(k).filter((x) => x.t === 'drop').length;
  const dots = (k) => { const it = schedItems(k); const n = (t) => it.filter((x) => x.t === t).length;
    return ['drop', 'pick', 'prom'].map((t) => (n(t) ? `<i class="${t}">${n(t) > 1 ? n(t) : ''}</i>` : '')).join(''); };
  const grid = `<div class="sh-cal" role="grid" aria-label="${esc(label)}">
    ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<span class="sh-calh" aria-hidden="true">${d}</span>`).join('')}
    ${cells.map((k) => { const n = schedItems(k).length, dn = new Date(k + 'T12:00:00').getDate();
      const full = dayLimit && drops(k) >= dayLimit;
      return `<button type="button" data-calday="${k}" class="${k === today ? 'today ' : ''}${inMonth(k) ? '' : 'out '}${k < today ? 'past ' : ''}${full ? 'full' : ''}" aria-pressed="${k === day}" aria-label="${esc(fmt(k, { weekday: 'long', month: 'long', day: 'numeric' }))}, ${n} booking${n === 1 ? '' : 's'}${full ? ', full' : ''}"><b>${dn === 1 ? esc(fmt(k, { month: 'short' })) + ' ' : ''}${dn}</b><span class="sh-dots">${dots(k)}</span></button>`; }).join('')}
  </div>`;
  const items = schedItems(day), dn = drops(day);
  const tm = (t) => { if (!/^\d{1,2}:\d{2}/.test(t || '')) return ''; const [h, mi] = t.split(':').map(Number); return `${(h % 12) || 12}:${String(mi).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`; };
  const row = ({ t, p, time }) => { const c = p.customer || {}, who = c.name || 'Customer';
    // customer.inBy 'collect' = we pick it up from them; customer.ret 'deliver' = we take it back (Job_Board)
    const head = t === 'drop' ? (delOn() && c.inBy === 'collect' ? `Pick up from ${esc(who)}` : `${esc(who)} drops off`) : t === 'pick' ? (delOn() && c.ret === 'deliver' ? `Deliver to ${esc(who)}` : `${esc(who)} picks up`) : `Promised: ${esc(String(p.title || '').trim() || jobNo(p) || 'Job')}`;
    const sub = esc([jobNo(p), t === 'prom' ? who : (p.machine || p.title), t === 'drop' ? c.complaint : p.status].filter(Boolean).join(' · '));
    const pill = t === 'drop' ? (p.status === 'Not started' || !p.status ? '<span class="sh-pill steel">Expected</span>' : '<span class="sh-pill ok">In</span>')
      : t === 'pick' ? (delOn() && c.ret === 'deliver' ? '<span class="sh-pill ok">Delivery</span>' : '<span class="sh-pill ok">Out</span>') : (day < today ? '<span class="sh-pill over">Overdue</span>' : '<span class="sh-pill warn">Due</span>');
    return `<button type="button" class="sh-card sh-sched ${t === 'pick' ? 'pick' : ''}" data-openjob="${esc(p.id)}"><span class="sh-tm">${t === 'prom' ? 'due' : esc(tm(time) || '—')}</span><span style="flex:1;min-width:0"><b>${head}</b><span class="sh-sub">${sub}</span></span>${pill}</button>`; };
  const limitTxt = dayLimit ? `${dn} of ${dayLimit} drop-offs` : `${dn} drop-off${dn === 1 ? '' : 's'}`;
  box.innerHTML = `<div class="sh-pad sh-schedpage">
    ${shopClockOn() && seesAllClock() ? whosInHtml() : ''}
    <div class="sh-seg" role="group" aria-label="How much to show"><button type="button" data-schedview="4w" aria-pressed="${schedView === '4w'}">4 weeks</button><button type="button" data-schedview="month" aria-pressed="${schedView === 'month'}">Month</button></div>
    <div class="sh-calbar"><button type="button" class="sh-btn ghost sm" data-schedmove="-1" aria-label="${schedView === 'month' ? 'Previous month' : 'Earlier'}">‹</button><b>${esc(label)}</b><button type="button" class="sh-btn ghost sm" data-schedmove="1" aria-label="${schedView === 'month' ? 'Next month' : 'Later'}">›</button>${schedShift || day !== today ? '<button type="button" class="sh-btn ghost sm" data-schedtoday>Today</button>' : ''}</div>
    ${grid}
    <p class="sh-calkey" aria-hidden="true"><i class="drop"></i>Drop-off <i class="pick"></i>Pickup <i class="prom"></i>Promised${dayLimit ? ' <span class="full">Full day</span>' : ''}</p>
    <section aria-labelledby="h-schedday"><h2 class="sh-h2" id="h-schedday">${esc(fmt(day, { weekday: 'long', month: 'short', day: 'numeric' }))} <small>${esc(limitTxt)}</small></h2>
      ${items.length ? items.map(row).join('') : `<p class="sh-empty">Nothing booked${day === today ? ' today' : ''}.</p>`}
      ${day >= today ? `<button type="button" class="sh-btn" data-book="${day}" style="width:100%;margin-top:8px">+ Book a drop-off on ${esc(fmt(day, { weekday: 'short', month: 'short', day: 'numeric' }))}</button>
      ${dayLimit && dn >= dayLimit ? `<p class="sh-foot" style="color:var(--warn)">This day already has ${dn} of ${dayLimit} drop-offs. You can still book it.</p>` : ''}` : ''}
    </section></div>`;
}
document.addEventListener('click', (e) => {
  const t = (q) => e.target.closest('#p-schedule ' + q);
  if (t('[data-calday]')) { schedDay = t('[data-calday]').dataset.calday; renderSchedule(); return; }
  if (t('[data-schedview]')) { schedView = t('[data-schedview]').dataset.schedview; schedShift = 0; try { localStorage.setItem('gt-sched-view', schedView); } catch { /* fine */ } renderSchedule(); return; }
  if (t('[data-schedmove]')) { schedShift += +t('[data-schedmove]').dataset.schedmove * (schedView === 'month' ? 1 : 4); if (schedView === 'month') schedShift = Math.round(schedShift); renderSchedule(); return; }
  if (t('[data-schedtoday]')) { schedShift = 0; schedDay = ''; renderSchedule(); return; }
  if (t('[data-openjob]')) { frameFor('jobs').src = '/apps/job-board?shop=1&job=' + encodeURIComponent(t('[data-openjob]').dataset.openjob); show('jobs'); return; }
  if (t('[data-book]')) { frameFor('jobs').src = '/apps/job-board?shop=1&book=' + encodeURIComponent(t('[data-book]').dataset.book); show('jobs'); return; }
});
// Job_Board (inside the Jobs tab) says when a booking started here was saved: come back to the Schedule on that day
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.gt === 'go' && e.data.tab === 'home') { show('home'); return; }
  if (e.data.gt !== 'booked') return;
  if (/^\d{4}-\d{2}-\d{2}$/.test(e.data.day || '')) schedDay = e.data.day;
  // (Job_Board saved the job before saying so; leave its frame alone, it has moved on to its own Schedule)
  show('schedule');
});

// ---------- clocks ----------------------------------------------------------------------
// Settings → Clocks (owner): Job clocks (time on a job, Job_Board's clock; on by default) for every
// shop, and with Employees on the Shop clock (clock in / out for the day, for payroll; off by default):
// Owner clocks in too, Job clocks need clock-in first, overtime hours, round to 15 minutes.
// Saved in team.options → shops/{owner}.options. One doc per person per day:
// logbook/{owner}/clock/{personId}_{YYYY-MM-DD} = {person, name, day, in, out, breaks:[{s,e}], note, edited, editedBy, ok, okBy, okAt}
// (times are ISO strings; a shift past midnight stays on the day it started).
const clockOpts = () => (shopOf ? shopOpts : team.options) || {};
const jobClocksOn = () => clockOpts().jobClocks !== false;
const shopClockOn = () => clockOpts().shopClock === true && (shopOf ? true : team.on);
const mustClock = () => shopClockOn() && (!!shopOf || clockOpts().ownerClock === true);
const clockOwner = () => (shopOf ? shopOf.owner : user && user.uid);
const seesAllClock = () => !shopOf || !!(shopOf.perms && shopOf.perms.approveTime);
let clockDays = {}; let clockKey = ''; let clockUnsub = null; let clockErr = '';
let tsWeek = 0; let tsPick = ''; // timesheet: 0 this week, -1 last week; picked docId
let tsFrom = 'home'; // the tab the timesheet was opened from (its Back button returns there)
function syncClockListen() {
  const owner = clockOwner();
  const want = user && owner && shopClockOn() ? `${owner}|${seesAllClock() ? 'all' : myPid()}|${weekStart(dayKey())}` : '';
  if (want === clockKey) return;
  clockKey = want; if (clockUnsub) { clockUnsub(); clockUnsub = null; } clockDays = {}; clockErr = '';
  if (!want) { noteClock(); return; }
  const col = collection(db, 'logbook', owner, 'clock');
  const q = seesAllClock() ? query(col, where('day', '>=', addDays(weekStart(dayKey()), -14))) : query(col, where('person', '==', myPid()));
  clockUnsub = onSnapshot(q, (snap) => { clockDays = {}; snap.docs.forEach((d) => { clockDays[d.id] = d.data(); }); noteClock(); if (tab === 'home') renderHome(); if (tab === 'timesheet') renderTimesheet(); },
    (err) => { clockErr = err.message || err.code || 'error'; if (tab === 'home') renderHome(); });
}
const isoAt = (day, hhmm) => new Date(`${day}T${hhmm}:00`).toISOString();
const hhmmOf = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const clockT = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—');
const r15 = (ms) => (clockOpts().round15 ? Math.round(ms / 900000) * 900000 : ms);
function workedMs(d, now = Date.now()) {
  if (!d || !d.in) return 0;
  const a = r15(+new Date(d.in)), b = d.out ? r15(+new Date(d.out)) : now;
  const br = (d.breaks || []).reduce((n, x) => n + Math.max(0, (x.e ? +new Date(x.e) : (d.out ? +new Date(d.out) : now)) - +new Date(x.s)), 0);
  return Math.max(0, b - a - br);
}
const hrs = (ms) => (ms / 3600000).toFixed(1);
const myOpenDay = () => Object.entries(clockDays).filter(([, d]) => d.person === myPid() && d.in && !d.out).sort((a, b) => b[1].day.localeCompare(a[1].day))[0] || null;
// tell Job_Board (inside the Jobs tab, same site) whether job clocks are locked until clock-in
function noteClock() {
  try {
    const need = !!user && mustClock() && clockOpts().clockFirst !== false;
    localStorage.setItem('gt-on-clock', JSON.stringify({ uid: user ? user.uid : '', owner: clockOwner() || '', need, on: !!myOpenDay() }));
  } catch { /* private window */ }
}
async function saveDay(id, d) {
  const mine = d.person === myPid();
  const data = { ...d, updatedAt: new Date().toISOString() };
  if (shopOf && !seesAllClock()) data.ok = false; // employees can't approve their own time
  else if (mine && !('ok' in d)) data.ok = true; // the owner's / an approver's own time
  clockDays[id] = data; noteClock();
  await setDoc(doc(db, 'logbook', clockOwner(), 'clock', id), JSON.parse(JSON.stringify(data)));
}
// clocking out also stops your running job clock
async function stopMyJobClock() {
  for (const p of projects || []) {
    const r = running(p); if (!r) continue;
    const log = tlog(p).map((e) => (e === r ? { ...e, end: Date.now() } : e));
    try { await setDoc(doc(db, 'logbook', clockOwner(), 'projects', p.id), { time: { ...(p.time || {}), log } }, { merge: true }); } catch { /* shown in Job_Board */ }
  }
}
let clockOutOpen = false;
function shopClockHtml() {
  if (!mustClock()) return shopClockOn() && seesAllClock() ? whosInHtml() : '';
  if (clockErr) return `<p class="sh-empty">Shop clock: ${esc(clockErr)}</p>`;
  const now = Date.now(), today = dayKey(), me = myPid();
  const open = myOpenDay();
  const weekMs = Object.values(clockDays).filter((d) => d.person === me && d.day >= weekStart(today)).reduce((n, d) => n + workedMs(d, now), 0);
  const jobToday = (projects || []).reduce((n, p) => n + tlog(p).filter((e) => e && !e.manual && (e.by || 'owner') === me && e.start && dayKey(e.start) === today && !e.rejected).reduce((m, e) => m + tMsOf(e), 0), 0);
  const split = (worked) => (jobClocksOn() ? `<div class="sh-kv"><span>On jobs (billable)</span><b>${dur(jobToday)}</b></div><div class="sh-kv"><span>Shop time</span><b>${dur(Math.max(0, worked - jobToday))}</b></div>` : '');
  let h;
  if (open && open[1].day < today && now - +new Date(open[1].in) > 16 * 3600000) {
    const [id, d] = open;
    h = `<div class="sh-big warn"><span class="sh-state" style="color:var(--warn)">Still clocked in</span>
      <b>You didn't clock out on ${esc(shortDay(d.day))} (in at ${esc(clockT(d.in))}).</b>
      <form class="sh-formrow" data-fixout="${esc(id)}"><label class="sh-foot" style="margin:0">What time did you leave?<input type="time" name="t" required value="17:00"></label><button type="submit" class="sh-btn">Save</button></form>
      <p class="sh-foot" style="margin:0">It shows as Edited on the timesheet.</p></div>`;
  } else if (open) {
    const [id, d] = open; const worked = workedMs(d, now); const onBreak = (d.breaks || []).some((x) => !x.e);
    const rj = jobClocksOn() ? (projects || []).map((p) => [p, running(p)]).find(([, r]) => r) : null;
    h = clockOutOpen ? `<div class="sh-big"><span class="sh-state">Clock out · ${esc(shortDay(d.day))}</span>
        <div class="sh-kv"><span>In</span><b>${esc(clockT(d.in))}</b></div>
        ${(d.breaks || []).map((x) => `<div class="sh-kv"><span>Break</span><b>${esc(clockT(x.s))} – ${esc(x.e ? clockT(x.e) : 'now')}</b></div>`).join('')}
        <div class="sh-kv"><span>Out</span><b>${esc(clockT(new Date().toISOString()))}</b></div>
        <div class="sh-kv"><span><b>Worked</b></span><b>${dur(worked)}</b></div>
        ${rj ? `<p class="sh-foot" style="margin:0;color:var(--warn)">Your job clock on ${esc([jobNo(rj[0]), rj[0].title].filter(Boolean).join(' · '))} is running; it stops when you clock out.</p>` : ''}
        <label class="sh-foot" style="margin:0">Note (optional)<input type="text" id="shClockNote" maxlength="300" placeholder="e.g. left early for the parts run" value="${esc(d.note || '')}"></label>
        <div class="sh-formbtns"><button type="button" class="sh-btn" data-clockout="${esc(id)}">Clock out now</button><button type="button" class="sh-btn ghost" data-clockcancel>Cancel</button></div></div>`
      : `<div class="sh-big on"><div class="sh-row"><span class="sh-state" style="color:${onBreak ? 'var(--warn)' : 'var(--ok)'}">● ${onBreak ? 'On break' : 'On the clock'}</span><span class="sh-sub">since ${esc(clockT(d.in))}${d.day < today ? ' ' + esc(shortDay(d.day)) : ''}</span></div>
        <span class="sh-bigtime">${dur(worked)}</span>
        ${rj ? `<div class="sh-row"><span class="sh-sub">On a job now</span><b>${esc([jobNo(rj[0]), rj[0].title].filter(Boolean).join(' · '))}</b></div>` : ''}
        <div class="sh-two"><button type="button" class="sh-btn ghost" data-break="${esc(id)}">${onBreak ? 'End break' : 'Start break'}</button><button type="button" class="sh-btn" data-clockoutask>Clock out</button></div>
        <div class="sh-kv"><span>This week</span><b>${dur(weekMs)}</b></div>${d.day === today ? split(worked) : ''}</div>`;
  } else {
    const t = clockDays[me + '_' + today];
    h = t && t.out ? `<div class="sh-big"><span class="sh-state">Clocked out at ${esc(clockT(t.out))}</span><span class="sh-bigtime">${dur(workedMs(t))}</span>
        <div class="sh-kv"><span>This week</span><b>${dur(weekMs)}</b></div>${split(workedMs(t))}
        <button type="button" class="sh-btn ghost" data-clockback="${esc(me + '_' + today)}">Clock back in</button></div>`
      : `<div class="sh-big"><span class="sh-state">Not clocked in</span><span class="sh-bigtime">${esc(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</span>
        <button type="button" class="sh-btn ok" data-clockin style="min-height:56px;font-size:17px">Clock in</button>
        <span class="sh-sub">This week so far: ${dur(weekMs)}${jobClocksOn() && clockOpts().clockFirst !== false ? ' · job clocks unlock when you clock in' : ''}</span></div>`;
  }
  return `<section aria-label="Shop clock">${h}${seesAllClock() ? whosInHtml(true) : '<button type="button" class="sh-linkbtn" style="color:var(--accent)" data-timesheet>My hours →</button>'}</section>`;
}
function whosInHtml(small) {
  const inNow = Object.values(clockDays).filter((d) => d.in && !d.out).map((d) => d.name || 'Someone');
  const look = needsLook().length;
  return `<button type="button" class="sh-card" data-timesheet${small ? ' style="margin-top:8px"' : ''}><span style="flex:1;min-width:0"><b>Timesheet</b><span class="sh-sub">${inNow.length ? 'In now: ' + esc(inNow.join(', ')) : 'Nobody clocked in'}${look ? ` · ${look} to look at` : ''}</span></span><span class="sh-pill ${look ? 'warn' : 'steel'}">${look ? 'Look' : 'Open'}</span></button>`;
}
function needsLook() {
  const today = dayKey();
  return Object.entries(clockDays).filter(([, d]) => (d.edited && !d.ok) || (d.in && !d.out && d.day < addDays(today, -1)));
}
function clockPeople() {
  // owner row: when the owner clocks in (or has hours); employees: everyone for approvers, else just you
  const list = shopOf ? peopleOf.map((p) => ({ id: p.id, name: p.name })) : [{ id: 'owner', name: user.displayName || 'You' }, ...team.members.map((m) => ({ id: m.id, name: m.name }))];
  const has = new Set(Object.values(clockDays).map((d) => d.person));
  return list.filter((p) => (seesAllClock() || p.id === myPid()) && (p.id !== 'owner' || clockOpts().ownerClock === true || has.has('owner')));
}
function renderTimesheet() {
  const box = $('p-timesheet'); if (!box) return;
  if (!shopClockOn()) { box.innerHTML = '<p class="sh-empty sh-pad">The shop clock is off.</p>'; return; }
  const start = addDays(weekStart(dayKey()), tsWeek * 7), days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
  const ot = +clockOpts().otHours > 0 ? +clockOpts().otHours : 40;
  const people = clockPeople();
  const all = seesAllClock();
  const cell = (p, k) => { const id = p.id + '_' + k, d = clockDays[id];
    if (!d) return '<td>–</td>';
    const flag = (d.edited && !d.ok) || (d.in && !d.out && k < dayKey());
    return `<td><button type="button" class="sh-tsbtn${flag ? ' flag' : ''}${tsPick === id ? ' on' : ''}" data-tspick="${esc(id)}">${d.out ? hrs(workedMs(d)) : '•'}${flag ? '*' : ''}</button></td>`; };
  const rows = people.map((p) => { const ms = days.reduce((n, k) => n + workedMs(clockDays[p.id + '_' + k]), 0); const over = ms / 3600000 - ot;
    return `<tr><td class="n">${esc(p.name)}</td>${days.map((k) => cell(p, k)).join('')}<td class="tot">${hrs(ms)}${over > 0 ? `<span class="ot">+${over.toFixed(1)} OT</span>` : ''}</td></tr>`; }).join('');
  const pick = tsPick && clockDays[tsPick];
  const canEdit = pick && (all || pick.person === myPid());
  const pickHtml = pick ? `<section class="sh-big" aria-label="Day details"><span class="sh-state">${esc(pick.name || '')} · ${esc(shortDay(pick.day))}</span>
      ${canEdit ? `<form class="sh-tsform" data-tsedit="${esc(tsPick)}">
        <label>In<input type="time" name="in" value="${pick.in ? hhmmOf(pick.in) : ''}" required></label>
        <label>Out<input type="time" name="out" value="${pick.out ? hhmmOf(pick.out) : ''}"></label>
        <button type="submit" class="sh-btn ghost">Save times</button></form>` : `<div class="sh-kv"><span>In</span><b>${esc(clockT(pick.in))}</b></div><div class="sh-kv"><span>Out</span><b>${esc(clockT(pick.out))}</b></div>`}
      ${(pick.breaks || []).map((x) => `<div class="sh-kv"><span>Break</span><b>${esc(clockT(x.s))} – ${esc(clockT(x.e))}</b></div>`).join('')}
      <div class="sh-kv"><span><b>Worked</b></span><b>${pick.out ? hrs(workedMs(pick)) + ' h' : 'still clocked in'}</b></div>
      ${pick.note ? `<p class="sh-foot" style="margin:0">Note: ${esc(pick.note)}</p>` : ''}
      ${pick.edited ? `<p class="sh-foot" style="margin:0;color:var(--warn)">Edited${pick.editedBy ? ' by ' + esc(pick.editedBy) : ''}${pick.ok ? ' · OK’d' : ''}</p>` : ''}
      ${all && !pick.ok && pick.out ? `<button type="button" class="sh-btn" data-tsok="${esc(tsPick)}">OK this day</button>` : ''}
      <p class="sh-foot" id="shTsMsg" role="status" style="margin:0"></p></section>` : '';
  const look = needsLook().filter(([id]) => days.includes(clockDays[id].day) || tsWeek === 0);
  const toOk = Object.entries(clockDays).filter(([, d]) => days.includes(d.day) && d.out && !d.ok);
  box.innerHTML = `<div class="sh-pad sh-schedpage">
    <button type="button" class="sh-linkbtn" style="color:var(--accent);align-self:flex-start;min-height:40px" data-tsback>← Back to ${esc(TITLES[tsFrom] || 'Home')}</button>
    <div class="sh-seg" role="group" aria-label="Which week"><button type="button" data-tsweek="0" aria-pressed="${tsWeek === 0}">This week</button><button type="button" data-tsweek="-1" aria-pressed="${tsWeek === -1}">Last week</button></div>
    <b class="sh-tsrange">${esc(new Date(start + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))} – ${esc(new Date(days[6] + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</b>
    ${people.length ? `<div class="sh-tswrap"><table class="sh-ts"><thead><tr><th>Who</th>${days.map((k) => `<th>${esc(new Date(k + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' }))}<br>${new Date(k + 'T12:00:00').getDate()}</th>`).join('')}<th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="sh-foot" style="margin:0">Hours per day${clockOpts().round15 ? ', in and out rounded to 15 minutes' : ''}. • = still clocked in, * = needs a look. Overtime after ${ot} h a week. Tap a day for its times.</p>` : '<p class="sh-empty">No hours yet this week.</p>'}
    ${pickHtml}
    ${all && look.length ? `<section><h2 class="sh-h2">Needs a look <small>${look.length}</small></h2>${look.map(([id, d]) => `<button type="button" class="sh-card" data-tspick="${esc(id)}"><span style="flex:1;min-width:0"><b>${esc(d.name || '')} · ${esc(shortDay(d.day))}</b><span class="sh-sub">${d.out ? `Edited: ${esc(clockT(d.in))} – ${esc(clockT(d.out))}` : 'Never clocked out'}</span></span><span class="sh-pill warn">Look</span></button>`).join('')}</section>` : ''}
    ${all ? `<div class="sh-two"><button type="button" class="sh-btn ghost" data-tscsv>Export CSV</button><button type="button" class="sh-btn" data-tsokall ${toOk.length ? '' : 'disabled'}>${toOk.length ? `OK week (${toOk.length})` : 'All OK’d'}</button></div><p class="sh-foot" id="shTsAll" role="status" style="margin:0"></p>` : ''}
  </div>`;
}
document.addEventListener('click', async (e) => {
  const t = (q) => e.target.closest(q);
  if (t('[data-timesheet]')) { if (tab !== 'timesheet') tsFrom = tab; show('timesheet'); return; }
  if (t('#p-timesheet [data-tsback]')) { show(tsFrom in TITLES && tsFrom !== 'timesheet' ? tsFrom : 'home'); return; }
  if (t('#p-home [data-clockin]')) {
    const id = myPid() + '_' + dayKey();
    try { await saveDay(id, { person: myPid(), name: String((shopOf ? (peopleOf.find((p) => p.id === myPid()) || {}).name : user.displayName) || user.displayName || 'Me').slice(0, 60), day: dayKey(), in: new Date().toISOString(), out: '', breaks: [] }); } catch (err) { clockErr = "couldn't clock in: " + (err.message || err.code); }
    renderHome(); return;
  }
  if (t('#p-home [data-break]')) { const id = t('[data-break]').dataset.break, d = clockDays[id]; if (!d) return; const now = new Date().toISOString();
    const br = [...(d.breaks || [])]; const i = br.findIndex((x) => !x.e); if (i >= 0) br[i] = { ...br[i], e: now }; else br.push({ s: now, e: '' });
    try { await saveDay(id, { ...d, breaks: br }); } catch (err) { clockErr = err.message || err.code; } renderHome(); return; }
  if (t('#p-home [data-clockoutask]')) { clockOutOpen = true; renderHome(); return; }
  if (t('#p-home [data-clockcancel]')) { clockOutOpen = false; renderHome(); return; }
  if (t('#p-home [data-clockout]')) { const id = t('[data-clockout]').dataset.clockout, d = clockDays[id]; if (!d) return; const now = new Date().toISOString();
    const note = ($('shClockNote') && $('shClockNote').value.trim()) || '';
    const br = (d.breaks || []).map((x) => (x.e ? x : { ...x, e: now }));
    clockOutOpen = false;
    try { await saveDay(id, { ...d, breaks: br, out: now, ...(note ? { note: note.slice(0, 300) } : {}) }); await stopMyJobClock(); } catch (err) { clockErr = err.message || err.code; }
    renderHome(); return; }
  if (t('#p-home [data-clockback]')) { const id = t('[data-clockback]').dataset.clockback, d = clockDays[id]; if (!d) return;
    try { await saveDay(id, { ...d, breaks: [...(d.breaks || []), { s: d.out, e: new Date().toISOString() }], out: '' }); } catch (err) { clockErr = err.message || err.code; } renderHome(); return; }
  if (t('#p-timesheet [data-tsweek]')) { tsWeek = +t('[data-tsweek]').dataset.tsweek; tsPick = ''; renderTimesheet(); return; }
  if (t('[data-tspick]')) { const id = t('[data-tspick]').dataset.tspick; tsPick = tsPick === id ? '' : id; if (tab !== 'timesheet') show('timesheet'); else renderTimesheet(); return; }
  if (t('#p-timesheet [data-tsok]')) { const id = t('[data-tsok]').dataset.tsok, d = clockDays[id];
    try { await saveDay(id, { ...d, ok: true, okBy: myPid(), okAt: new Date().toISOString() }); } catch (err) { $('shTsMsg').textContent = "Couldn't save: " + (err.message || err.code); return; } renderTimesheet(); return; }
  if (t('#p-timesheet [data-tsokall]')) { const start = addDays(weekStart(dayKey()), tsWeek * 7), end = addDays(start, 6); let n = 0;
    for (const [id, d] of Object.entries(clockDays)) { if (d.day >= start && d.day <= end && d.out && !d.ok) { try { await saveDay(id, { ...d, ok: true, okBy: myPid(), okAt: new Date().toISOString() }); n++; } catch { /* keep going */ } } }
    renderTimesheet(); if ($('shTsAll')) $('shTsAll').textContent = `OK'd ${n} day${n === 1 ? '' : 's'}.`; return; }
  if (t('#p-timesheet [data-tscsv]')) { const start = addDays(weekStart(dayKey()), tsWeek * 7), end = addDays(start, 6);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Person', 'Day', 'In', 'Out', 'Break minutes', 'Hours', 'Edited', "OK'd", 'Note'].map(q).join(',')];
    Object.values(clockDays).filter((d) => d.day >= start && d.day <= end).sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.day.localeCompare(b.day)).forEach((d) => {
      const brk = (d.breaks || []).reduce((n, x) => n + (x.e ? (+new Date(x.e) - +new Date(x.s)) / 60000 : 0), 0);
      lines.push([d.name, d.day, d.in ? clockT(d.in) : '', d.out ? clockT(d.out) : '', Math.round(brk), d.out ? hrs(workedMs(d)) : '', d.edited ? 'yes' : '', d.ok ? 'yes' : '', d.note || ''].map(q).join(','));
    });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `timesheet-${start}.csv`; document.body.append(a); a.click(); a.remove(); return; }
});
document.addEventListener('submit', async (e) => {
  const fx = e.target.closest('[data-fixout]');
  if (fx) { e.preventDefault(); const id = fx.dataset.fixout, d = clockDays[id]; if (!d) return; const t = new FormData(fx).get('t');
    let out = isoAt(d.day, t); if (out <= d.in) out = isoAt(addDays(d.day, 1), t);
    try { await saveDay(id, { ...d, out, breaks: (d.breaks || []).map((x) => (x.e ? x : { ...x, e: out })), edited: true, editedBy: String(d.name || '').slice(0, 60) }); } catch (err) { clockErr = err.message || err.code; }
    renderHome(); return; }
  const te = e.target.closest('[data-tsedit]');
  if (te) { e.preventDefault(); const id = te.dataset.tsedit, d = clockDays[id]; if (!d) return; const f = new FormData(te);
    const inIso = isoAt(d.day, f.get('in')); let out = f.get('out') ? isoAt(d.day, f.get('out')) : ''; if (out && out <= inIso) out = isoAt(addDays(d.day, 1), f.get('out'));
    const me = shopOf ? ((peopleOf.find((p) => p.id === myPid()) || {}).name || user.displayName) : (user.displayName || 'Owner');
    const approver = seesAllClock();
    try { await saveDay(id, { ...d, in: inIso, out, edited: true, editedBy: String(me || '').slice(0, 60), ...(approver ? { ok: true, okBy: myPid(), okAt: new Date().toISOString() } : { ok: false }) }); } catch (err) { $('shTsMsg').textContent = "Couldn't save: " + (err.message || err.code); return; }
    renderTimesheet(); return; }
});
function clocksSection() {
  if (shopOf) return '';
  const o = team.options || {};
  const sw = (k, on, label, desc) => `<div class="sh-setrow"><span style="flex:1;min-width:0"><b>${label}</b><span class="sh-sub">${desc}</span></span><button type="button" class="sh-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${label}" data-clocksw="${k}"><span></span></button></div>`;
  return `<section class="sh-set" aria-labelledby="h-clocks"><h2 class="sh-h2" id="h-clocks">Clocks</h2>
    ${sw('jobClocks', o.jobClocks !== false, 'Job clocks', 'Clock in and out of a job in Job_Board to track time on it for labor. Off: type labor hours yourself.')}
    ${team.on ? sw('shopClock', o.shopClock === true, 'Shop clock', 'Employees clock in and out for the day (for payroll), with breaks and a weekly timesheet.') : ''}
    ${team.on && o.shopClock === true ? `<div class="sh-opts">
      <label><input type="checkbox" data-teamopt="ownerClock" ${o.ownerClock ? 'checked' : ''}> The owner clocks in and out too</label>
      ${o.jobClocks !== false ? `<label><input type="checkbox" data-teamopt="clockFirst" ${o.clockFirst !== false ? 'checked' : ''}> Job clocks need clock-in first (in the shop app)</label>` : ''}
      <label><input type="checkbox" data-teamopt="round15" ${o.round15 ? 'checked' : ''}> Round in and out to the nearest 15 minutes</label>
      <label>Overtime after <input type="number" min="1" max="99" inputmode="numeric" data-othours value="${+o.otHours > 0 ? +o.otHours : 40}" style="width:72px"> hours a week</label></div>
    <button type="button" class="sh-btn ghost" data-timesheet>Open timesheet</button>` : ''}
    ${!team.on ? '<p class="sh-foot" style="margin:0">Turn on Employees to get the shop clock (clock in / out for the day).</p>' : ''}
  </section>`;
}

function renderHome() {
  if (tab === 'schedule') renderSchedule();
  if (tab === 'timesheet') renderTimesheet();
  try { syncClockListen(); } catch { /* first call can come before the clock code below has loaded */ }
  schedTabShown();
  if (tab !== 'home') return;
  const box = $('p-home');
  if (!user) {
    box.innerHTML = `<div class="sh-signin"><h2>Your shop, in one app</h2>
      <p>Sign in with the Google account you use for the Logbook and Job_Board. Your machines, parts, jobs and customers show up here; nothing is copied, and changes show in both places.</p>
      <button type="button" class="sh-btn" id="shSignIn">Sign in with Google</button>
      <p class="sh-foot" id="shSignMsg" role="status"></p></div>`;
    $('shSignIn').onclick = async () => {
      try { await signInWithGoogle(); } catch (err) {
        if (err && err.code === 'auth/popup-closed-by-user') return;
        $('shSignMsg').textContent = "Couldn't sign in: " + (err.message || err.code);
      }
    };
    return;
  }
  if (access === 'loading') { box.innerHTML = '<p class="sh-muted sh-pad">Loading…</p>'; return; }
  if (access === 'waiting') {
    box.innerHTML = `<div class="sh-signin"><h2>Coming soon</h2>
      <p>The Garage Terminal shop app is being tested and isn't open yet. Your Logbook and Job_Board work as usual in the meantime.</p>
      <a class="sh-btn ghost" href="/#apps" style="display:flex;align-items:center;justify-content:center;text-decoration:none">Back to Garage Terminal</a></div>`;
    return;
  }
  if (loadErr) { box.innerHTML = `<p class="sh-empty">Couldn't load ${shopOf ? esc(shopOf.shopName || 'the shop') : 'your shop'}'s ${esc(loadErr)}</p><div class="sh-formbtns"><button type="button" class="sh-btn ghost" data-retry>Try again</button></div>`; return; }
  if (pendingInvite && !inviteLater()) {
    box.innerHTML = `<div class="sh-signin"><h2>Join ${esc(pendingInvite.shopName || 'the shop')}?</h2>
      <p>${esc(pendingInvite.ownerName || 'The owner')} added you as <b>${esc((ROLES[pendingInvite.role] || ROLES.tech).label)}</b>. Joining opens their shop's jobs, machines and parts here. Your own Logbook stays yours.</p>
      <button type="button" class="sh-btn" data-join>Join</button><button type="button" class="sh-btn ghost" data-joinlater>Not now</button>
      <p class="sh-foot" id="shJoinMsg" role="status"></p></div>`;
    return;
  }
  if (!records || !projects) { box.innerHTML = '<p class="sh-muted sh-pad">Loading your shop…</p>'; return; }

  const today = dayKey();
  const cust = custOn();
  const open = projects.filter((p) => p && p.status !== 'Done' && (cust || p.kind !== 'customer'));
  const brief = buildBrief({ records, projects: [], nowMs: Date.now(), tz: TZ, sections: { lowStock: true, maintenance: true, projects: false } });
  const low = brief.sections.lowStock || [];
  const due = (brief.sections.maintenance || []).slice(0, 4);

  // the clock
  // (with the shop clock on, its card already shows the job you're on)
  const rj = jobClocksOn() && !mustClock() ? open.map((p) => [p, running(p)]).find(([, r]) => r) : null;
  const clock = rj ? `<button type="button" class="sh-card sh-clock" data-go="jobs"><span class="sh-dot" aria-hidden="true"></span>
      <span style="flex:1;min-width:0"><b>On the clock · <span class="sh-time">${dur(Date.now() - rj[1].start)}</span></b><span class="sh-sub">${esc([jobNo(rj[0]), rj[0].title].filter(Boolean).join(' · '))}</span></span>
      <span class="sh-pill ok">Open</span></button>` : '';

  // counts
  const ready = open.filter((p) => p.status === 'Ready for pickup');
  const jobParts = open.flatMap((p) => allParts(p).map((x) => ({ ...x, job: p })));
  const jobToOrder = jobParts.filter((x) => x && x.status === 'To order');
  const jobLate = jobParts.filter((x) => x && x.status === 'Ordered' && x.expected && String(x.expected).slice(0, 10) < today);
  const reorder = low.filter((p) => !p.ordered);
  const invLate = low.filter((p) => p.late);
  const toOrderN = jobToOrder.length + reorder.length;

  const stats = `<div class="sh-stats">
    <button type="button" class="sh-stat" data-go="jobs"><span>Open jobs</span><b>${open.length}</b></button>
    <button type="button" class="sh-stat ${ready.length ? 'ok' : ''}" data-go="jobs"><span>Ready</span><b>${ready.length}</b></button>
    <button type="button" class="sh-stat ${toOrderN ? 'warn' : ''}" data-go="${reorder.length || !jobToOrder.length ? 'parts' : 'jobs'}"><span>To order</span><b>${toOrderN}</b></button></div>`;

  // coming up: promised in the next 7 days (or overdue), and jobs ready for pickup
  const horizon = addDays(today, 7);
  const coming = open
    .filter((p) => p.kind === 'customer' && ((p.customer && p.customer.promised && String(p.customer.promised).slice(0, 10) <= horizon) || p.status === 'Ready for pickup'))
    .map((p) => ({ p, key: p.customer && p.customer.promised ? String(p.customer.promised).slice(0, 10) : '' }))
    .sort((a, b) => (a.key || '9999').localeCompare(b.key || '9999'))
    .slice(0, 6);
  const comingHtml = !cust ? '' : `<section aria-labelledby="h-up"><h2 class="sh-h2" id="h-up">Coming up <small>next 7 days</small></h2>${coming.length
    ? coming.map(({ p, key }) => {
      const who = p.customer && p.customer.name ? p.customer.name : '';
      const sub = esc([jobNo(p), who, p.status || 'Not started'].filter(Boolean).join(' · '));
      const right = p.status === 'Ready for pickup' ? '<span class="sh-pill ok">Ready</span>'
        : key ? (() => { const w = whenLabel(key, today); return `<span class="sh-right ${w.cls}">${esc(w.text)}</span>`; })() : '';
      return card('jobs', esc(String(p.title || '').trim() || [jobNo(p), who].filter(Boolean).join(' · ') || 'Untitled job'), sub, right);
    }).join('')
    : '<p class="sh-empty">Nothing promised in the next 7 days.</p>'}</section>`;

  // schedule (Job_Board's Schedule): today's drop-offs and pickups, and the week
  const dropsOn = (k) => projects.filter((p) => p && p.kind === 'customer' && p.customer && p.customer.dropOff === k);
  const picksOn = (k) => projects.filter((p) => p && p.kind === 'customer' && p.customer && p.customer.pickup === k && p.status !== 'Done');
  const tm = (t) => { if (!/^\d{1,2}:\d{2}/.test(t || '')) return ''; const [h, mi] = t.split(':').map(Number); return `${(h % 12) || 12}:${String(mi).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`; };
  const todayRows = [
    ...dropsOn(today).map((p) => ({ t: p.customer.dropTime || '', html: `<b>${delOn() && p.customer.inBy === 'collect' ? 'Pick up from ' + esc(p.customer.name || 'customer') : esc(p.customer.name || 'Customer') + ' drops off'}</b><span class="sh-sub">${esc([jobNo(p), p.machine || p.title].filter(Boolean).join(' · '))}</span>`, pick: false })),
    ...picksOn(today).map((p) => ({ t: p.customer.pickupTime || '', html: `<b>${delOn() && p.customer.ret === 'deliver' ? 'Deliver to ' + esc(p.customer.name || 'customer') : esc(p.customer.name || 'Customer') + ' picks up'}</b><span class="sh-sub">${esc([jobNo(p), p.machine || p.title, p.status === 'Ready for pickup' ? 'ready' : p.status].filter(Boolean).join(' · '))}</span>`, pick: true })),
  ].sort((a, b) => (a.t || '99').localeCompare(b.t || '99'));
  const wk = (() => { const d = new Date(today + 'T12:00:00'); const off = d.getDay(); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(today, i - off)); })();
  const weekN = wk.reduce((n, k) => n + dropsOn(k).length + picksOn(k).length, 0);
  const schedHtml = !cust ? '' : `<section aria-labelledby="h-today"><h2 class="sh-h2" id="h-today">Today <small>${esc(new Date(today + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}${dayLimit ? ` · ${dropsOn(today).length} of ${dayLimit} drop-offs` : ''}</small></h2>${todayRows.length
      ? todayRows.map((r) => `<button type="button" class="sh-card sh-sched${r.pick ? ' pick' : ''}" data-sched="${today}"><span class="sh-tm">${esc(tm(r.t) || '—')}</span><span style="flex:1;min-width:0">${r.html}</span></button>`).join('')
      : '<p class="sh-empty">No drop-offs or pickups booked today.</p>'}
    <h2 class="sh-h2" style="margin-top:12px">This week <small>${weekN} booking${weekN === 1 ? '' : 's'}</small></h2>
    <div class="sh-week">${wk.map((k) => { const n = dropsOn(k).length + picksOn(k).length; const d = new Date(k + 'T12:00:00');
      return `<button type="button" data-sched="${k}" class="${k === today ? 'today' : ''}" aria-label="${esc(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}, ${n} booking${n === 1 ? '' : 's'}"><span>${esc(d.toLocaleDateString('en-US', { weekday: 'short' }))}</span><b>${d.getDate()}</b><i aria-hidden="true">${n ? '•'.repeat(Math.min(n, 4)) + (n > 4 ? '+' : '') : ''}</i></button>`; }).join('')}</div></section>`;

  // parts
  const partLines = [
    ...jobLate.map((x) => card('jobs', `<span style="color:var(--danger)">Late:</span> ${esc(x.name || 'Part')}`, esc(`${x.job.title || 'Job'} · expected ${shortDay(String(x.expected).slice(0, 10))}`), '')),
    ...invLate.map((p) => card('parts', `<span style="color:var(--danger)">Late:</span> ${esc(p.name)}`, esc(`expected ${p.expected ? shortDay(p.expected) : '—'} · ${p.qty}${p.unit ? ' ' + p.unit : ''} on hand`), '')),
    ...reorder.slice(0, 4).map((p) => card('parts', esc(p.name), esc([p.number && '#' + p.number, `${p.qty}${p.unit ? ' ' + p.unit : ''} on hand`].filter(Boolean).join(' · ')), `<span class="sh-pill ${p.out ? 'over' : 'warn'}">${p.out ? 'Out' : 'Reorder'}</span>`)),
    ...(jobToOrder.length ? [card('jobs', `${jobToOrder.length} part${jobToOrder.length === 1 ? '' : 's'} to order for jobs`, esc([...new Set(jobToOrder.map((x) => x.job.title).filter(Boolean))].slice(0, 3).join(', ')), '<span class="sh-pill warn">Order</span>')] : []),
    ...(low.length - invLate.length - reorder.length > 0 ? [card('parts', `${low.length - invLate.length - reorder.length} on order`, 'Waiting to arrive', '<span class="sh-pill steel">Ordered</span>')] : []),
  ];
  const partsHtml = `<section aria-labelledby="h-parts"><h2 class="sh-h2" id="h-parts">Parts</h2>${partLines.length ? partLines.join('') : '<p class="sh-empty">Nothing to order. Everything is above its reorder level.</p>'}</section>`;

  // your machines
  const dueHtml = `<section aria-labelledby="h-due"><h2 class="sh-h2" id="h-due">Your machines</h2>${due.length
    ? due.map((m) => card('machines', esc(m.machine), esc(`${m.item}${m.detail ? ' · ' + m.detail : ''}`), `<span class="sh-pill ${m.state === 'over' ? 'over' : 'warn'}">${m.state === 'over' ? 'Overdue' : 'Soon'}</span>`)).join('')
    : '<p class="sh-empty">No maintenance coming due.</p>'}</section>`;

  const scroll = box.scrollTop;
  const mine = shopOf ? open.filter((p) => p.assignee && p.assignee === shopOf.memberId) : [];
  const myJobs = shopOf ? `<section aria-labelledby="h-mine"><h2 class="sh-h2" id="h-mine">My jobs <small>${mine.length}</small></h2>${mine.length
      ? mine.map((p) => { const left = (p.tasks || []).filter((t) => !t.done).length; const pr = p.customer && p.customer.promised ? whenLabel(String(p.customer.promised).slice(0, 10), today) : null;
        return card('jobs', esc([jobNo(p), String(p.title || '').trim() || (p.customer && p.customer.name) || ''].filter(Boolean).join(' · ') || 'Untitled job'), esc([p.machine && p.machine !== p.title ? p.machine : '', left ? `${left} task${left === 1 ? '' : 's'} left` : 'all tasks done', p.status].filter(Boolean).join(' · ')), pr ? `<span class="sh-right ${pr.cls}">${esc(pr.text)}</span>` : ''); }).join('')
      : '<p class="sh-empty">Nothing assigned to you right now.</p>'}</section>` : '';
  const waiting = canApproveTime() ? projects.flatMap((p) => tlog(p).filter((e) => e && e.ok === false && !e.rejected && (e.manual || e.end)).map((e) => ({ p, e }))) : [];
  const nameOfP = (id) => { const list = shopOf ? peopleOf : [{ id: 'owner', name: user.displayName || 'You' }, ...team.members]; const x = list.find((q) => q.id === (id || 'owner')); return x ? x.name : 'Someone'; };
  const approveHtml = waiting.length ? `<section aria-labelledby="h-ok"><h2 class="sh-h2" id="h-ok">Time to approve <small>${waiting.length} · ${dur(waiting.reduce((n, w) => n + tMsOf(w.e), 0))}</small></h2>
      ${waiting.slice(0, 8).map(({ p, e }) => `<div class="sh-card"><span style="flex:1;min-width:0"><b>${esc(nameOfP(e.by))} · ${dur(tMsOf(e))}</b><span class="sh-sub">${esc([jobNo(p), p.title].filter(Boolean).join(' '))} · ${esc(e.manual ? (e.date || '') : dayKey(e.start))}${e.manual ? ' · added by hand' : ''}${e.note ? ' · ' + esc(e.note) : ''}</span></span>${e.manual ? '<span class="sh-pill warn">By hand</span>' : ''}</div>`).join('')}
      <button type="button" class="sh-btn" data-okall>Approve all ${waiting.length}</button><p class="sh-foot" id="shOkMsg" role="status" style="margin:0">To check one first, open its job in Job_Board.</p></section>` : '';
  const note = leftMsg ? `<p class="sh-empty" role="status">${esc(leftMsg)} You're back in your own shop.</p>` : '';
  const inShop = shopOf ? `<p class="sh-foot" style="margin:0">You're in <b>${esc(shopOf.shopName || 'the shop')}</b> as ${esc((ROLES[shopOf.role] || ROLES.tech).label)}.</p>`
    : awayFrom ? `<p class="sh-foot" style="margin:0">Your own garage · <button type="button" class="sh-linkbtn" style="color:var(--accent);min-height:0;font-size:inherit" data-toshop>Switch to ${esc(awayFrom.shopName || 'the shop')}</button></p>` : '';
  box.innerHTML = note + inShop + shopClockHtml() + approveHtml + myJobs + clock + stats + schedHtml + comingHtml + partsHtml + (shopOf ? '' : dueHtml)
    + `<p class="sh-foot">Beta: Jobs, Machines and Parts are your Job_Board and Logbook, so everything you do there shows here.</p>`;
  box.scrollTop = scroll;
}

const inviteLater = () => { try { return sessionStorage.getItem('gt-join-later') === (pendingInvite && pendingInvite.owner); } catch { return false; } };
$('p-home').addEventListener('click', async (e) => {
  if (e.target.closest('[data-toshop]')) { setAway(null); startData(); return; }
  if (e.target.closest('[data-retry]')) { loadErr = ''; renderHome(); startData(); return; }
  if (e.target.closest('[data-okall]')) {
    const owner = shopOf ? shopOf.owner : user.uid, now = new Date().toISOString(); let n = 0;
    try {
      for (const p of projects) {
        const log = tlog(p); if (!log.some((x) => x && x.ok === false && !x.rejected && (x.manual || x.end))) continue;
        const next = log.map((x) => (x && x.ok === false && !x.rejected && (x.manual || x.end) ? (n++, { ...x, ok: true, okBy: myPid(), okAt: now }) : x));
        await setDoc(doc(db, 'logbook', owner, 'projects', p.id), { time: { log: next } }, { merge: true });
      }
    } catch (err) { const m = $('shOkMsg'); if (m) m.textContent = "Couldn't approve: " + (err.message || err.code); return; }
    return;
  }
  if (e.target.closest('[data-joinlater]')) { try { sessionStorage.setItem('gt-join-later', pendingInvite.owner); } catch { /* fine */ } renderHome(); return; }
  if (e.target.closest('[data-join]') && pendingInvite) {
    const inv = pendingInvite;
    try {
      await setDoc(doc(db, 'shops', inv.owner, 'members', user.uid), { email: inv.email, name: String(user.displayName || inv.name || '').slice(0, 60), role: inv.role, perms: inv.perms, memberId: inv.memberId, joinedAt: serverTimestamp() });
      leftMsg = ''; await startData(); renderHome();
    } catch (err) { const m = $('shJoinMsg'); if (m) m.textContent = "Couldn't join: " + (err.message || err.code) + '. Ask the owner to check your email on their team list, and that Employees is on.'; }
    return;
  }
  const s = e.target.closest('[data-sched]');
  // a day opens Job_Board's Schedule on that day
  if (s) { frameFor('jobs').src = '/apps/job-board?shop=1&sched=' + encodeURIComponent(s.dataset.sched); show('jobs'); return; }
  const b = e.target.closest('[data-go]');
  if (b) show(b.dataset.go);
});
setInterval(() => { if (tab === 'home' && user && records && projects && !document.hidden) renderHome(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderHome(); });

// ---------- tools ------------------------------------------------------------------------

const TOOLS = [
  { id: 'torque', name: 'Torque Chart', sub: 'SAE + metric, bolt grades, unit converter', href: '/apps/torque-chart?shop=1',
    icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"></path>' },
  { id: 'fuel', name: 'Fuel Mix', sub: '2-stroke oil for any can and ratio', href: '/apps/fuel-mix?shop=1',
    icon: '<path d="M6 8l3-4h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"></path><path d="M10 11h5M10 15h5"></path>' },
  { id: 'plugs', name: 'Spark Plug Finder', sub: 'Cross-reference any plug to NGK; plug + gap by machine', href: '/apps/spark-plugs?shop=1',
    icon: '<path d="M10 2h4v3h-4zM9 5h6l-1 7h-4zM8 12h8v3H8zM10 15h4v4h-4zM12 19v3"></path>' },
  { id: 'tap', name: 'Tap Drill Chart', sub: 'Drill size for any tap', href: '/apps/tap-drill-chart?shop=1',
    icon: '<path d="M12 3v12M8 7l4-4 4 4M7 15h10l-2 6H9z"></path>' },
];

function renderTools() {
  const box = $('p-tools');
  box.className = 'sh-panel sh-scroll';
  box.innerHTML = `
    ${TOOLS.map((t) => `<button type="button" class="sh-card sh-tool" data-tool="${t.id}">
      <span class="sh-ticon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#eaf2fb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span>
      <span class="sh-tbody"><b>${t.name}</b><span class="sh-sub">${t.sub}</span></span><span class="sh-right" aria-hidden="true">&gt;</span></button>`).join('')}
    <p class="sh-foot">The charts work with no signal once they've been opened.</p>`;
}

$('p-tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) {
    const t = TOOLS.find((x) => x.id === b.dataset.tool);
    const box = $('p-tools');
    box.className = 'sh-panel sh-framebox';
    box.innerHTML = `<div class="sh-toolbar"><button type="button" class="sh-back" data-toolsback>&lt; Tools</button></div>`;
    const f = document.createElement('iframe');
    f.className = 'sh-frame'; f.title = t.name; f.src = t.href;
    box.append(f);
    return;
  }
  if (e.target.closest('[data-toolsback]')) renderTools();
});

// ---------- settings ---------------------------------------------------------------------

function teamSection() {
  if (shopOf) {
    return `<section class="sh-set" aria-labelledby="h-team"><h2 class="sh-h2" id="h-team">Your shop</h2>
      <p class="sh-setnow">You're in ${esc(shopOf.shopName || 'the shop')} as ${esc((ROLES[shopOf.role] || ROLES.tech).label)}.</p>
      <p class="sh-foot" style="margin:0">${esc(shopOf.ownerName || 'The owner')} manages the team. Your own Logbook (garageterminal.com/apps/logbook) stays yours.</p>
      <div class="sh-formbtns"><button type="button" class="sh-btn" data-toown>Switch to my own garage</button><button type="button" class="sh-btn ghost" data-leaveshop>Leave this shop</button></div>
      <p class="sh-foot" style="margin:0">Switch to my own garage opens your own machines, jobs and parts on this device; you stay signed in and on the team, and can switch back any time.</p></section>`;
  }
  if (awayFrom) {
    return `<section class="sh-set" aria-labelledby="h-team"><h2 class="sh-h2" id="h-team">Your shop</h2>
      <p class="sh-setnow">You're in your own garage.</p>
      <p class="sh-foot" style="margin:0">You're still on the team at ${esc(awayFrom.shopName || 'the shop')} as ${esc((ROLES[awayFrom.role] || ROLES.tech).label)}.</p>
      <button type="button" class="sh-btn" data-toshop>Switch to ${esc(awayFrom.shopName || 'the shop')}</button></section>`;
  }
  const me = user ? (user.displayName || user.email || 'You') : 'You';
  const head = `<div class="sh-setrow"><h2 class="sh-h2" id="h-team">Employees</h2>
      <button type="button" class="sh-switch${team.on ? ' on' : ''}" role="switch" aria-checked="${team.on}" aria-labelledby="h-team" data-teamon><span></span></button></div>`;
  if (!team.on) {
    return `<section class="sh-set" aria-labelledby="h-team">${head}
      <p class="sh-setnow">Off: it's just you.</p>
      <p class="sh-foot" style="margin:0">Nothing about employees shows anywhere: no Assigned to, no Done by, no people to manage. Turn it on to add the people who work in your shop.${team.members.length ? ` Your ${team.members.length} saved ${team.members.length === 1 ? 'person is' : 'people are'} kept for when you turn it back on.` : ''}</p></section>`;
  }
  const row = (m) => `<button type="button" class="sh-card sh-person" data-member="${esc(m.id)}"><span class="sh-av">${esc(initials(m.name))}</span>
      <span style="flex:1;min-width:0"><b>${esc(m.name || 'No name')}</b><span class="sh-sub">${esc(ROLES[m.role] ? ROLES[m.role].label : 'Tech')} · ${esc(m.email)}</span></span>
      <span class="sh-pill ${joinedBy[m.id] ? 'ok' : inviteErr[m.id] ? 'over' : 'warn'}">${joinedBy[m.id] ? 'Joined' : inviteErr[m.id] ? 'Problem' : 'Invited'}</span></button>
      ${inviteErr[m.id] ? `<p class="sh-foot" style="margin:-2px 0 4px;color:var(--danger)">${esc(m.name)}: ${esc(inviteErr[m.id])}</p>` : joinedBy[m.id] ? '' : `<div class="sh-invrow"><a class="sh-btn ghost" href="${esc(inviteMail(m))}">Email the invite</a><button type="button" class="sh-btn ghost" data-copyinv="${esc(m.id)}">Copy invite</button></div>`}`;
  const can = (role) => PERMS.filter(([k]) => permsOf(role)[k]).map(([, l]) => l.toLowerCase()).join(', ') || 'nothing more';
  const form = (m) => { const role = (m && m.role) || 'tech';
    return `<form class="sh-teamform" data-teamform="${m ? esc(m.id) : 'new'}">
      <b>${m ? 'Edit ' + esc(m.name || 'employee') : 'Add an employee'}</b>
      <label>Name<input name="name" required maxlength="60" value="${esc(m ? m.name : '')}" autocomplete="off"></label>
      <label>Their Google email<input name="email" type="email" required maxlength="120" value="${esc(m ? m.email : '')}" autocomplete="off" inputmode="email"></label>
      <fieldset class="sh-roles"><legend>Role</legend>${Object.entries(ROLES).map(([k, r]) => `<label class="sh-role"><input type="radio" name="role" value="${k}" ${k === role ? 'checked' : ''}><span><b>${r.label}</b><span class="sh-sub">${r.does}. Also: ${esc(can(k))}.</span></span></label>`).join('')}</fieldset>
      <p class="sh-foot" style="margin:0">What each role can see and do is set below, under What each role can do.</p>
      <div class="sh-formbtns"><button type="submit" class="sh-btn">${m ? 'Save' : 'Add'}</button><button type="button" class="sh-btn ghost" data-teamcancel>Cancel</button></div>
      ${m ? `<button type="button" class="sh-linkbtn" data-teamremove="${esc(m.id)}">Remove ${esc(m.name || 'this person')}</button>` : ''}
      <p class="sh-foot" id="shTeamMsg" role="status" style="margin:0"></p></form>`; };
  const editing = teamEdit && teamEdit !== 'new' ? team.members.find((m) => m.id === teamEdit) : null;
  return `<section class="sh-set" aria-labelledby="h-team">${head}
    <div class="sh-card sh-person" style="cursor:default"><span class="sh-av own">${esc(initials(me))}</span><span style="flex:1;min-width:0"><b>${esc(me)}</b><span class="sh-sub">Owner · this shop's data is on your account</span></span></div>
    ${team.members.map((m) => (editing && editing.id === m.id ? form(m) : row(m))).join('')}
    ${teamEdit === 'new' ? form(null) : `<button type="button" class="sh-btn ghost" data-teamadd>+ Add an employee</button>`}
    <p class="sh-foot" style="margin:0">Each person signs in at garageterminal.com/shop with the Google email you entered here, then taps Join. They see your shop's jobs, machines and parts; their role decides what they can change.</p>
    <div class="sh-opts"><b>What each role can do</b>
      <p class="sh-foot" style="margin:0 0 4px">Everyone with that role follows it; changes reach them right away. Every role can work jobs, clock in, add machines and log services, and take parts off the shelf.</p>
      ${Object.entries(ROLES).map(([k, r]) => { const n = team.members.filter((m) => m.role === k).length; const open = roleOpen === k;
        return `<div class="sh-rolebox"><button type="button" class="sh-rolehead" data-roleopen="${k}" aria-expanded="${open}"><b>${r.label}</b><span class="sh-sub">${n} ${n === 1 ? 'person' : 'people'} · ${PERMS.filter(([p]) => permsOf(k)[p]).length} of ${PERMS.length} on</span><span aria-hidden="true">${open ? '▴' : '▾'}</span></button>
          ${open ? `<div class="sh-perms">${PERMS.map(([p, l]) => `<label><input type="checkbox" data-roleperm="${k}.${p}" ${permsOf(k)[p] ? 'checked' : ''}> ${l}</label>`).join('')}<button type="button" class="sh-linkbtn" style="color:var(--steel)" data-roledefault="${k}">Back to the usual for ${r.label}</button></div>` : ''}</div>`; }).join('')}
    </div>
    <div class="sh-opts"><b>Turn on</b>${OPTS.map(([k, l]) => `<label><input type="checkbox" data-teamopt="${k}" ${team.options[k] ? 'checked' : ''}> ${l}</label>`).join('')}
      <p class="sh-foot" style="margin:0">Your own time never needs approval. Hiding My equipment also hides your own machines from them in Machines.</p></div>
    <p class="sh-foot" style="margin:0">Turning Employees off hides all of this. Nothing is deleted.</p></section>`;
}
const inviteText = (m) => `${(user && user.displayName) || 'I'} added you to ${myShopName()} on Garage Terminal. Open https://garageterminal.com/shop, sign in with Google as ${m.email}, and tap Join.`;
const inviteMail = (m) => `mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent('Join ' + myShopName() + ' on Garage Terminal')}&body=${encodeURIComponent(inviteText(m))}`;
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

// Account: who's signed in, Sign out and Switch account, so the installed app never needs the website
function accountSection() {
  if (!user) return '';
  const name = user.displayName || 'Signed in';
  return `<section class="sh-set" aria-labelledby="h-acct"><h2 class="sh-h2" id="h-acct">Account</h2>
    <div class="sh-card sh-person" style="cursor:default"><span class="sh-av own">${esc(initials(name))}</span><span style="flex:1;min-width:0"><b>${esc(name)}</b><span class="sh-sub">${esc(user.email || '')}${shopOf ? ' · in ' + esc(shopOf.shopName || 'a shop') : ''}</span></span></div>
    <div class="sh-formbtns"><button type="button" class="sh-btn ghost" data-switchacct>Switch account</button><button type="button" class="sh-btn ghost" data-signout>Sign out</button></div>
    <p class="sh-foot" id="shAcctMsg" role="status" style="margin:0">Signing out here signs this device out of all of Garage Terminal (Logbook, Job_Board and the other apps too).</p></section>`;
}

function renderSettings() {
  const on = custOn();
  $('p-settings').innerHTML = accountSection() + (shopOf ? '' : `<section class="sh-set" aria-labelledby="h-shopmode">
      <div class="sh-setrow">
        <h2 class="sh-h2" id="h-shopmode">Shop mode</h2>
        <button type="button" class="sh-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-labelledby="h-shopmode" data-shopmode><span></span></button>
      </div>
      <p class="sh-setnow">${on ? 'On: set up for working on other people\'s machines.' : 'Off: just your own machines, projects, parts and tools.'}</p>
      <div class="sh-setlist">
        <b>Shop mode turns on</b>
        <ul>
          <li><b>Customer jobs</b> in Jobs, with job numbers, promised dates and Ready for pickup</li>
          <li>The <b>customer list</b>: name, phone, address and every job they've had</li>
          <li><b>Invoices, work reports and receipts</b> (PDF, print, receipt printer), with Notes for the customer</li>
          <li><b>Labor clock</b> and labor rate on jobs</li>
          <li><b>Shop info</b>: your shop's name, address and phone on invoices</li>
          <li><b>Inventory check on customer jobs</b>: which of their parts are on your shelf</li>
          <li><b>Scheduling</b>: drop-offs and pickups on a week view in Job_Board, and Today + This week on Home</li>
          <li><b>Coming up</b> on Home: promised dates and pickups for the next 7 days</li>
        </ul>
      </div>
      <p class="sh-foot">Turning it off hides customer jobs; nothing is deleted, and they come back when you turn it on. Saved on this device, and the same switch as Customer jobs in Job_Board's ⚙ Settings. The Morning Brief has its own "Include Job_Board customer jobs" box.</p>
    </section>`) + `
    ${teamSection()}
    ${clocksSection()}
    ${on && (!shopOf || shopOf.perms.settings) ? `<section class="sh-set" aria-labelledby="h-limit">
      <h2 class="sh-h2" id="h-limit">Daily drop-off limit</h2>
      <form class="sh-limit" data-limit><label for="shLimit" class="sh-foot" style="margin:0">Booking a drop-off warns when a day already has this many. It never blocks. Leave empty for no limit.</label>
        <div class="sh-limitrow"><input id="shLimit" type="number" min="1" max="99" step="1" inputmode="numeric" value="${dayLimit || ''}" placeholder="No limit"><button type="submit" class="sh-btn ghost">Save</button></div>
        <p class="sh-foot" id="shLimitMsg" role="status" style="margin:0"></p></form>
    </section>
    <section class="sh-set" aria-labelledby="h-deliv">
      <div class="sh-setrow"><span style="flex:1;min-width:0"><b id="h-deliv">Pickup and delivery</b><span class="sh-sub">Jobs get "How it comes in" (they drop it off, or you pick it up) and "How it goes back" (they pick it up, or you deliver it). Shows on the Schedule.</span></span><button type="button" class="sh-switch${del.delivery ? ' on' : ''}" role="switch" aria-checked="${del.delivery}" aria-label="Pickup and delivery" data-delsw="delivery"><span></span></button></div>
      ${del.delivery ? `<div class="sh-setrow"><span style="flex:1;min-width:0"><b>Delivery fees</b><span class="sh-sub">Charge per mile for each pickup or delivery trip. It goes on the invoice as its own line.</span></span><button type="button" class="sh-switch${del.delivFees ? ' on' : ''}" role="switch" aria-checked="${del.delivFees}" aria-label="Delivery fees" data-delsw="delivFees"><span></span></button></div>` : ''}
      ${del.delivery && del.delivFees ? `<form class="sh-delform" data-delfees>
        <label>Rate, $ per mile<input type="number" name="delRate" min="0" step="0.01" inputmode="decimal" value="${del.delRate}" placeholder="1.50"></label>
        <label>Minimum per trip, $<input type="number" name="delMin" min="0" step="0.01" inputmode="decimal" value="${del.delMin}" placeholder="15"></label>
        <label>Free within (miles)<input type="number" name="delFree" min="0" step="0.5" inputmode="decimal" value="${del.delFree}" placeholder="0"></label>
        <label>Miles charged<select name="delRound"><option value="rt" ${del.delRound ? 'selected' : ''}>There and back</option><option value="one" ${del.delRound ? '' : 'selected'}>One way</option></select></label>
        <button type="submit" class="sh-btn ghost">Save delivery fees</button>
        <p class="sh-foot" id="shDelMsg" role="status" style="margin:0;grid-column:1/-1">${esc(delMsg)}</p></form>` : ''}
    </section>
    <section class="sh-set sh-soon" aria-labelledby="h-email" aria-describedby="h-email-soon">
      <div class="sh-setrow"><h2 class="sh-h2" id="h-email">Daily shop email</h2><span class="sh-pill steel" id="h-email-soon">Coming soon</span></div>
      <p class="sh-foot" style="margin:0">Your shop's day in your inbox each morning: today's drop-offs and pickups, promised and at-risk jobs, jobs ready but not picked up, job parts to order or late, and low inventory. Separate from the Morning Brief.</p>
      <fieldset disabled class="sh-soonbox">
        <label>Send to<input type="email" placeholder="Shop email address (to be set up)"></label>
        <div class="sh-limitrow"><label>Time<input type="time" value="06:30"></label><label>Days<select><option>Mon–Sat</option></select></label></div>
        <button type="button" class="sh-switch" role="switch" aria-checked="false" aria-label="Daily shop email (coming soon)"><span></span></button>
      </fieldset>
    </section>` : ''}`;
}

$('p-settings').addEventListener('submit', async (e) => {
  const tf = e.target.closest('[data-teamform]');
  if (tf) {
    e.preventDefault();
    const fd = new FormData(tf);
    const name = String(fd.get('name') || '').trim(), email = String(fd.get('email') || '').trim().toLowerCase(), role = ROLES[fd.get('role')] ? fd.get('role') : 'tech';
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $('shTeamMsg').textContent = 'Add a name and a full email address.'; return; }
    const id = tf.dataset.teamform;
    if (team.members.some((m) => m.email === email && m.id !== id) || (user && String(user.email || '').toLowerCase() === email)) { $('shTeamMsg').textContent = 'That email is already on your team.'; return; }
    const perms = permsOf(role);
    if (id === 'new') team.members.push({ id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4), name, email, role, perms, status: 'added', addedAt: new Date().toISOString() });
    else { const was = team.members.find((m) => m.id === id); if (was && lower(was.email) !== email) await dropMember(was); Object.assign(was || {}, { name, email, role, perms }); }
    teamEdit = null;
    try { await saveTeam(); } catch (err) { renderSettings(); $('p-settings').querySelector('.sh-set:nth-of-type(2) .sh-foot')?.append(" Couldn't save: " + (err.message || err.code)); return; }
    renderSettings();
    return;
  }
  const df = e.target.closest('[data-delfees]');
  if (df) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(df));
    const n = (v, r) => (+v > 0 ? Math.round(+v * r) / r : '');
    try {
      await setDoc(doc(db, 'logbook', shopOf ? shopOf.owner : user.uid, 'trackerSettings', 'shop'), { delRate: n(d.delRate, 100), delMin: n(d.delMin, 100), delFree: n(d.delFree, 10), delRound: d.delRound !== 'one' }, { merge: true });
      delMsg = 'Saved.';
    } catch (err) { delMsg = "Couldn't save: " + (err.message || err.code); }
    if ($('shDelMsg')) $('shDelMsg').textContent = delMsg;
    return;
  }
  const f = e.target.closest('[data-limit]');
  if (!f) return;
  e.preventDefault();
  const v = +$('shLimit').value;
  const n = v > 0 ? Math.min(99, Math.round(v)) : '';
  try {
    await setDoc(doc(db, 'logbook', shopOf ? shopOf.owner : user.uid, 'trackerSettings', 'shop'), { dayLimit: n }, { merge: true }); // (the shop's settings, also for a member allowed to change them)
    $('shLimitMsg').textContent = n ? `Saved: ${n} drop-offs a day.` : 'Saved: no limit.';
  } catch (err) { $('shLimitMsg').textContent = "Couldn't save: " + (err.message || err.code); }
});

$('p-settings').addEventListener('change', (e) => {
  const ot = e.target.closest('[data-othours]');
  if (ot) { const n = Math.round(+ot.value); team.options.otHours = n > 0 && n < 100 ? n : 40; saveTeam().catch(() => {}); return; }
  const o = e.target.closest('[data-teamopt]');
  if (o) { team.options[o.dataset.teamopt] = o.checked; saveTeam().catch(() => {}); return; } // saveTeam also updates shops/{me}.options
  // What each role can do: applies to everyone with that role
  const rp = e.target.closest('[data-roleperm]');
  if (rp) { const [role, k] = rp.dataset.roleperm.split('.'); team.roles = team.roles || roleDefaults(); team.roles[role] = { ...permsOf(role), [k]: rp.checked }; saveTeam().catch(() => {}); return; }
});

$('p-settings').addEventListener('click', (e) => {
  const ds = e.target.closest('[data-delsw]');
  if (ds) {
    const k = ds.dataset.delsw, v = !del[k];
    del = { ...del, [k]: v, ...(k === 'delivery' && !v ? { delivFees: false } : {}) };
    setDoc(doc(db, 'logbook', shopOf ? shopOf.owner : user.uid, 'trackerSettings', 'shop'), k === 'delivery' && !v ? { delivery: false, delivFees: false } : { [k]: v }, { merge: true }).catch(() => {});
    renderSettings(); return;
  }
  const csw = e.target.closest('[data-clocksw]');
  if (csw) { const k = csw.dataset.clocksw; team.options[k] = !(k === 'jobClocks' ? team.options.jobClocks !== false : team.options[k] === true); saveTeam().catch(() => {}); renderSettings(); renderHome(); return; }
  const t = (sel) => e.target.closest(sel);
  if (t('[data-signout]')) {
    const b = t('[data-signout]');
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to sign out'; return; }
    logOff().then(() => show('home'), (err) => { $('shAcctMsg').textContent = "Couldn't sign out: " + (err.message || err.code); });
    return;
  }
  if (t('[data-switchacct]')) {
    // sign out, then Google's account picker (prompt: select_account) for the next one
    logOff().then(() => { show('home'); return signInWithGoogle(); }).catch((err) => {
      if (err && err.code === 'auth/popup-closed-by-user') return;
      const m = $('shSignMsg') || $('shAcctMsg'); if (m) m.textContent = "Couldn't switch: " + (err.message || err.code);
    });
    return;
  }
  if (t('[data-teamon]')) { team.on = !team.on; teamEdit = null; saveTeam().catch(() => {}); renderSettings(); $('p-settings').querySelector('[data-teamon]').focus(); return; }
  if (t('[data-teamadd]')) { teamEdit = 'new'; renderSettings(); $('p-settings').querySelector('[data-teamform] input[name="name"]').focus(); return; }
  if (t('[data-member]')) { teamEdit = t('[data-member]').dataset.member; renderSettings(); $('p-settings').querySelector('[data-teamform] input[name="name"]').focus(); return; }
  if (t('[data-teamcancel]')) { teamEdit = null; renderSettings(); return; }
  if (t('[data-roleopen]')) { const k = t('[data-roleopen]').dataset.roleopen; roleOpen = roleOpen === k ? '' : k; renderSettings(); return; }
  if (t('[data-roledefault]')) { const k = t('[data-roledefault]').dataset.roledefault; team.roles = team.roles || roleDefaults(); team.roles[k] = { ...ROLES[k].perms }; saveTeam().catch(() => {}); renderSettings(); return; }
  if (t('[data-copyinv]')) { const m = team.members.find((x) => x.id === t('[data-copyinv]').dataset.copyinv); const b = t('[data-copyinv]');
    if (m) { (navigator.clipboard ? navigator.clipboard.writeText(inviteText(m)) : Promise.reject()).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Copy failed'; }); } return; }
  if (t('[data-toown]') && shopOf) { setAway(shopOf.owner); startData().then(() => show('home')); return; }
  if (t('[data-toshop]')) { setAway(null); startData().then(() => show('home')); return; }
  if (t('[data-leaveshop]')) {
    const b = t('[data-leaveshop]');
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to leave ' + (shopOf.shopName || 'the shop'); return; }
    deleteDoc(doc(db, 'shops', shopOf.owner, 'members', user.uid)).then(() => { leftMsg = 'You left ' + (shopOf.shopName || 'the shop') + '.'; startData(); show('home'); }, (err) => { b.textContent = "Couldn't leave: " + (err.code || err.message); });
    return;
  }
  if (t('[data-teamremove]')) {
    const id = t('[data-teamremove]').dataset.teamremove; const m = team.members.find((x) => x.id === id);
    if (m && t('[data-teamremove]').dataset.sure !== '1') { const b = t('[data-teamremove]'); b.dataset.sure = '1'; b.textContent = `Tap again to remove ${m.name || 'them'}`; return; }
    if (m) dropMember(m);
    team.members = team.members.filter((x) => x.id !== id); teamEdit = null; saveTeam().catch(() => {}); renderSettings(); return;
  }
  if (!e.target.closest('[data-shopmode]')) return;
  if (shopOf) return;
  setCustOn(!custOn());
  // Job_Board reads the setting when it opens: reload it if it's already open
  const f = $('p-jobs').querySelector('iframe');
  if (f) f.src = FRAMES.jobs;
  renderSettings();
  renderHome();
  $('p-settings').querySelector('[data-shopmode]').focus();
});

$('shGear').addEventListener('click', () => show(tab === 'settings' ? lastTab : 'settings'));

// Flipped inside Job_Board (Jobs tab): keep Home and Settings in step
window.addEventListener('storage', (e) => {
  if (e.key !== 'jb-customers') return;
  if (tab === 'settings') renderSettings();
  renderHome();
});

// ---------- start --------------------------------------------------------------------------

show((location.hash || '').slice(1) || 'home');
