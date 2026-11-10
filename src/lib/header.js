// header.js: the sign-in status line under the top menu, on every page.
//
//   guest:        reading as guest · Sign in
//   no handle:    signed in · Pick a handle · Log off
//   member:       logged in as {handle} · Log off
//   sysop:        logged in as {handle} SYSOP · /mod · Log off
//
// Also updates any element with [data-welcome] (the home page's
// "CONNECT 115200 ▸ welcome, guest" line).
//
// Everything is built with textContent / DOM nodes, never innerHTML, so a
// handle can't inject markup.

import { watchSession, logOff } from './session.js';

/** Small helper: make an element with optional class and text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function joinLink(label) {
  const a = el('a', 'session-link', label);
  const here = location.pathname + location.search;
  a.href = here.startsWith('/join') ? '/join' : `/join?next=${encodeURIComponent(here)}`;
  return a;
}

function logOffButton() {
  const b = el('button', 'session-link', 'Log off');
  b.type = 'button';
  b.addEventListener('click', async () => {
    await logOff();
  });
  return b;
}

const sep = () => el('span', 'session-sep', '·');

export function mountHeader() {
  const slot = document.getElementById('session');
  const welcome = document.querySelector('[data-welcome]');

  watchSession((s) => {
    if (!slot) return;
    slot.replaceChildren();
    slot.dataset.state = s.state;

    if (s.state === 'loading') {
      slot.append(el('span', 'session-muted', 'connecting…'));
    } else if (s.state === 'guest') {
      slot.append(el('span', 'session-muted', 'reading as guest'), sep(), joinLink('Sign in'));
    } else if (s.state === 'needs-handle') {
      slot.append(el('span', 'session-muted', 'signed in'), sep(), joinLink('Pick a handle'), sep(), logOffButton());
    } else {
      const who = el('span', 'session-muted', 'logged in as ');
      who.append(el('strong', 'session-handle', s.profile.handle));
      slot.append(who);
      if (s.isSysop) {
        slot.append(el('span', 'tag-sysop', 'SYSOP'), sep());
        const mod = el('a', 'session-link', '/mod');
        mod.href = '/mod';
        slot.append(mod);
      }
      slot.append(sep(), logOffButton());
    }

    if (welcome) {
      const name = s.state === 'member' ? s.profile.handle : 'guest';
      welcome.textContent = `CONNECT 115200 ▸ welcome, ${name}`;
    }
  });
}
