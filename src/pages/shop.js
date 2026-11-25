// /shop: Garage Terminal as one shop app (beta).
//
//  Home      built here, live from the same records the Logbook and Job_Board use
//            (logbook/{uid}/records and logbook/{uid}/projects), with the Morning Brief's
//            rules for low parts and maintenance due (src/brief/brief.js)
//  Jobs      /apps/job-board?shop=1             (Job_Board in shop mode)
//  Machines  /apps/logbook?shop=1&view=machines (Logbook: engines, vehicles, Due)
//  Parts     /apps/logbook?shop=1&view=parts    (Logbook inventory)
//  Tools     quick torque here; Torque Chart, Fuel Mix, Tap Drill Chart open inside
//
// The framed pages are this site's own (firebase.json allows same-site framing only).
// Nothing is copied: a change in the shop app shows in the Logbook and Job_Board and back.
//
// SYSOP ONLY for now (beta): anyone else signed in sees "coming soon", and the tabs
// don't open. To open it to everyone later, make sysopOnly false.
// (This only hides the app; each member's records are protected by firestore.rules anyway.)
const sysopOnly = true;

import { onAuthStateChanged } from 'firebase/auth';
import { collection, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.js';
import { finishRedirectSignIn, signInWithGoogle, watchSession } from '../lib/session.js';
import { buildBrief } from '../brief/brief.js';
import { parseBolt, torqueFor, convert, fmt } from '../torque/calc.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const dayKey = (ms = Date.now()) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
const custOn = () => { try { return localStorage.getItem('jb-customers') !== 'off'; } catch { return true; } };

// ---------- tabs ------------------------------------------------------------------------

const TITLES = { home: 'Home', jobs: 'Jobs', machines: 'Machines', parts: 'Parts', tools: 'Tools' };
const FRAMES = {
  jobs: '/apps/job-board?shop=1',
  machines: '/apps/logbook?shop=1&view=machines',
  parts: '/apps/logbook?shop=1&view=parts',
};
let tab = 'home';

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
  tab = name;
  $('shTitle').textContent = TITLES[name];
  for (const t of Object.keys(TITLES)) $('p-' + t).hidden = t !== name;
  for (const b of document.querySelectorAll('.sh-tabs [data-tab]')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (FRAMES[name]) frameFor(name);
  if (name === 'home') renderHome();
  if (name === 'tools' && !$('p-tools').childElementCount) renderTools();
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

function listen(uid) {
  unsubs.forEach((u) => u());
  records = null; projects = null; loadErr = '';
  const fail = (err) => { loadErr = err.message || err.code || 'unknown error'; renderHome(); };
  unsubs = [
    onSnapshot(collection(db, 'logbook', uid, 'records'), (q) => { records = q.docs.map((d) => ({ id: d.id, ...d.data() })); renderHome(); }, fail),
    onSnapshot(collection(db, 'logbook', uid, 'projects'), (q) => { projects = q.docs.map((d) => ({ id: d.id, ...d.data() })); renderHome(); }, fail),
  ];
}

watchSession((s) => {
  const before = access;
  access = s.state === 'loading' ? 'loading' : s.state === 'guest' ? 'guest' : (!sysopOnly || (s.state === 'member' && s.isSysop)) ? 'ok' : 'waiting';
  document.querySelector('.sh-tabs').hidden = access !== 'ok';
  if (access === 'ok' && before !== 'ok' && user) listen(user.uid);
  if (access !== 'ok') { unsubs.forEach((x) => x()); unsubs = []; records = projects = null; show('home'); }
  renderHome();
});

onAuthStateChanged(auth, (u) => {
  const was = user && user.uid;
  user = u;
  if (u && access === 'ok') listen(u.uid);
  else { unsubs.forEach((x) => x()); unsubs = []; records = projects = null; }
  // pages already open in a tab sign in or out with the app
  if ((u && u.uid) !== was) for (const n of Object.keys(FRAMES)) { const f = $('p-' + n).querySelector('iframe'); if (f) f.src = FRAMES[n]; }
  renderHome();
});
finishRedirectSignIn().catch(() => { /* shown as signed out */ });

// ---------- home ------------------------------------------------------------------------

// job parts (p.parts) plus parts on each task (t.parts), like Job_Board's allParts
const allParts = (p) => [
  ...(Array.isArray(p.parts) ? p.parts : []),
  ...(Array.isArray(p.tasks) ? p.tasks : []).flatMap((t) => (t && Array.isArray(t.parts) ? t.parts : [])),
];
const running = (p) => (p && p.time && Array.isArray(p.time.log) ? p.time.log : []).find((e) => e && !e.manual && !e.end && e.start);
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

function renderHome() {
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
  if (loadErr) { box.innerHTML = `<p class="sh-empty">Couldn't load your shop: ${esc(loadErr)}</p>`; return; }
  if (!records || !projects) { box.innerHTML = '<p class="sh-muted sh-pad">Loading your shop…</p>'; return; }

  const today = dayKey();
  const cust = custOn();
  const open = projects.filter((p) => p && p.status !== 'Done' && (cust || p.kind !== 'customer'));
  const brief = buildBrief({ records, projects: [], nowMs: Date.now(), tz: TZ, sections: { lowStock: true, maintenance: true, projects: false } });
  const low = brief.sections.lowStock || [];
  const due = (brief.sections.maintenance || []).slice(0, 4);

  // the clock
  const rj = open.map((p) => [p, running(p)]).find(([, r]) => r);
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
      return card('jobs', esc(p.title || 'Untitled job'), sub, right);
    }).join('')
    : '<p class="sh-empty">Nothing promised in the next 7 days.</p>'}</section>`;

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
  box.innerHTML = clock + stats + comingHtml + partsHtml + dueHtml
    + `<p class="sh-foot">Beta: Jobs, Machines and Parts are your Job_Board and Logbook, so everything you do there shows here.</p>`;
  box.scrollTop = scroll;
}

$('p-home').addEventListener('click', (e) => {
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
  { id: 'tap', name: 'Tap Drill Chart', sub: 'Drill size for any tap', href: '/apps/tap-drill-chart?shop=1',
    icon: '<path d="M12 3v12M8 7l4-4 4 4M7 15h10l-2 6H9z"></path>' },
];

function renderTools() {
  const box = $('p-tools');
  box.className = 'sh-panel sh-scroll';
  box.innerHTML = `<div class="sh-quick">
      <label for="shBolt">Quick torque · Grade 5 / class 8.8, dry
        <input id="shBolt" type="text" inputmode="text" autocomplete="off" spellcheck="false" value="3/8-16" placeholder="3/8-16, M10…"></label>
      <div class="sh-qrow" id="shQ" aria-live="polite"></div>
    </div>
    ${TOOLS.map((t) => `<button type="button" class="sh-card sh-tool" data-tool="${t.id}">
      <span class="sh-ticon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#eaf2fb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span>
      <span class="sh-tbody"><b>${t.name}</b><span class="sh-sub">${t.sub}</span></span><span class="sh-right" aria-hidden="true">&gt;</span></button>`).join('')}
    <p class="sh-foot">The charts work with no signal once they've been opened.</p>`;
  const inp = $('shBolt');
  const draw = () => {
    const p = parseBolt(inp.value);
    if (!p.row) { $('shQ').innerHTML = `<span class="sh-qalt">${p.kind === 'empty' ? 'Type a bolt size.' : 'No match. Try 3/8-16, #10-32 or M10.'}</span>`; return; }
    const g = p.kind === 'sae' ? '5' : '8.8';
    const dry = torqueFor(p.row, g, 'dry').nm, oil = torqueFor(p.row, g, 'oiled').nm;
    $('shQ').innerHTML = `<span class="sh-qbig">${fmt(convert(dry, 'N·m', 'ft-lb'))}</span><span>ft-lb</span>
      <span class="sh-qalt">${esc(p.row.label)} · ${fmt(dry)} N·m · oiled ${fmt(convert(oil, 'N·m', 'ft-lb'))} ft-lb</span>`;
  };
  inp.addEventListener('input', draw);
  draw();
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

// ---------- start --------------------------------------------------------------------------

show((location.hash || '').slice(1) || 'home');
