// bbs.js (page): The Garage_Terminal BBS at /bbs.
//
// Two halves:
//   1. The way in (log-in screen, design: reference/bbs-design/Login.dc.html)
//        not signed in        -> "Who's at the door?" + Sign in with Google
//        no handle yet        -> the site's own handle step (/join?next=/bbs)
//        passcode switched on -> "Enter the passcode" (checked by the bbsKnock function)
//        asked                -> "Hang tight" until the sysop lets them in
//        denied (30 days)     -> when they can knock again
//   2. Inside (members and the sysop): tabs Boards · Files · Chat · Crew, chosen by
//      the address. Each section lives in src/bbs/:
//        #boards            home: notice, board tiles, latest files, who's here   home.js
//        #boards/<id>       one board's threads                                   board.js
//        #t/<id>            a thread                                              thread.js
//        #new[/<board>]     a new post                                            compose.js
//        #files             the file cabinet                                      files.js
//        #chat              Shop Talk (live chat)                                 chat.js
//        #crew              private messages + the member list                    crew.js
//        #dm/<uid>          a private conversation (only the two can read it)     dm.js
//      Boards, threads, files, the crew and settings are kept live in `ctx`; the open
//      view sets ctx.refresh to redraw when they change.
//
// Nothing here is security: firestore.rules decide what a person can read or write.

import { watchSession, signInWithGoogle, finishRedirectSignIn, logOff } from '../lib/session.js';
import {
  bbsAction, knock, getConfig, watchConfig, getMember, watchMember, getRequest, watchRequest, getDenied, askToJoin,
  touch, watchCrew, byRank,
} from '../lib/bbs.js';
import { el } from '../lib/ui.js';
import { Timestamp } from 'firebase/firestore';
import { renderHome } from '../bbs/home.js';
import { renderBoard } from '../bbs/board.js';
import { renderThread } from '../bbs/thread.js';
import { renderNew } from '../bbs/compose.js';
import { renderFiles } from '../bbs/files.js';
import { renderCrew } from '../bbs/crew.js';
import { renderDm, watchConvs, isUnread, isHidden } from '../bbs/dm.js';
import { renderChat } from '../bbs/chat.js';
import { getReads, isNewThread, markRead, watchBoards, watchChat, watchFiles, watchRecentThreads } from '../bbs/data.js';

const $ = (id) => document.getElementById(id);

// Chat screens (Shop Talk, private messages) fill the screen with the typing box at the bottom.
// When the phone keyboard opens, Android Chrome (and iPhone Safari) only shrink the *visible*
// area, so the box ended up behind the keyboard with no way to scroll to it. Track the visible
// height (above the keyboard) in --b-vvh, keep the page at the top, and keep the newest
// messages in view while the keyboard opens and closes.
(function fitAboveKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  let raf = 0;
  const fit = () => {
    raf = 0;
    const root = document.documentElement;
    root.style.setProperty('--b-vvh', `${Math.round(vv.height)}px`);
    if (!document.body.classList.contains('chatmode')) return;
    if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
    const log = document.querySelector('.chatlog');
    if (log && log.dataset.atBottom !== '0') log.scrollTop = log.scrollHeight;
  };
  const soon = () => { if (!raf) raf = requestAnimationFrame(fit); };
  vv.addEventListener('resize', soon);
  vv.addEventListener('scroll', soon);
  // Remember whether the log was at the bottom before the keyboard moved it.
  document.addEventListener('scroll', (e) => {
    const log = e.target;
    if (log instanceof Element && log.classList.contains('chatlog')) {
      log.dataset.atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80 ? '1' : '0';
    }
  }, true);
  fit();
})();
const main = $('b-main');

/** The tabs: [address, label]. */
const SECTIONS = [['boards', 'Boards'], ['files', 'Files'], ['chat', 'Chat'], ['crew', 'Crew']];
/** Addresses: first part of the hash -> [tab, render(ctx, rest)]. */
const ROUTES = {
  boards: ['boards', (ctx, rest) => (rest[0] ? renderBoard(ctx, rest) : renderHome(ctx))],
  t: ['boards', renderThread],
  new: ['boards', renderNew],
  files: ['files', renderFiles],
  chat: ['chat', renderChat],
  crew: ['crew', renderCrew],
  dm: ['crew', renderDm],
};

let session = { state: 'loading' };
let phase = ''; // what's on screen: 'login:<step>' or 'in'
const stops = []; // listeners to stop when the person changes
const stopAll = () => { while (stops.length) { try { stops.pop()(); } catch { /* already stopped */ } } };

// ---------- the way in ------------------------------------------------------------------

const GOOGLE_ICON = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 12.2c0-.6-.1-1.2-.2-1.7H12v3.3h4.5a4 4 0 0 1-1.7 2.6v2.1h2.8c1.6-1.5 2.4-3.7 2.4-6.3z"/><path d="M12 20.5c2.3 0 4.2-.8 5.6-2l-2.8-2.1c-.8.5-1.7.8-2.8.8-2.2 0-4-1.5-4.7-3.4H4.4v2.2A8.5 8.5 0 0 0 12 20.5z"/></svg>';

function chrome(inside) {
  $('b-eyebrow').textContent = inside ? 'MEMBERS ONLY · BAY 01' : 'PRIVATE · MEMBERS ONLY';
  $('b-tabs').hidden = !inside;
  $('b-foot').hidden = !inside;
  if (!inside) { $('b-here').hidden = true; $('b-title').textContent = 'The Garage_Terminal BBS'; }
}

/** The log-in screen: modem lines, the step bar, then one step. */
function loginScreen(step, passcodeOn, ...content) {
  chrome(false);
  const labels = passcodeOn ? ['1 · Sign in', '2 · Passcode', '3 · Wait'] : ['1 · Sign in', '2 · Wait'];
  const at = { signin: 0, passcode: 1, wait: passcodeOn ? 2 : 1 }[step] ?? 0;
  const ol = el('ol', { class: 'steps', 'aria-label': 'Steps', style: `grid-template-columns:repeat(${labels.length},minmax(0,1fr))` },
    ...labels.map((l, i) => el('li', { class: i === at ? 'now' : i < at ? 'done' : '', 'aria-current': i === at ? 'step' : false }, l)));
  const modem = el('p', { class: 'modem' }, 'ATDT GARAGE_TERMINAL', el('br'), el('span', { class: 'ok' }, 'CONNECT 2400/ARQ ... OK'));
  main.replaceChildren(el('div', { class: 'login', style: 'display:flex;flex-direction:column;gap:18px' }, modem, ol, el('section', {}, ...content)));
  phase = `login:${step}`;
}

const backLink = () => el('a', { class: 'link', href: '/' }, '[ esc ] back to the site');
const backButton = () => el('a', { class: 'btn', href: '/', style: 'min-height:48px' }, 'Back to Garage Terminal');

function showSignIn(passcodeOn, error = '') {
  const err = el('p', { class: 'err', role: 'alert' }, error);
  err.hidden = !error;
  const g = el('button', { class: 'gbtn', type: 'button' });
  g.innerHTML = GOOGLE_ICON;
  g.append('Sign in with Google');
  g.addEventListener('click', async () => {
    err.hidden = true;
    try { await signInWithGoogle(); } catch (e) {
      const c = e?.code || '';
      if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return;
      err.textContent = c === 'auth/popup-blocked' ? 'Your browser blocked the sign-in window. Allow pop-ups and try again.' : 'Sign-in didn’t work. Try again.';
      err.hidden = false;
    }
  });
  loginScreen('signin', passcodeOn,
    el('h2', {}, 'Who’s at the door?'),
    el('p', { class: 'muted' }, 'Sign in with Google so the sysop knows who’s asking. Nobody else sees your email.'),
    g, err, backLink());
}

function showPickHandle(passcodeOn) {
  loginScreen('signin', passcodeOn,
    el('h2', {}, 'Pick a handle first'),
    el('p', { class: 'muted' }, 'The BBS knows you by your Garage Terminal handle. Pick one, and you’ll come straight back here.'),
    el('a', { class: 'btn primary big', href: '/join?next=%2Fbbs' }, 'Pick a handle'),
    backLink());
}

function whoCard(handle) {
  const sw = el('button', { class: 'link', type: 'button', style: 'min-height:24px;font-size:13px', onclick: () => logOff() }, 'Switch account');
  return el('div', { class: 'who' },
    el('span', { class: 'avatar', 'aria-hidden': 'true' }, handle.slice(0, 2)),
    el('span', { style: 'flex:1;display:flex;flex-direction:column;min-width:0' },
      el('span', { style: 'font-weight:600;overflow-wrap:anywhere' }, `Signed in as ${handle}`),
      el('span', { class: 'small dim' }, 'Not you? ', sw)));
}

function showPasscode(handle, onKnocked) {
  const input = el('input', { id: 'pc', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'one-time-code', 'aria-describedby': 'pc-err' });
  const boxes = el('div', { class: 'boxes', 'aria-hidden': 'true' });
  const wrap = el('div', { class: 'code' }, boxes, input);
  const err = el('p', { class: 'err', id: 'pc-err', role: 'alert' });
  err.hidden = true;
  const draw = () => {
    const v = input.value;
    boxes.replaceChildren(...[0, 1, 2, 3, 4, 5].map((i) =>
      el('span', { class: i < v.length ? 'filled' : i === v.length ? 'cur' : '' }, i < v.length ? '•' : i === v.length ? '_' : '')));
  };
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    wrap.classList.remove('wrong');
    draw();
  });
  const go = el('button', { class: 'btn primary big', type: 'submit' }, 'Knock');
  const form = el('form', { style: 'display:flex;flex-direction:column;gap:14px' },
    el('label', { for: 'pc', class: 'muted', style: 'font-size:14px' }, 'The code the sysop gave you'), wrap, err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.length !== 6) { err.textContent = 'The passcode is 6 digits.'; err.hidden = false; input.focus(); return; }
    go.disabled = true;
    try {
      const r = await knock(input.value);
      if (r.ok) return onKnocked();
      wrap.classList.add('wrong');
      input.value = '';
      draw();
      err.textContent = r.lockedMinutes
        ? `Too many tries. The door stays shut for ${r.lockedMinutes} minute${r.lockedMinutes === 1 ? '' : 's'}.`
        : `That’s not it. ${r.triesLeft} tr${r.triesLeft === 1 ? 'y' : 'ies'} left before a 15-minute lockout.`;
      err.hidden = false;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      go.disabled = false;
    }
  });
  draw();
  loginScreen('passcode', true, whoCard(handle), el('h2', {}, 'Enter the passcode'), form);
  input.focus();
}

function showWaiting(handle, passcodeOn) {
  loginScreen('wait', passcodeOn,
    el('div', { class: 'sent' },
      el('span', { class: 'label' }, 'REQUEST SENT'),
      el('h2', {}, `Hang tight, ${handle}`),
      el('p', { class: 'muted' }, 'The sysop will let you in soon. You’ll get an email when you’re approved, and next time the ',
        el('span', { class: 'mono', style: 'color:var(--b-ink)' }, '>_'), ' brings you straight in.')),
    el('p', { class: 'modem' }, 'Waiting for the sysop', el('span', { class: 'cur-blink', 'aria-hidden': 'true' }, '█')),
    backButton());
}

function showDenied(until, passcodeOn) {
  const when = until.toDate().toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  loginScreen('wait', passcodeOn,
    el('div', { class: 'sent' },
      el('span', { class: 'label' }, 'NO CARRIER'),
      el('h2', {}, 'Not this time'),
      el('p', { class: 'muted' }, `The door didn’t open this time. You can knock again after ${when}.`)),
    backButton());
}

/** Signed in with a handle but not inside: wait, denied, passcode, or ask now. */
async function knockOrWait(s) {
  const uid = s.user.uid, handle = s.profile.handle;
  const config = await getConfig();
  const wait = () => {
    showWaiting(handle, config.requirePasscode);
    // Let them in as soon as the sysop does; if the request vanishes without that, it was denied.
    stops.push(watchMember(uid, (m) => { if (m) enter(s); }));
    stops.push(watchRequest(uid, async (r) => {
      if (r || phase !== 'login:wait') return;
      if (await getMember(uid).catch(() => null)) return;
      const d = await getDenied(uid).catch(() => null);
      if (d?.until?.toMillis() > Date.now()) showDenied(d.until, config.requirePasscode);
    }));
  };
  if (await getRequest(uid).catch(() => null)) return wait();
  const denied = await getDenied(uid).catch(() => null);
  if (denied?.until?.toMillis() > Date.now()) return showDenied(denied.until, config.requirePasscode);
  if (config.requirePasscode) return showPasscode(handle, wait);
  try {
    await askToJoin(uid, handle);
    wait();
  } catch {
    // e.g. the passcode was switched on a moment ago: start over with fresh settings.
    const fresh = await getConfig();
    if (fresh.requirePasscode) showPasscode(handle, wait);
    else main.replaceChildren(el('p', { class: 'err' }, 'Couldn’t send your request. Reload the page and try again.'));
  }
}

// ---------- inside ----------------------------------------------------------------------

const ctx = {
  main, uid: '', handle: '', me: null, isSysop: false, isMod: false, config: { notice: '' }, crew: [],
  boards: [], threads: [], files: [], reads: {}, convs: [], chatRecent: [], counts: {},
  refresh: null, cleanup: null, draft: null,
  /** Re-count the NEW marks on the tabs (after a visit is recorded). */
  recount() { countNew(); },
  /** Re-draw the tab bar (counts change). */
  tabs() { drawTabs(); },
  /** Go to a place inside the BBS, e.g. ctx.go('crew'). */
  go(where) { location.hash = where; },
};
let current = '';

function drawTabs() {
  const nav = $('b-tabs').firstElementChild;
  const here = sectionOf(location.hash);
  nav.replaceChildren(...SECTIONS.map(([id, label]) => {
    const n = ctx.counts[id];
    const shown = n > 99 ? '99+' : String(n);
    return el('a', { href: `#${id}`, 'aria-current': id === here ? 'page' : false, 'aria-label': n ? `${label}, ${shown} new` : null },
      label, n ? el('span', { class: 'cnt', 'aria-hidden': 'true' }, shown) : null);
  }));
}
const routeOf = (hash) => {
  const [first, ...rest] = hash.replace(/^#/, '').split('/').map(decodeURIComponent);
  return ROUTES[first] ? { tab: ROUTES[first][0], render: ROUTES[first][1], rest } : { tab: 'boards', render: ROUTES.boards[1], rest: [] };
};
const sectionOf = (hash) => routeOf(hash).tab;

/** Tab counts: NEW threads (since my last visit to their board) and new files. */
function countNew() {
  ctx.counts.boards = ctx.threads.filter((t) => ctx.boards.some((b) => b.id === t.boardId && !b.archived) && isNewThread(t, ctx.reads, ctx.handle)).length;
  const seenFiles = ctx.reads.files?.toMillis?.() ?? 0;
  ctx.counts.files = ctx.files.filter((f) => (f.createdAt?.toMillis?.() ?? Date.now()) > seenFiles && f.byUid !== ctx.uid).length;
  ctx.counts.crew = ctx.convs.filter((c) => isUnread(c, ctx.uid) && !isHidden(c, ctx.uid)).length; // unread private messages
  // Shop Talk: other people's messages since I last had it open (never opened: the last 24 hours).
  // While Shop Talk is open, everything counts as seen.
  if (sectionOf(location.hash) === 'chat') {
    ctx.counts.chat = 0;
    if (ctx.chatRecent.some((m) => chatIsNew(m))) markChatSeen();
  } else {
    ctx.counts.chat = ctx.chatRecent.filter((m) => chatIsNew(m)).length;
  }
  drawTabs();
}
function chatIsNew(m) {
  const seen = ctx.reads.chat?.toMillis?.() ?? Date.now() - 24 * 3600000;
  const at = m.createdAt?.toMillis?.() ?? Date.now(); // a message still being sent counts as now
  return m.kind === 'msg' && m.uid !== ctx.uid && at > seen;
}
let chatMarkTimer = 0;
/** Remember "I've seen Shop Talk now": at most every few seconds while it's open, and right
 *  away (`now`) when leaving it. The local mark is never earlier than the newest message, so a
 *  computer clock that runs a little slow can't make a seen message look new. */
function markChatSeen(now = false) {
  if (chatMarkTimer && !now) return;
  clearTimeout(chatMarkTimer);
  const newest = Math.max(0, ...ctx.chatRecent.map((m) => m.createdAt?.toMillis?.() ?? Date.now()));
  markRead(ctx.uid, 'chat');
  ctx.reads.chat = Timestamp.fromMillis(Math.max(Date.now(), newest));
  chatMarkTimer = now ? 0 : setTimeout(() => { chatMarkTimer = 0; if (sectionOf(location.hash) === 'chat') countNew(); }, 3000);
}
/** Live data changed: recount and let the open view redraw. */
function changed() {
  countNew();
  const ae = document.activeElement;
  const typing = ae && ae.closest && ae.closest('#b-main') && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'search';
  if (ctx.refresh && (!typing || ctx.refreshKeepsInputs)) ctx.refresh();
}

async function show() {
  if (phase !== 'in') return;
  const route = routeOf(location.hash);
  if (sectionOf(current) === 'chat' && route.tab !== 'chat') markChatSeen(true); // leaving Shop Talk
  current = location.hash;
  countNew(); // also clears the Chat number when Shop Talk opens
  $('b-title').textContent = 'The Garage_Terminal BBS';
  $('b-here').hidden = true;
  if (ctx.cleanup) { try { ctx.cleanup(); } catch { /* ignore */ } ctx.cleanup = null; }
  ctx.refresh = null;
  ctx.refreshKeepsInputs = false; // a view whose redraw never touches what you're typing sets this
  main.replaceChildren(el('p', { class: 'modem' }, 'loading…'));
  try {
    await route.render(ctx, route.rest);
  } catch (err) {
    console.error(err);
    main.replaceChildren(el('p', { class: 'err' }, 'Couldn’t load this. Check your connection and try again.'));
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { if (location.hash !== current) show(); });

async function enter(s) {
  if (phase === 'in') return;
  stopAll();
  phase = 'in';
  chrome(true);
  ctx.uid = s.user.uid;
  ctx.handle = s.profile.handle;
  ctx.isSysop = s.isSysop;
  if (s.isSysop) await bbsAction('enter').catch(() => {});
  // Live: my own member doc (removal ends the visit), settings, the crew list.
  stops.push(watchMember(ctx.uid, (m) => {
    if (!m && !ctx.isSysop) {
      phase = '';
      stopAll();
      chrome(false);
      main.replaceChildren(el('div', { class: 'sent' }, el('span', { class: 'label' }, 'NO CARRIER'),
        el('h2', { style: 'margin:0;font:800 26px var(--b-head);text-transform:uppercase' }, 'Your BBS access has ended'),
        el('p', { class: 'muted', style: 'margin:0' }, 'Ask the sysop if you think that’s a mistake.')), backButton());
      return;
    }
    ctx.me = m;
    ctx.isMod = ctx.isSysop || m?.role === 'cosysop';
    if (phase === 'in') changed(); // e.g. muted / unmuted
  }));
  ctx.reads = await getReads(ctx.uid);
  stops.push(watchConfig((c) => { ctx.config = c; changed(); }));
  stops.push(watchCrew((list) => { ctx.crew = list.sort(byRank); changed(); }, () => {}));
  stops.push(watchBoards((list) => { ctx.boards = list; changed(); }, () => {}));
  stops.push(watchRecentThreads((list) => { ctx.threads = list; changed(); }, () => {}));
  stops.push(watchFiles((list) => { ctx.files = list; changed(); }, () => {}));
  stops.push(watchConvs(ctx.uid, (list) => { ctx.convs = list; changed(); }, () => {}));
  // The latest Shop Talk messages, for the number on the Chat tab.
  stops.push(watchChat(100, (list) => { ctx.chatRecent = list; changed(); }, () => {}));
  // Presence: "last seen" now and every minute while the page is open and visible.
  touch(ctx.uid);
  const beat = setInterval(() => { if (document.visibilityState === 'visible') touch(ctx.uid); }, 60000);
  stops.push(() => clearInterval(beat));
  await show();
}

$('b-logoff').addEventListener('click', async () => {
  await logOff();
  location.href = '/';
});

// Esc on the log-in screen goes back to the site.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && phase.startsWith('login:') && !e.target.closest('input')) location.href = '/';
});

// ---------- who is this? -------------------------------------------------------------------

finishRedirectSignIn().catch(() => {});

watchSession(async (s) => {
  const same = session.state === s.state && session.user?.uid === s.user?.uid;
  session = s;
  if (same && phase) return; // profile tweaks (post counts) don't change anything here
  if (s.state === 'loading') return;
  stopAll();
  phase = '';
  ctx.cleanup?.();
  ctx.refresh = null;
  if (s.state === 'guest') return showSignIn((await getConfig()).requirePasscode);
  if (s.state === 'needs-handle') return showPickHandle((await getConfig()).requirePasscode);
  try {
    if (s.isSysop || (await getMember(s.user.uid))) return enter(s);
    await knockOrWait(s);
  } catch (err) {
    console.error(err);
    main.replaceChildren(el('p', { class: 'err' }, 'Couldn’t reach the BBS. Check your connection and reload.'));
  }
});

