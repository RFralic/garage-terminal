// crew.js: the Crew tab (#crew): your private messages (src/bbs/dm.js) and your message lock
// (set up / unlock / settings, src/bbs/keys.js), then the member list
// (handle, joined, last seen, sysop / co-sysop badge, and a Message button).
import { el, timeAgo } from '../lib/ui.js';
import { isHere, roleLabel } from '../lib/bbs.js';
import { convList, messageButton } from './dm.js';
import { lockPanel, lockSettings, myLock } from './keys.js';

function row(ctx, m) {
  const seen = isHere(m) ? 'here now' : m.lastSeen ? `seen ${timeAgo(m.lastSeen)}` : 'not in yet';
  const joined = m.since ? `joined ${m.since.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
  return el('li', {},
    el('span', { class: 'avatar', 'aria-hidden': 'true' }, String(m.handle || '?').slice(0, 2)),
    el('span', { class: 'main' }, el('b', {}, m.handle), el('span', { class: 'small muted' }, [joined, seen].filter(Boolean).join(' · '))),
    isHere(m) ? el('span', { class: 'dot', title: 'here now' }, '●') : null,
    roleLabel(m.role) ? el('span', { class: `badge ${m.role}` }, roleLabel(m.role)) : null,
    m.uid !== ctx.uid ? messageButton(m) : null);
}

export function renderCrew(ctx) {
  const list = el('ul', { class: 'panel rows', style: 'list-style:none;margin:0;padding:0' });
  const count = el('span', { class: 'mono small dim' });
  const dms = el('div');
  // Encrypted messages: set up or unlock this device first (keys.js). Drawn once, not on
  // every refresh, so typing a passphrase isn't interrupted.
  const lockBox = el('div');
  const drawLock = async () => {
    const lock = await myLock(ctx.uid).catch(() => ({ state: 'error' }));
    if (lock.state === 'ready') lockBox.replaceChildren(lockSettings(ctx, drawLock));
    else if (lock.state === 'error') lockBox.replaceChildren(el('p', { class: 'small muted' }, 'Couldn’t check your message lock. Reload to try again.'));
    else lockBox.replaceChildren(lockPanel(ctx, lock.state, drawLock));
  };
  drawLock();
  const draw = () => {
    dms.replaceChildren(convList(ctx));
    list.replaceChildren(...(ctx.crew.length ? ctx.crew.map((m) => row(ctx, m)) : [el('li', { class: 'empty' }, 'Nobody yet.')]));
    count.textContent = `${ctx.crew.length} member${ctx.crew.length === 1 ? '' : 's'}`;
  };
  draw();
  ctx.refresh = draw;
  ctx.main.replaceChildren(
    el('section', { class: 'b-sec' }, el('h2', { class: 'sh' }, '🔒 Private messages'), dms, lockBox),
    el('section', { class: 'b-sec' }, el('div', { class: 'sh-row' }, el('h2', { class: 'sh' }, 'Crew'), count), list));
}
