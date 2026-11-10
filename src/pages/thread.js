// thread.js: the /forum/t/{id} page. One thread, its posts, and a reply box.
//
// Posts update live: new replies (from anyone) appear without reloading.
// Authors get Edit (within 30 minutes) and Delete (replies only) on their posts.
// Sysop moderation buttons arrive in Phase 4.

import { mountHeader } from '../lib/header.js';
import { watchSession, canPost, currentSession } from '../lib/session.js';
import {
  getAreas, watchThread, watchPosts, createReply, editPost, deletePost,
  canStillEdit, postErrorMessage, secondsUntilCanPost, BODY_MAX,
} from '../lib/forum.js';
import { el, setMarkdown, setupComposer, timeEl } from '../lib/ui.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const threadId = decodeURIComponent(location.pathname.split('/')[3] || '');

let thread = null; // latest thread doc
let posts = []; // latest visible posts
let session = currentSession();
let editingId = null; // post currently being edited (kept as-is on live updates)
const composer = setupComposer($('t-form').querySelector('[data-composer]'), BODY_MAX);

// ---------- thread header -------------------------------------------------------

function renderThread() {
  if (!thread) {
    document.title = 'Thread not found · Garage Terminal';
    $('t-title').textContent = 'Thread not found';
    $('t-status').hidden = false;
    $('t-status').replaceChildren('It may have been removed. ', el('a', { href: '/forum' }, 'Back to the forum.'));
    $('t-posts').replaceChildren();
    $('t-reply').hidden = true;
    return;
  }
  document.title = `${thread.title} · Garage Terminal`;
  $('t-title').textContent = thread.title;
  const flags = [thread.pinned && 'PINNED', thread.locked && 'LOCKED'].filter(Boolean);
  $('t-flags').replaceChildren(...flags.map((f) => el('span', { class: f === 'PINNED' ? 'tag tag-pin' : 'tag' }, f)));
  getAreas().then((areas) => {
    const area = areas.find((a) => a.id === thread.areaId);
    $('t-area').replaceChildren(area ? el('a', { href: `/forum?area=${encodeURIComponent(area.id)}` }, `${area.key} ${area.name}`) : '');
  });
  renderReplyBox();
}

// ---------- reply box: depends on who's reading and the thread state ------------

function renderReplyBox() {
  if (!thread) return;
  const member = canPost(session);
  const signedOut = session.state === 'guest' || session.state === 'needs-handle';

  $('t-reply').hidden = !(member && !thread.locked);
  $('t-join').hidden = !(signedOut && !thread.locked);
  $('t-join-link').href = '/join?next=' + encodeURIComponent(location.pathname);

  const closed = $('t-closed');
  closed.hidden = true;
  if (thread.locked) {
    closed.hidden = false;
    closed.textContent = '> Thread locked by the sysop. No new replies.';
  } else if (session.state === 'member' && !member) {
    closed.hidden = false;
    closed.textContent = `> Your account is ${session.profile.status}: you can read but not reply.`;
  }
  if (session.state === 'member') $('t-me').textContent = session.profile.handle;
}

// ---------- posts -------------------------------------------------------------------

function postActions(post) {
  const mine = session.state === 'member' && post.authorUid === session.user.uid;
  if (!mine) return null;
  const actions = [];
  if (canPost(session) && !thread?.locked && canStillEdit(post)) {
    actions.push(el('button', { class: 'link-btn', type: 'button', onclick: () => startEdit(post) }, 'Edit'));
  }
  if (post.id !== 'op') {
    actions.push(el('button', { class: 'link-btn danger', type: 'button', onclick: () => removePost(post) }, 'Delete'));
  }
  return actions.length ? el('div', { class: 'post-actions' }, ...actions) : null;
}

function postEl(post, index) {
  const body = el('div', { class: 'md post-body' });
  setMarkdown(body, post.body);
  return el('li', { class: 'post', id: `p-${post.id}`, dataset: { id: post.id } },
    el('div', { class: 'post-head' },
      el('span', { class: post.authorRole === 'sysop' ? 'post-author by-sysop' : 'post-author' }, post.authorHandle),
      post.authorRole === 'sysop' ? el('span', { class: 'tag-sysop' }, 'SYSOP') : null,
      el('span', { class: 'post-when' }, timeEl(post.createdAt)),
      post.editedAt ? el('span', { class: 'post-edited', title: post.editedAt.toDate?.().toLocaleString() }, '(edited)') : null,
      el('span', { class: 'post-num' }, index === 0 ? 'OP' : `#${index}`),
    ),
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

async function removePost(post) {
  if (!confirm('Delete this reply? This can’t be undone.')) return;
  try {
    await deletePost(threadId, post.id);
  } catch (err) {
    console.error(err);
    alert(postErrorMessage(err, currentSession()));
  }
}

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
  error.textContent = problem;
  if (problem) return;

  const send = $('t-send');
  send.disabled = true;
  send.textContent = 'Posting…';
  try {
    await createReply(s, threadId, body);
    composer.reset();
  } catch (err) {
    console.error(err);
    error.textContent = postErrorMessage(err, currentSession());
  } finally {
    send.disabled = false;
    send.textContent = 'Post reply';
  }
});

// ---------- start: follow the session, the thread and its posts ---------------------

watchSession((s) => {
  session = s;
  renderReplyBox();
  if (posts.length) renderPosts(); // Edit/Delete buttons depend on who's reading
});

if (!threadId) {
  renderThread();
} else {
  watchThread(threadId, (t) => {
    thread = t;
    renderThread();
    if (posts.length) renderPosts();
  });
  watchPosts(threadId, (p) => {
    posts = p;
    renderPosts();
  }, (err) => {
    console.error(err);
    if (thread) {
      $('t-status').hidden = false;
      $('t-status').textContent = 'Couldn’t load posts. Try reloading.';
    }
  });
}
