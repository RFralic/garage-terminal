// home.js: the BBS home (#boards). Design: reference/bbs-design/WorkshopDark.dc.html
//   "From the sysop" notice (hidden when empty), Boards, New in the file cabinet,
//   In the shop now (members seen in the last few minutes).
import { el } from '../lib/ui.js';
import { isHere } from '../lib/bbs.js';

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

export async function renderHome(ctx) {
  const notice = noticeBox(ctx);
  const here = el('div', {}, hereChips(ctx));
  ctx.onConfig = () => notice.replaceWith(noticeBox(ctx));
  ctx.onCrew = () => here.replaceChildren(hereChips(ctx));
  ctx.cleanup = () => { ctx.onConfig = null; ctx.onCrew = null; };
  ctx.main.replaceChildren(
    notice,
    el('section', { class: 'b-sec' }, el('h2', { class: 'sh' }, 'Boards'), el('p', { class: 'soon' }, 'The boards open soon.')),
    el('section', { class: 'b-sec' }, el('h2', { class: 'sh' }, 'In the shop now'), here),
  );
}
