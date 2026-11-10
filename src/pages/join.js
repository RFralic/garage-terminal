// join.js: the /join page. Sign in with Google, then pick a handle once.
//
// Shows one panel at a time, depending on the session:
//   guest          -> "Sign in with Google" button
//   needs-handle   -> handle picker with a live availability check
//   member         -> "you're in" + link back to where they came from
//
// The page checks handles for a nicer experience, but firestore.rules is what
// actually enforces format, reserved words and uniqueness.

import { mountHeader } from '../lib/header.js';
import {
  watchSession,
  signInWithGoogle,
  finishRedirectSignIn,
  handleProblem,
  isHandleFree,
  claimHandle,
  safeNextPath,
} from '../lib/session.js';

mountHeader();

const next = safeNextPath(new URLSearchParams(location.search).get('next'));
const $ = (id) => document.getElementById(id);

const panels = {
  loading: $('j-loading'),
  guest: $('j-guest'),
  'needs-handle': $('j-handle'),
  member: $('j-done'),
};
const errorLine = $('j-error');

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = !message;
}

function friendlyAuthError(err) {
  const code = err?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return '';
  if (code === 'auth/popup-blocked') return 'Your browser blocked the sign-in window. Allow pop-ups and try again.';
  if (code === 'auth/unauthorized-domain') return 'Sign-in isn’t enabled on this address. Use the main site.';
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
  return 'Sign-in failed. Please try again.';
}

// ---------- session -> which panel ------------------------------------------

watchSession((s) => {
  for (const [state, panel] of Object.entries(panels)) panel.hidden = state !== s.state;
  if (s.state === 'member') {
    $('j-done-handle').textContent = s.profile.handle;
    $('j-continue').href = next;
  }
  if (s.state === 'needs-handle') $('j-input').focus();
});

// Phones come back here from Google's page; finish that sign-in.
finishRedirectSignIn().catch((err) => showError(friendlyAuthError(err)));

// ---------- sign in ----------------------------------------------------------

$('j-google').addEventListener('click', async () => {
  showError('');
  try {
    await signInWithGoogle();
  } catch (err) {
    showError(friendlyAuthError(err));
  }
});

// ---------- handle picker ----------------------------------------------------

const input = $('j-input');
const status = $('j-status');
const claimBtn = $('j-claim');
let checkTimer;
let checkNumber = 0; // ignore answers to older checks if the user kept typing

function setStatus(text, kind) {
  status.textContent = text;
  status.dataset.kind = kind; // ok | bad | wait (colors in CSS)
}

input.addEventListener('input', () => {
  const handle = input.value.trim();
  claimBtn.disabled = true;
  clearTimeout(checkTimer);

  if (!handle) return setStatus('3–20 letters, numbers or underscores.', 'wait');
  const problem = handleProblem(handle);
  if (problem) return setStatus(problem, 'bad');

  setStatus('checking…', 'wait');
  const mine = ++checkNumber;
  checkTimer = setTimeout(async () => {
    try {
      const free = await isHandleFree(handle);
      if (mine !== checkNumber) return;
      setStatus(free ? `${handle} is available` : `${handle} is taken`, free ? 'ok' : 'bad');
      claimBtn.disabled = !free;
    } catch {
      if (mine === checkNumber) setStatus('Couldn’t check right now. Try again.', 'bad');
    }
  }, 350);
});

$('j-handle').addEventListener('submit', async (e) => {
  e.preventDefault();
  const handle = input.value.trim();
  if (handleProblem(handle)) return;

  claimBtn.disabled = true;
  setStatus('claiming…', 'wait');
  try {
    await claimHandle(handle);
    // watchSession flips the page to the "you're in" panel by itself.
  } catch (err) {
    if (err.message === 'taken') setStatus(`${handle} was just taken. Try another.`, 'bad');
    else setStatus('Couldn’t claim that handle. Try again.', 'bad');
    claimBtn.disabled = false;
  }
});
