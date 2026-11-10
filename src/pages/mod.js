// mod.js (page): the /mod sysop dashboard.
//
// Tabs (the address remembers the tab, e.g. /mod#reports):
//   overview   counts: open reports, new members this week, posts today
//   reports    open reports with the reported post: Hide post / Dismiss / Member
//   held       threads and replies held by the word filter: Approve / Delete
//   members    search by handle; a member's details, email, posts and actions
//   settings   sysop notice, forum switch, banned words
//   log        the mod log
//
// Every change goes through moderate() → the `moderate` Cloud Function, which
// re-checks that you're sysop and writes the mod log. Reads are allowed only
// for the sysop by firestore.rules.

import { mountHeader } from '../lib/header.js';
import { watchSession } from '../lib/session.js';
import { getAreas, getSiteSettings, REPORT_REASONS } from '../lib/forum.js';
import {
  moderate, askReason, loadCounts, loadOpenReports, loadHeld, searchMembers, loadRecentMembers, loadMember, loadModLog,
} from '../lib/mod.js';
import { el, setMarkdown, timeEl } from '../lib/ui.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const body = $('m-body');

const TABS = [
  ['overview', 'Overview'],
  ['reports', 'Reports'],
  ['held', 'Held'],
  ['members', 'Members'],
  ['settings', 'Settings'],
  ['log', 'Mod log'],
];
let tab = 'overview';
let started = false;

// ---------- small helpers ---------------------------------------------------------

const btn = (label, onclick, cls = 'link-btn') => el('button', { class: cls, type: 'button', onclick }, label);
const line = (text, cls = 'mutedt') => el('p', { class: cls }, text);
const threadLink = (threadId, postId) => `/forum/t/${encodeURIComponent(threadId)}${postId && postId !== 'op' ? `#p-${postId}` : ''}`;
const reasonLabel = (r) => (REPORT_REASONS.find(([v]) => v === r) || [r, r])[1];

/** A rendered post excerpt (sanitized Markdown). */
function excerpt(text) {
  const box = el('div', { class: 'md post-body mod-excerpt' });
  setMarkdown(box, String(text ?? '').slice(0, 1500));
  return box;
}

/** Run an action, then re-render the current tab. Errors are shown, not thrown. */
async function act(action, params, { confirmText } = {}) {
  if (confirmText && !confirm(confirmText)) return false;
  try {
    const result = await moderate(action, params);
    await show(tab);
    return result ?? true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

// ---------- access gate & tabs -----------------------------------------------------

watchSession((s) => {
  if (s.state === 'loading') return;
  const sysop = s.state === 'member' && s.isSysop;
  $('m-gate').hidden = sysop;
  $('m-app').hidden = !sysop;
  if (!sysop) {
    // Non-sysops get a plain "not found". (The rules block the data anyway.)
    document.title = 'Not found · Garage Terminal';
    $('m-title').textContent = '> 404';
    $('m-gate').replaceChildren('ERROR: no such file or directory. ', el('a', { href: '/' }, '< back to home'));
    return;
  }
  if (!started) {
    started = true;
    const fromHash = location.hash.slice(1);
    show(TABS.some(([id]) => id === fromHash) ? fromHash : 'overview');
  }
});

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (started && id !== tab && TABS.some(([t]) => t === id)) show(id);
});

function renderTabs() {
  $('m-tabs').replaceChildren(...TABS.map(([id, label]) =>
    el('a', {
      class: 'chip', href: `#${id}`, 'aria-current': id === tab ? 'true' : false,
      onclick: (e) => { e.preventDefault(); show(id); },
    }, label)));
}

async function show(id, arg) {
  tab = id;
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  renderTabs();
  $('m-file').textContent = `${id}.txt`;
  body.replaceChildren(line('loading…'));
  try {
    await RENDER[id](arg);
  } catch (err) {
    console.error(err);
    body.replaceChildren(line('Couldn’t load this section. If you just deployed, database indexes may still be building; try again in a few minutes.', 'field-status'));
  }
}

// ---------- overview -------------------------------------------------------------------

async function renderOverview() {
  const c = await loadCounts();
  const stat = (n, label, go) => el(go ? 'button' : 'div', { class: 'stat', type: go ? 'button' : null, onclick: go ? () => show(go) : null },
    el('span', { class: 'stat-num' }, String(n)), el('span', { class: 'stat-label' }, label));
  body.replaceChildren(
    el('div', { class: 'stats' },
      stat(c.openReports, 'open reports', 'reports'),
      stat(c.newMembers, 'new members this week', 'members'),
      stat(c.postsToday, 'posts today')),
    line('> Tap a count to open that section. Every action you take here is recorded in the mod log.'),
  );
}

// ---------- reports ----------------------------------------------------------------------

async function renderReports() {
  const reports = await loadOpenReports();
  if (!reports.length) return body.replaceChildren(line('> No open reports. All quiet.'));
  body.replaceChildren(el('ol', { class: 'mod-list' }, ...reports.map((r) => el('li', { class: 'mod-item' },
    el('p', { class: 'mod-meta' },
      el('span', { class: 'tag tag-hidden' }, reasonLabel(r.reason).toUpperCase()),
      ' reported by ', el('strong', {}, r.reporterHandle || '?'), ' · ', timeEl(r.createdAt)),
    r.note ? el('p', { class: 'mod-note' }, `“${r.note}”`) : null,
    r.post
      ? el('div', {},
        el('p', { class: 'mod-meta' }, 'Post by ', el('strong', {}, r.post.authorHandle), r.post.hidden ? ' · already hidden' : ''),
        excerpt(r.post.body))
      : line('(The post has since been deleted.)'),
    el('div', { class: 'post-actions' },
      r.post && !r.post.hidden ? btn('Hide post', () => {
        const reason = askReason('Hide this post?');
        if (reason !== null) act('post.hide', { threadId: r.threadId, postId: r.postId, value: true, reason: reason || reasonLabel(r.reason), reportId: r.id });
      }, 'link-btn mod') : null,
      btn('Dismiss', () => act('report.dismiss', { reportId: r.id })),
      r.post ? btn('Member', () => show('members', r.post.authorUid)) : null,
      el('a', { class: 'link-btn', href: threadLink(r.threadId, r.postId) }, 'Open thread')),
  ))));
}

// ---------- held by the word filter ------------------------------------------------------

async function renderHeld() {
  const items = await loadHeld();
  if (!items.length) return body.replaceChildren(line('> Nothing held. The word filter hasn’t caught anything.'));
  body.replaceChildren(el('ol', { class: 'mod-list' }, ...items.map((item) => el('li', { class: 'mod-item' },
    el('p', { class: 'mod-meta' },
      el('span', { class: 'tag tag-hidden' }, item.kind === 'thread' ? 'NEW THREAD' : 'REPLY'),
      ' by ', el('strong', {}, item.authorHandle), ' · ', timeEl(item.createdAt)),
    item.kind === 'thread' ? el('p', { class: 'mod-title' }, item.title) : null,
    excerpt(item.body),
    el('div', { class: 'post-actions' },
      btn('Approve', () => item.kind === 'thread'
        ? act('thread.hide', { threadId: item.threadId, value: false })
        : act('post.hide', { threadId: item.threadId, postId: item.id, value: false }), 'link-btn mod'),
      btn('Delete', () => {
        const reason = askReason(item.kind === 'thread' ? 'Delete this thread?' : 'Delete this reply?');
        if (reason === null) return;
        if (item.kind === 'thread') act('thread.delete', { threadId: item.threadId, reason });
        else act('post.delete', { threadId: item.threadId, postId: item.id, reason });
      }, 'link-btn danger'),
      btn('Member', () => show('members', item.authorUid)),
      el('a', { class: 'link-btn', href: threadLink(item.threadId, item.kind === 'post' ? item.id : '') }, 'Open')),
  ))));
}

// ---------- members ----------------------------------------------------------------------

async function renderMembers(uid) {
  if (uid) return renderMember(uid);

  const input = el('input', { class: 'field', type: 'search', placeholder: 'Search by handle…', 'aria-label': 'Search members by handle', autocomplete: 'off' });
  const results = el('ol', { class: 'mod-list' });
  const fill = (members) => results.replaceChildren(...(members.length
    ? members.map((m) => el('li', { class: 'mod-item member-row' },
      btn(m.handle, () => show('members', m.uid), 'link-btn member-link'),
      el('span', { class: `tag status-${m.status}` }, m.status.toUpperCase()),
      el('span', { class: 'mutedt small' }, `${m.postCount ?? 0} posts · joined `, timeEl(m.createdAt))))
    : [line('> No members found.')]));

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => fill(await searchMembers(input.value)), 300);
  });
  body.replaceChildren(input, line('Newest members:', 'field-label'), results);
  fill(await loadRecentMembers());
}

async function renderMember(uid) {
  const m = await loadMember(uid);
  if (!m) return body.replaceChildren(line('> Member not found.'), btn('< All members', () => show('members')));

  const setStatus = (status, label) => () => {
    const reason = status === 'active' ? '' : askReason(`${label} ${m.handle}?`);
    if (reason !== null) act('member.status', { uid, status, reason }).then((ok) => ok && show('members', uid));
  };

  body.replaceChildren(
    btn('< All members', () => show('members')),
    el('div', { class: 'member-card' },
      el('p', { class: 'mod-title' }, m.handle, ' ', el('span', { class: `tag status-${m.status}` }, m.status.toUpperCase())),
      el('dl', { class: 'facts' },
        el('dt', {}, 'Email'), el('dd', {}, m.email || '(none)'),
        el('dt', {}, 'Joined'), el('dd', {}, timeEl(m.createdAt)),
        el('dt', {}, 'Posts'), el('dd', {}, String(m.postCount ?? 0)),
        m.bannedReason ? el('dt', {}, 'Ban reason') : null, m.bannedReason ? el('dd', {}, m.bannedReason) : null),
      line('Only you can see this email. Members never can.', 'mutedt small'),
      el('div', { class: 'post-actions' },
        m.status !== 'active' ? btn('Restore', setStatus('active', 'Restore'), 'link-btn mod') : null,
        m.status !== 'muted' ? btn('Mute', setStatus('muted', 'Mute'), 'link-btn mod') : null,
        m.status !== 'banned' ? btn('Ban', setStatus('banned', 'Ban'), 'link-btn danger') : null,
        btn('Hide all posts', () => {
          const reason = askReason(`Hide every post and thread by ${m.handle}?`);
          if (reason === null) return;
          act('member.hideAll', { uid, reason }).then((r) => {
            if (!r) return;
            alert(`Hidden: ${r.posts} posts, ${r.threads} threads.`);
            show('members', uid);
          });
        }, 'link-btn danger'),
        btn('Rename', () => {
          const handle = window.prompt(`New handle for ${m.handle} (3–20 letters, numbers or underscores):`, m.handle);
          if (handle && handle.trim() !== m.handle) act('member.rename', { uid, handle: handle.trim() }).then((ok) => ok && show('members', uid));
        })),
    ),
    el('p', { class: 'field-label' }, `Recent posts (${m.posts.length})`),
    m.posts.length
      ? el('ol', { class: 'mod-list' }, ...m.posts.map((p) => el('li', { class: p.hidden ? 'mod-item is-hidden' : 'mod-item' },
        el('p', { class: 'mod-meta' }, timeEl(p.createdAt), p.hidden ? ' · HIDDEN' : '', ' · ',
          el('a', { href: threadLink(p.threadId, p.id) }, 'open')),
        excerpt(p.body))))
      : line('> No posts yet.'),
  );
}

// ---------- settings -----------------------------------------------------------------------

async function renderSettings() {
  const site = await getSiteSettings();

  /** A save button with its own status line ("Saved." or the error). */
  const saver = (label, getParams, confirmText) => {
    const status = el('p', { class: 'field-status', dataset: { kind: 'wait' }, role: 'status' });
    const button = btn(label, async () => {
      if (confirmText?.() && !confirm(confirmText())) return;
      button.disabled = true;
      status.dataset.kind = 'wait';
      status.textContent = 'saving…';
      try {
        const r = await moderate('settings.update', getParams());
        status.dataset.kind = 'ok';
        status.textContent = r?.bannedWords ? `Saved ${r.bannedWords.length} words.` : 'Saved.';
        if (r?.bannedWords) words.value = r.bannedWords.join('\n'); // show the cleaned-up list
      } catch (err) {
        status.dataset.kind = 'bad';
        status.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    }, 'btn primary');
    return [button, status];
  };

  // Sysop notice
  const notice = el('textarea', { class: 'field area-field', rows: 4, maxlength: 2000, 'aria-label': 'Sysop notice' });
  notice.value = site.sysopNotice || '';
  const preview = el('div', { class: 'md post-body preview' });
  const updatePreview = () => setMarkdown(preview, notice.value.trim() ? notice.value : '_No notice: the box is hidden on the forum._');
  notice.addEventListener('input', updatePreview);
  updatePreview();

  // Forum switch
  const open = el('input', { type: 'checkbox', id: 'm-open', checked: site.forumOpen !== false });

  // Banned words
  const words = el('textarea', { class: 'field area-field', rows: 5, 'aria-label': 'Banned words, one per line' });
  words.value = (site.bannedWords || []).join('\n');

  body.replaceChildren(
    el('div', { class: 'setting' },
      el('p', { class: 'field-label' }, 'Sysop notice (shown at the top of the forum, Markdown)'),
      notice, preview,
      ...saver('Save notice', () => ({ sysopNotice: notice.value }))),

    el('div', { class: 'setting' },
      el('p', { class: 'field-label' }, 'Forum switch'),
      el('label', { class: 'switch', for: 'm-open' }, open, el('span', {}, 'Forum open for new posts')),
      line('When off, the forum is read-only for everyone but you. The database enforces it.', 'mutedt small'),
      ...saver('Save switch', () => ({ forumOpen: open.checked }), () => (open.checked ? null : 'Close the forum to new posts?'))),

    el('div', { class: 'setting' },
      el('p', { class: 'field-label' }, 'Word filter: one word or phrase per line'),
      words,
      line('Letters, numbers and spaces only; capitals are ignored; whole words only. Posts containing one are held for you to approve (see Held).', 'mutedt small'),
      ...saver('Save words', () => ({ bannedWords: words.value.split('\n').map((w) => w.trim()).filter(Boolean) }))),
  );
}

// ---------- mod log ---------------------------------------------------------------------

const ACTION_LABELS = {
  'thread.pin': 'pin/unpin thread',
  'thread.lock': 'lock/unlock thread',
  'thread.move': 'move thread',
  'thread.hide': 'hide/unhide thread',
  'thread.delete': 'delete thread',
  'post.hide': 'hide/unhide post',
  'post.delete': 'delete post',
  'report.dismiss': 'dismiss report',
  'member.status': 'member status',
  'member.hideAll': 'hide all posts',
  'member.rename': 'rename member',
  'settings.update': 'site settings',
};

/** Plain-text summary of an entry's details, e.g. "locked: yes · from: Bob". */
function describe(details = {}) {
  return Object.entries(details)
    .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v).slice(0, 80)}`)
    .join(' · ');
}

/** Link (or button) to whatever an entry was about. */
function targetEl(path = '') {
  const [kind, a, , b] = path.split('/');
  if (kind === 'threads') return el('a', { href: threadLink(a, b) }, b ? 'post' : 'thread');
  if (kind === 'users') return btn('member', () => show('members', a));
  if (kind === 'settings') return btn('settings', () => show('settings'));
  if (kind === 'reports') return el('span', {}, 'report');
  return el('span', {}, path);
}

async function renderLog() {
  const entries = await loadModLog();
  if (!entries.length) return body.replaceChildren(line('> The mod log is empty.'));
  const areas = await getAreas().catch(() => []);
  const areaName = (id) => areas.find((x) => x.id === id)?.name ?? id;
  body.replaceChildren(el('ol', { class: 'mod-list' }, ...entries.map((e) => {
    const details = { ...e.details };
    if (e.action === 'thread.move') { details.from = areaName(details.from); details.to = areaName(details.to); }
    return el('li', { class: 'mod-item log-item' },
      el('p', { class: 'mod-meta' }, timeEl(e.createdAt), ' · ', el('strong', {}, e.byHandle || 'sysop'), ' · ',
        el('span', { class: 'log-action' }, ACTION_LABELS[e.action] || e.action), ' · ', targetEl(e.targetPath)),
      Object.keys(details).length ? el('p', { class: 'mutedt small' }, describe(details)) : null,
      e.reason ? el('p', { class: 'mod-note' }, `Reason: ${e.reason}`) : null,
    );
  })));
}

const RENDER = {
  overview: renderOverview,
  reports: renderReports,
  held: renderHeld,
  members: renderMembers,
  settings: renderSettings,
  log: renderLog,
};
