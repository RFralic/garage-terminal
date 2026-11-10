// forum-list.js: the /forum page. Sysop notice, area filter, thread list.
//
// URL: /forum            all areas
//      /forum?area=general just one area

import { mountHeader } from '../lib/header.js';
import { watchSession, canPost } from '../lib/session.js';
import { getAreas, getSiteSettings, listThreads } from '../lib/forum.js';
import { el, setMarkdown, timeEl } from '../lib/ui.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let areaId = params.get('area') || '';
let cursor = null;
let areas = [];

// ---------- post button: depends on who's reading ----------------------------

watchSession((s) => {
  $('f-new').hidden = !canPost(s);
  $('f-join').hidden = !(s.state === 'guest' || s.state === 'needs-handle');
  const cant = $('f-cant');
  cant.hidden = !(s.state === 'member' && !canPost(s));
  if (!cant.hidden) cant.textContent = `Your account is ${s.profile.status}: you can read but not post.`;
  $('f-new').href = areaId ? `/forum/new?area=${encodeURIComponent(areaId)}` : '/forum/new';
});

// ---------- sysop notice ------------------------------------------------------

getSiteSettings().then((settings) => {
  if (settings.sysopNotice?.trim()) {
    setMarkdown($('f-notice-body'), settings.sysopNotice);
    $('f-notice').hidden = false;
  }
}).catch(() => {});

// ---------- area chips ----------------------------------------------------------

function renderChips() {
  const nav = $('f-areas');
  const chip = (id, label) =>
    el('a', {
      class: 'chip',
      href: id ? `/forum?area=${encodeURIComponent(id)}` : '/forum',
      'aria-current': id === areaId ? 'true' : false,
      onclick: (e) => { e.preventDefault(); selectArea(id); },
    }, label);
  nav.replaceChildren(chip('', 'All'), ...areas.map((a) => chip(a.id, `${a.key} ${a.name}`)));
}

function selectArea(id) {
  areaId = id;
  history.replaceState(null, '', id ? `/forum?area=${encodeURIComponent(id)}` : '/forum');
  $('f-new').href = id ? `/forum/new?area=${encodeURIComponent(id)}` : '/forum/new';
  renderChips();
  loadThreads(true);
}

// ---------- thread list ------------------------------------------------------------

function threadRow(t) {
  const area = areas.find((a) => a.id === t.areaId);
  const replies = `${t.replyCount ?? 0} ${t.replyCount === 1 ? 'reply' : 'replies'}`;
  return el('li', { class: 'thread' },
    el('a', { href: `/forum/t/${encodeURIComponent(t.id)}` },
      el('span', { class: 'thread-title' },
        t.pinned ? el('span', { class: 'tag tag-pin' }, 'PINNED') : null,
        t.locked ? el('span', { class: 'tag' }, 'LOCKED') : null,
        t.title),
      el('span', { class: 'thread-meta' },
        area ? el('span', { class: 'area-key' }, area.key) : null,
        el('span', { class: t.authorRole === 'sysop' ? 'by by-sysop' : 'by' }, t.authorHandle),
        el('span', {}, replies),
        timeEl(t.lastReplyAt)),
    ),
  );
}

async function loadThreads(fresh) {
  const list = $('f-list');
  const status = $('f-status');
  if (fresh) {
    cursor = null;
    list.replaceChildren();
    status.textContent = 'loading…';
    status.hidden = false;
  }
  const area = areas.find((a) => a.id === areaId);
  $('f-file').textContent = area ? `${area.name.toLowerCase().replace(/\W+/g, '_')}.txt` : 'threads.txt';

  try {
    const page = await listThreads({ areaId, cursor });
    list.append(...page.threads.map(threadRow));
    cursor = page.cursor;
    $('f-more').hidden = !cursor;
    status.hidden = list.children.length > 0;
    if (!list.children.length) {
      status.replaceChildren('No threads yet. ', el('a', { href: $('f-new').href }, 'Start one.'));
    }
  } catch (err) {
    console.error(err);
    status.hidden = false;
    status.textContent = 'Couldn’t load threads. Pull to refresh or try again shortly.';
  }
}

$('f-more').addEventListener('click', () => loadThreads(false));

// ---------- start ---------------------------------------------------------------------

(async () => {
  try {
    areas = await getAreas();
  } catch {
    areas = [];
  }
  if (areaId && !areas.some((a) => a.id === areaId)) areaId = '';
  renderChips();
  loadThreads(true);
})();
