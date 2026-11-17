// crew.js: the member list (#crew): handle, joined, last seen, sysop / co-sysop badge.
import { el, timeAgo } from '../lib/ui.js';
import { isHere, roleLabel } from '../lib/bbs.js';

function row(m) {
  const seen = isHere(m) ? 'here now' : m.lastSeen ? `seen ${timeAgo(m.lastSeen)}` : 'not in yet';
  const joined = m.since ? `joined ${m.since.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
  return el('li', {},
    el('span', { class: 'avatar', 'aria-hidden': 'true' }, String(m.handle || '?').slice(0, 2)),
    el('span', { class: 'main' }, el('b', {}, m.handle), el('span', { class: 'small muted' }, [joined, seen].filter(Boolean).join(' · '))),
    isHere(m) ? el('span', { class: 'dot', title: 'here now' }, '●') : null,
    roleLabel(m.role) ? el('span', { class: `badge ${m.role}` }, roleLabel(m.role)) : null);
}

export function renderCrew(ctx) {
  const list = el('ul', { class: 'panel rows', style: 'list-style:none;margin:0;padding:0' });
  const count = el('span', { class: 'mono small dim' });
  const draw = () => {
    list.replaceChildren(...(ctx.crew.length ? ctx.crew.map(row) : [el('li', { class: 'empty' }, 'Nobody yet.')]));
    count.textContent = `${ctx.crew.length} member${ctx.crew.length === 1 ? '' : 's'}`;
  };
  draw();
  ctx.refresh = draw;
  ctx.main.replaceChildren(el('section', { class: 'b-sec' }, el('div', { class: 'sh-row' }, el('h2', { class: 'sh' }, 'Crew'), count), list));
}
