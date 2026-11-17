// board.js: one board (#boards/<id>): its threads, newest activity first (pinned on top),
// with title, author, reply count, last reply time and "NEW"; + New post.
// Opening a board counts as a visit, so its NEW marks clear next time.
import { el, timeAgo } from '../lib/ui.js';
import { boardNo, isNewThread, markRead, watchBoardThreads } from './data.js';

export function threadRow(ctx, t, fresh) {
  const who = t.saved ? `saved from Shop Talk by ${t.authorHandle}` : t.authorHandle;
  return el('li', {}, el('a', { class: 'trow', href: `#t/${t.id}` },
    el('span', { class: 'main' },
      el('span', { class: 'ttitle' }, t.pinned ? el('span', { class: 'badge', style: 'margin-right:6px' }, 'Pinned') : null,
        t.locked ? el('span', { class: 'badge', style: 'margin-right:6px' }, 'Locked') : null, t.title),
      el('span', { class: 'small muted' }, `${who} · ${t.replyCount} repl${t.replyCount === 1 ? 'y' : 'ies'} · ${t.replyCount ? 'last' : 'posted'} ${timeAgo(t.lastAt)}`)),
    fresh ? el('span', { class: 'newtag' }, 'NEW') : null));
}

export async function renderBoard(ctx, [boardId]) {
  const board = ctx.boards.find((b) => b.id === boardId);
  if (!board) { ctx.main.replaceChildren(el('p', { class: 'soon' }, 'That board isn’t here.'), el('a', { class: 'link', href: '#boards' }, '← All boards')); return; }
  const before = { boards: { ...(ctx.reads.boards || {}) } }; // NEW marks are measured from the previous visit
  markRead(ctx.uid, boardId).then(() => ctx.recount?.());
  const list = el('ul', { class: 'panel rows tlist' }, el('li', { class: 'empty' }, 'loading…'));
  const stop = watchBoardThreads(boardId, (threads) => {
    threads.sort((a, b) => (b.pinned === true) - (a.pinned === true));
    list.replaceChildren(...(threads.length ? threads.map((t) => threadRow(ctx, t, isNewThread(t, before, ctx.handle)))
      : [el('li', { class: 'empty' }, 'No posts yet. Start one.')]));
  }, () => list.replaceChildren(el('li', { class: 'empty' }, 'Couldn’t load this board.')));
  ctx.cleanup = stop;
  ctx.main.replaceChildren(
    el('a', { class: 'link', href: '#boards' }, '← All boards'),
    el('section', { class: 'b-sec' },
      el('div', { class: 'sh-row' },
        el('div', {}, el('span', { class: 'mono small dim' }, boardNo(board)), el('h2', { class: 'sh' }, board.name)),
        board.archived ? el('span', { class: 'badge' }, 'Archived: read only') : el('a', { class: 'btn light sm', href: `#new/${board.id}` }, '+ New post')),
      board.description ? el('p', { class: 'muted', style: 'margin:0' }, board.description) : null,
      list));
}
