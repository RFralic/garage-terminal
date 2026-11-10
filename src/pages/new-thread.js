// new-thread.js: the /forum/new page. Members only; guests get a join link.
//
// URL: /forum/new?area=general   preselects the area
//      /forum/new?title=Re:%20…   pre-fills the title

import { mountHeader } from '../lib/header.js';
import { watchSession, canPost, currentSession } from '../lib/session.js';
import { getAreas, getSiteSettings, createThread, postErrorMessage, secondsUntilCanPost, TITLE_MIN, TITLE_MAX, BODY_MAX } from '../lib/forum.js';
import { el, setupComposer } from '../lib/ui.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const form = $('n-form');
const status = $('n-status');
const errorLine = $('n-error');
const composer = setupComposer(form.querySelector('[data-composer]'), BODY_MAX);
const wantedArea = new URLSearchParams(location.search).get('area') || '';
// ?title= pre-fills the title (used by "Discuss in the forum" on library pages)
$('n-title').value = (new URLSearchParams(location.search).get('title') || '').slice(0, TITLE_MAX);

// ---------- areas dropdown ----------------------------------------------------

getAreas().then((areas) => {
  $('n-area').replaceChildren(
    ...areas.map((a) => el('option', { value: a.id, selected: a.id === wantedArea }, `${a.key} ${a.name}`)),
  );
});

// ---------- who can see the form ------------------------------------------------

let forumOpen = true;
getSiteSettings().then((site) => { forumOpen = site.forumOpen !== false; render(currentSession()); }).catch(() => {});

watchSession((s) => render(s));

function render(s) {
  const closedToMe = !forumOpen && !(s.state === 'member' && s.isSysop);
  form.hidden = !canPost(s) || closedToMe;
  status.hidden = !form.hidden;
  if (closedToMe && canPost(s)) {
    status.textContent = 'The forum is read-only right now, so new threads are paused. Check back soon.';
  } else if (s.state === 'loading') {
    status.textContent = 'loading…';
  } else if (s.state === 'guest' || s.state === 'needs-handle') {
    status.replaceChildren('Members only. ', el('a', { href: '/join?next=' + encodeURIComponent(location.pathname + location.search) }, 'Join to post'), ' — it takes a minute.');
  } else if (!canPost(s)) {
    status.textContent = `Your account is ${s.profile.status}: you can read but not post.`;
  }
}

// ---------- submit ------------------------------------------------------------------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const session = currentSession();
  const title = $('n-title').value.trim();
  const body = composer.textarea.value;

  // Friendly checks first (the database checks these again).
  let problem = '';
  if (title.length < TITLE_MIN) problem = `Title needs at least ${TITLE_MIN} characters.`;
  else if (title.length > TITLE_MAX) problem = `Title can be at most ${TITLE_MAX} characters.`;
  else if (!body.trim()) problem = 'Write a message.';
  else if (body.length > BODY_MAX) problem = `Message can be at most ${BODY_MAX.toLocaleString()} characters.`;
  else if (secondsUntilCanPost(session) > 0) problem = `Slow down: you can post again in ${secondsUntilCanPost(session)}s.`;
  errorLine.textContent = problem;
  if (problem) return;

  $('n-send').disabled = true;
  $('n-send').textContent = 'Posting…';
  try {
    const { id, held } = await createThread(session, { areaId: $('n-area').value, title, body });
    if (held) {
      // Held threads are hidden until the sysop approves them, so there's
      // nothing to open yet.
      form.hidden = true;
      status.hidden = false;
      status.replaceChildren('Your thread contains a filtered word, so it’s held for the sysop to review before it appears. ',
        el('a', { href: '/forum' }, 'Back to the forum.'));
      return;
    }
    location.href = `/forum/t/${encodeURIComponent(id)}`;
  } catch (err) {
    console.error(err);
    errorLine.textContent = postErrorMessage(err, currentSession());
    $('n-send').disabled = false;
    $('n-send').textContent = 'Post thread';
  }
});
