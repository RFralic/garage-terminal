// thread.js: the /forum/t/{id} page. One thread, its posts, and a reply box.
//
// Everyone:  posts update live (new replies appear without reloading).
// Members:   reply; Edit (within 30 minutes) and Delete (replies) on their own
//            posts; Report on other people's posts.
// Sysop:     a moderation bar for the thread (pin, lock, move, hide, delete) and
//            Hide/Delete on every post. Hidden posts stay visible to the sysop,
//            faded, with the reason. All sysop actions go through the logged
//            `moderate` Cloud Function (src/lib/mod.js).

import { mountHeader } from '../lib/header.js';
import { watchSession, canPost, currentSession } from '../lib/session.js';
import {
  getAreas, getSiteSettings, watchThread, watchPosts, createReply, editPost, deletePost, reportPost,
  canStillEdit, postErrorMessage, secondsUntilCanPost, BODY_MAX, REPORT_REASONS,
} from '../lib/forum.js';
import { moderate, askReason } from '../lib/mod.js';
import { el, setMarkdown, setupComposer, timeEl } from '../lib/ui.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const threadId = decodeURIComponent(location.pathname.split('/')[3] || '');

let thread = null; // latest thread doc
let posts = []; // latest posts (hidden ones included for the sysop)
let session = currentSession();
let site = { forumOpen: true };
let editingId = null; // post being edited (kept as-is on live updates)
let stopPosts = null;
let watchingHidden = null; // whether the current posts subscription includes hidden posts
const composer = setupComposer($('t-form').querySelector('[data-composer]'), BODY_MAX);

const isSysop = () => session.state === 'member' && session.isSysop;

/** Run a sysop action; show any error. */
async function act(action, params) {
  try {
    await moderate(action, params);
  } catch (err) {
    alert(err.message);
  }
}

// ---------- thread header ---------------------------------------------------------

function renderThread() {
  if (!thread) {
    document.title = 'Thread not found · Garage Terminal';
    $('t-title').textContent = 'Thread not found';
    $('t-status').hidden = false;
    $('t-status').replaceChildren('It may have been removed. ', el('a', { href: '/forum' }, 'Back to the forum.'));
    $('t-posts').replaceChildren();
    $('t-reply').hidden = true;
    $('t-modbar').hidden = true;
    $('t-hidden-banner').hidden = true;
    return;
  }
  document.title = `${thread.title} · Garage Terminal`;
  $('t-title').textContent = thread.title;
  const flags = [thread.pinned && 'PINNED', thread.locked && 'LOCKED', thread.hidden && (thread.held ? 'HELD' : 'HIDDEN')].filter(Boolean);
  $('t-flags').replaceChildren(...flags.map((f) => el('span', { class: f === 'PINNED' ? 'tag tag-pin' : f === 'LOCKED' ? 'tag' : 'tag tag-hidden' }, f)));
  getAreas().then((areas) => {
    const area = areas.find((a) => a.id === thread.areaId);
    $('t-area').replaceChildren(area ? el('a', { href: `/forum?area=${encodeURIComponent(area.id)}` }, `${area.key} ${area.name}`) : '');
    renderModBar(areas);
  });

  const banner = $('t-hidden-banner');
  banner.hidden = !thread.hidden;
  if (thread.hidden) {
    banner.textContent = thread.held
      ? '> HELD: the word filter caught this thread. Only you can see it. Unhide to approve it, or delete it.'
      : `> HIDDEN${thread.hiddenReason ? `: ${thread.hiddenReason}` : ''}. Only you can see this thread.`;
  }
  renderReplyBox();
}

// ---------- sysop: thread moderation bar ---------------------------------------

function renderModBar(areas) {
  const bar = $('t-modbar');
  bar.hidden = !isSysop() || !thread;
  if (bar.hidden) return;

  const btn = (label, onclick, cls = '') => el('button', { class: `link-btn ${cls}`, type: 'button', onclick }, label);
  const move = el('select', { class: 'field field-small', 'aria-label': 'Move to area' },
    ...areas.map((a) => el('option', { value: a.id, selected: a.id === thread.areaId }, `${a.key} ${a.name}`)));
  move.addEventListener('change', () => {
    if (move.value !== thread.areaId) act('thread.move', { threadId, areaId: move.value });
  });

  bar.replaceChildren(
    el('span', { class: 'modbar-label' }, 'SYSOP'),
    btn(thread.pinned ? 'Unpin' : 'Pin', () => act('thread.pin', { threadId, value: !thread.pinned })),
    btn(thread.locked ? 'Unlock' : 'Lock', () => {
      const reason = thread.locked ? '' : askReason('Lock this thread?');
      if (reason !== null) act('thread.lock', { threadId, value: !thread.locked, reason });
    }),
    thread.hidden
      ? btn(thread.held ? 'Approve' : 'Unhide', () => act('thread.hide', { threadId, value: false }))
      : btn('Hide', () => {
        const reason = askReason('Hide this thread from everyone?');
        if (reason !== null) act('thread.hide', { threadId, value: true, reason });
      }),
    btn('Delete thread', async () => {
      const reason = askReason(`Delete "${thread.title}" and all its replies? This can’t be undone.`);
      if (reason === null) return;
      await act('thread.delete', { threadId, reason });
      location.href = '/forum';
    }, 'danger'),
    el('label', { class: 'modbar-move' }, 'Move:', move),
  );
}

// ---------- reply box: depends on who's reading and the thread state ------------

function renderReplyBox() {
  if (!thread) return;
  const member = canPost(session);
  const signedOut = session.state === 'guest' || session.state === 'needs-handle';
  const forumClosed = site.forumOpen === false && !isSysop();
  const open = !thread.locked && !thread.hidden && !forumClosed;

  $('t-reply').hidden = !(member && open);
  $('t-join').hidden = !(signedOut && open);
  $('t-join-link').href = '/join?next=' + encodeURIComponent(location.pathname);

  const closed = $('t-closed');
  closed.hidden = true;
  const say = (text) => { closed.hidden = false; closed.textContent = text; };
  if (thread.locked) say('> Thread locked by the sysop. No new replies.');
  else if (forumClosed) say('> The forum is read-only right now. Check back soon.');
  else if (session.state === 'member' && !member) say(`> Your account is ${session.profile.status}: you can read but not reply.`);
  if (session.state === 'member') $('t-me').textContent = session.profile.handle;
}

// ---------- posts -------------------------------------------------------------------

function postActions(post) {
  if (session.state !== 'member') return null;
  const mine = post.authorUid === session.user.uid;
  const actions = [];

  if (mine && canPost(session) && !thread?.locked && !post.hidden && canStillEdit(post)) {
    actions.push(el('button', { class: 'link-btn', type: 'button', onclick: () => startEdit(post) }, 'Edit'));
  }
  if (mine && post.id !== 'op' && !isSysop()) {
    actions.push(el('button', { class: 'link-btn danger', type: 'button', onclick: () => removeOwnPost(post) }, 'Delete'));
  }
  // Members can report other people's posts (banned members can't).
  if (!mine && !isSysop() && session.profile.status !== 'banned' && !post.hidden) {
    actions.push(el('button', { class: 'link-btn', type: 'button', onclick: () => openReport(post) }, 'Report'));
  }
  // Sysop: hide / unhide (approve) any post, delete any reply.
  if (isSysop()) {
    actions.push(post.hidden
      ? el('button', { class: 'link-btn mod', type: 'button', onclick: () => act('post.hide', { threadId, postId: post.id, value: false }) }, post.held ? 'Approve' : 'Unhide')
      : el('button', {
        class: 'link-btn mod', type: 'button',
        onclick: () => { const reason = askReason('Hide this post?'); if (reason !== null) act('post.hide', { threadId, postId: post.id, value: true, reason }); },
      }, 'Hide'));
    if (post.id !== 'op') {
      actions.push(el('button', {
        class: 'link-btn danger', type: 'button',
        onclick: () => { const reason = askReason('Delete this reply? This can’t be undone.'); if (reason !== null) act('post.delete', { threadId, postId: post.id, reason }); },
      }, 'Delete'));
    }
  }
  return actions.length ? el('div', { class: 'post-actions' }, ...actions) : null;
}

function postEl(post, index) {
  const body = el('div', { class: 'md post-body' });
  setMarkdown(body, post.body);
  const hiddenNote = post.hidden
    ? el('p', { class: 'mod-banner small' }, post.held ? '> HELD by the word filter. Only you can see this.' : `> HIDDEN${post.hiddenReason ? `: ${post.hiddenReason}` : ''}`)
    : null;
  return el('li', { class: post.hidden ? 'post is-hidden' : 'post', id: `p-${post.id}`, dataset: { id: post.id } },
    el('div', { class: 'post-head' },
      el('span', { class: post.authorRole === 'sysop' ? 'post-author by-sysop' : 'post-author' }, post.authorHandle),
      post.authorRole === 'sysop' ? el('span', { class: 'tag-sysop' }, 'SYSOP') : null,
      el('span', { class: 'post-when' }, timeEl(post.createdAt)),
      post.editedAt ? el('span', { class: 'post-edited', title: post.editedAt.toDate?.().toLocaleString() }, '(edited)') : null,
      el('span', { class: 'post-num' }, index === 0 ? 'OP' : `#${index}`),
    ),
    hiddenNote,
    body,
    postActions(post),
  );
}

function renderPosts() {
  const list = $('t-posts');
  const keep = editingId ? document.getElementById(`p-${editingId}`) : null;
  list.replaceChildren(...posts.map((p, i) => (keep && p.id === editingId ? keep : postEl(p, i))));
  if (editingId && !posts.some((p) => p.id === editingId)) editingId = null;
}

/** (Re)subscribe to posts; the sysop's subscription includes hidden posts. */
function subscribePosts() {
  const includeHidden = isSysop();
  if (stopPosts && watchingHidden === includeHidden) return;
  stopPosts?.();
  watchingHidden = includeHidden;
  stopPosts = watchPosts(threadId, (p) => {
    posts = p;
    renderPosts();
  }, (err) => {
    console.error(err);
    if (thread) {
      $('t-status').hidden = false;
      $('t-status').textContent = 'Couldn’t load posts. Try reloading.';
    }
  }, { includeHidden });
}

// ---------- editing & deleting your own posts ----------------------------------

function startEdit(post) {
  editingId = post.id;
  const item = document.getElementById(`p-${post.id}`);
  const area = el('textarea', { class: 'field area-field', rows: 6, 'aria-label': 'Edit post' });
  area.value = post.body;
  const error = el('p', { class: 'field-status', dataset: { kind: 'bad' }, role: 'alert' });
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Save');
  const cancel = el('button', { class: 'link-btn', type: 'button' }, 'Cancel');

  const stop = () => { editingId = null; renderPosts(); };
  cancel.addEventListener('click', stop);
  save.addEventListener('click', async () => {
    const body = area.value;
    if (!body.trim()) return (error.textContent = 'A post can’t be empty.');
    if (body.length > BODY_MAX) return (error.textContent = `At most ${BODY_MAX.toLocaleString()} characters.`);
    save.disabled = true;
    try {
      await editPost(threadId, post.id, body);
      stop();
    } catch (err) {
      console.error(err);
      error.textContent = postErrorMessage(err, currentSession());
      save.disabled = false;
    }
  });

  item.querySelector('.post-body').replaceWith(el('div', { class: 'edit-box' }, area, error, el('div', { class: 'post-actions' }, save, cancel)));
  item.querySelector(':scope > .post-actions')?.remove();
  area.focus();
}

async function removeOwnPost(post) {
  if (!confirm('Delete this reply? This can’t be undone.')) return;
  try {
    await deletePost(threadId, post.id);
  } catch (err) {
    console.error(err);
    alert(postErrorMessage(err, currentSession()));
  }
}

// ---------- reporting --------------------------------------------------------------

const reportDialog = $('t-report');
let reportingPost = null;
$('t-report-reasons').append(...REPORT_REASONS.map(([value, label], i) =>
  el('label', { class: 'radio' }, el('input', { type: 'radio', name: 'reason', value, checked: i === 0 }), label)));

function openReport(post) {
  reportingPost = post;
  $('t-report-note').value = '';
  $('t-report-error').textContent = '';
  reportDialog.showModal();
}
$('t-report-cancel').addEventListener('click', () => reportDialog.close());
$('t-report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reason = $('t-report-form').querySelector('input[name=reason]:checked')?.value;
  try {
    await reportPost(currentSession(), threadId, reportingPost.id, reason, $('t-report-note').value);
    reportDialog.close();
    alert('Thanks. The sysop will take a look.');
  } catch (err) {
    console.error(err);
    // A second report on the same post is refused by the rules (one per member).
    $('t-report-error').textContent = err?.code === 'permission-denied'
      ? 'You’ve already reported this post, or it was removed.'
      : 'Couldn’t send the report. Try again.';
  }
});

// ---------- replying -------------------------------------------------------------------

$('t-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = composer.textarea.value;
  const error = $('t-error');
  const s = currentSession();

  let problem = '';
  if (!body.trim()) problem = 'Write something first.';
  else if (body.length > BODY_MAX) problem = `At most ${BODY_MAX.toLocaleString()} characters.`;
  else if (secondsUntilCanPost(s) > 0) problem = `Slow down: you can post again in ${secondsUntilCanPost(s)}s.`;
  error.dataset.kind = 'bad';
  error.textContent = problem;
  if (problem) return;

  const send = $('t-send');
  send.disabled = true;
  send.textContent = 'Posting…';
  try {
    const { held } = await createReply(s, threadId, body);
    composer.reset();
    if (held) {
      error.dataset.kind = 'wait';
      error.textContent = 'Your reply contains a filtered word, so it’s held for the sysop to review before it appears.';
    }
  } catch (err) {
    console.error(err);
    error.textContent = postErrorMessage(err, currentSession());
  } finally {
    send.disabled = false;
    send.textContent = 'Post reply';
  }
});

// ---------- start: follow the session, the thread and its posts ---------------------

getSiteSettings().then((s) => { site = s; renderReplyBox(); }).catch(() => {});

watchSession((s) => {
  session = s;
  if (s.state === 'loading') return;
  if (threadId) subscribePosts();
  renderReplyBox();
  if (thread) getAreas().then(renderModBar);
  if (posts.length) renderPosts(); // buttons depend on who's reading
});

if (!threadId) {
  renderThread();
} else {
  watchThread(threadId, (t) => {
    thread = t;
    renderThread();
    if (posts.length) renderPosts();
  });
}
