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
import { collection, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.js';
import { finishRedirectSignIn, signInWithGoogle, watchSession } from '../lib/session.js';
import { buildBrief } from '../brief/brief.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const dayKey = (ms = Date.now()) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
// Shop mode = Job_Board's "Customer jobs" switch (same saved setting on this device, so both stay in step)
const custOn = () => { try { return localStorage.getItem('jb-customers') !== 'off'; } catch { return true; } };
const setCustOn = (on) => { try { localStorage.setItem('jb-customers', on ? 'on' : 'off'); } catch { /* private window: this visit only */ } };

// ---------- tabs ------------------------------------------------------------------------

const TITLES = { home: 'Home', jobs: 'Job_Board', machines: 'Machines', parts: 'Parts', tools: 'Tools', settings: 'Settings' };
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

function listen(uid) {
  unsubs.forEach((u) => u());
  records = null; projects = null; loadErr = '';
  const fail = (err) => { loadErr = err.message || err.code || 'unknown error'; renderHome(); };
  unsubs = [
    onSnapshot(collection(db, 'logbook', uid, 'records'), (q) => { records = q.docs.map((d) => ({ id: d.id, ...d.data() })); renderHome(); }, fail),
    onSnapshot(collection(db, 'logbook', uid, 'projects'), (q) => { projects = q.docs.map((d) => ({ id: d.id, ...d.data() })); renderHome(); }, fail),
    // Job_Board's shop info (only the daily drop-off limit is used here)
    onSnapshot(doc(db, 'logbook', uid, 'trackerSettings', 'shop'), (d) => { const v = d.exists() ? d.data() || {} : {}; dayLimit = +v.dayLimit > 0 ? Math.round(+v.dayLimit) : 0; if (tab === 'settings') renderSettings(); renderHome(); }, () => {}),
  ];
}

watchSession((s) => {
  const before = access;
  access = s.state === 'loading' ? 'loading' : s.state === 'guest' ? 'guest' : (!sysopOnly || (s.state === 'member' && s.isSysop)) ? 'ok' : 'waiting';
  document.querySelector('.sh-tabs').hidden = access !== 'ok';
  $('shGear').hidden = access !== 'ok';
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

  // schedule (Job_Board's Schedule): today's drop-offs and pickups, and the week
  const dropsOn = (k) => projects.filter((p) => p && p.kind === 'customer' && p.customer && p.customer.dropOff === k);
  const picksOn = (k) => projects.filter((p) => p && p.kind === 'customer' && p.customer && p.customer.pickup === k && p.status !== 'Done');
  const tm = (t) => { if (!/^\d{1,2}:\d{2}/.test(t || '')) return ''; const [h, mi] = t.split(':').map(Number); return `${(h % 12) || 12}:${String(mi).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`; };
  const todayRows = [
    ...dropsOn(today).map((p) => ({ t: p.customer.dropTime || '', html: `<b>${esc(p.customer.name || 'Customer')} drops off</b><span class="sh-sub">${esc([jobNo(p), p.machine || p.title].filter(Boolean).join(' · '))}</span>`, pick: false })),
    ...picksOn(today).map((p) => ({ t: p.customer.pickupTime || '', html: `<b>${esc(p.customer.name || 'Customer')} picks up</b><span class="sh-sub">${esc([jobNo(p), p.machine || p.title, p.status === 'Ready for pickup' ? 'ready' : p.status].filter(Boolean).join(' · '))}</span>`, pick: true })),
  ].sort((a, b) => (a.t || '99').localeCompare(b.t || '99'));
  const wk = (() => { const d = new Date(today + 'T12:00:00'); const off = (d.getDay() + 6) % 7; return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(today, i - off)); })();
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
  box.innerHTML = clock + stats + schedHtml + comingHtml + partsHtml + dueHtml
    + `<p class="sh-foot">Beta: Jobs, Machines and Parts are your Job_Board and Logbook, so everything you do there shows here.</p>`;
  box.scrollTop = scroll;
}

$('p-home').addEventListener('click', (e) => {
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

function renderSettings() {
  const on = custOn();
  $('p-settings').innerHTML = `<section class="sh-set" aria-labelledby="h-shopmode">
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
    </section>
    ${on ? `<section class="sh-set" aria-labelledby="h-limit">
      <h2 class="sh-h2" id="h-limit">Daily drop-off limit</h2>
      <form class="sh-limit" data-limit><label for="shLimit" class="sh-foot" style="margin:0">Booking a drop-off warns when a day already has this many. It never blocks. Leave empty for no limit.</label>
        <div class="sh-limitrow"><input id="shLimit" type="number" min="1" max="99" step="1" inputmode="numeric" value="${dayLimit || ''}" placeholder="No limit"><button type="submit" class="sh-btn ghost">Save</button></div>
        <p class="sh-foot" id="shLimitMsg" role="status" style="margin:0"></p></form>
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
  const f = e.target.closest('[data-limit]');
  if (!f) return;
  e.preventDefault();
  const v = +$('shLimit').value;
  const n = v > 0 ? Math.min(99, Math.round(v)) : '';
  try {
    await setDoc(doc(db, 'logbook', user.uid, 'trackerSettings', 'shop'), { dayLimit: n }, { merge: true });
    $('shLimitMsg').textContent = n ? `Saved: ${n} drop-offs a day.` : 'Saved: no limit.';
  } catch (err) { $('shLimitMsg').textContent = "Couldn't save: " + (err.message || err.code); }
});

$('p-settings').addEventListener('click', (e) => {
  if (!e.target.closest('[data-shopmode]')) return;
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
