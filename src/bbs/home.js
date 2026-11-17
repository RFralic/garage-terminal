// home.js: the BBS home (#boards). Design: reference/bbs-design/WorkshopDark.dc.html
//   "From the sysop" notice (hidden when empty), Boards (2-column tiles: #01, name,
//   latest post line, orange "N NEW"), + New post, New in the file cabinet (latest
//   few files), In the shop now (members seen in the last few minutes).
// Data is kept live by src/pages/bbs.js in ctx (boards, threads, files, crew, reads).
import { el } from '../lib/ui.js';
import { isHere } from '../lib/bbs.js';
import { boardNo, isNewThread } from './data.js';
import { fileRow } from './files.js';

export function noticeBox(ctx) {
  const box = el('div', { class: 'notice', role: 'note' }, el('span', { class: 'label' }, 'FROM THE SYSOP'), el('p', {}, ctx.config.notice || ''));
  box.hidden = !String(ctx.config.notice || '').trim();
  return box;
}

export function hereChips(ctx) {
  const now = Date.now();
  const here = ctx.crew.filter((m) => isHere(m, now));
  return here.length
    ? el('div', { class: 'chips' }, ...here.map((m) => el('span', { class: 'chip' }, el('span', { class: 'dot', 'aria-hidden': 'true' }, '●'), ' ', m.handle)))
    : el('p', { class: 'muted', style: 'margin:0' }, 'Nobody else right now.');
}

function tile(ctx, b) {
  const threads = ctx.threads.filter((t) => t.boardId === b.id);
  const fresh = threads.filter((t) => isNewThread(t, ctx.reads, ctx.handle)).length;
  const last = threads[0];
  const line = last ? `${last.lastBy || last.authorHandle}: ${last.title}` : (b.description || 'No posts yet.');
  return el('a', { class: `tile${fresh ? ' has-new' : ''}`, href: `#boards/${b.id}`, 'aria-label': `${b.name}${fresh ? `, ${fresh} new` : ''}` },
    el('span', { class: 'tile-top' }, el('span', { class: 'mono dim small', style: 'font-weight:700' }, boardNo(b)),
      fresh ? el('span', { class: 'newtag' }, `${fresh} NEW`) : null),
    el('span', { class: 'tile-name' }, b.name),
    el('span', { class: 'tile-last' }, line));
}

export async function renderHome(ctx) {
  const draw = () => {
    const open = ctx.boards.filter((b) => !b.archived);
    const latestFiles = ctx.files.slice(0, 3);
    ctx.main.replaceChildren(
      noticeBox(ctx),
      el('section', { class: 'b-sec' },
        el('div', { class: 'sh-row' }, el('h2', { class: 'sh' }, 'Boards'), el('a', { class: 'btn light sm', href: '#new' }, '+ New post')),
        open.length ? el('div', { class: 'tiles' }, ...open.map((b) => tile(ctx, b))) : el('p', { class: 'soon' }, 'No boards yet.')),
      el('section', { class: 'b-sec' },
        el('div', { class: 'sh-row' }, el('h2', { class: 'sh' }, 'New in the file cabinet'), el('a', { class: 'link', href: '#files' }, 'All files →')),
        latestFiles.length ? el('ul', { class: 'panel rows' }, ...latestFiles.map((f) => fileRow(ctx, f))) : el('p', { class: 'panel empty', style: 'margin:0' }, 'Nothing filed yet.')),
      el('section', { class: 'b-sec' }, el('h2', { class: 'sh' }, 'In the shop now'), hereChips(ctx)),
    );
  };
  ctx.refresh = draw;
  draw();
}
