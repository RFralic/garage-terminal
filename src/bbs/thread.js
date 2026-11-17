// thread.js: one thread (#t/<id>): the opening post and replies, oldest first, and a reply
// box. Posts are Markdown (the forum's safe renderer) with an optional photo.
// Authors edit or delete their own posts; the sysop and co-sysops delete any post and
// lock or pin threads. Posts saved from Shop Talk show where they came from.
import { el, setMarkdown, timeAgo, timeEl } from '../lib/ui.js';
import { addReply, deletePost, deleteThread, editPost, fileUrl, setThreadFlags, uploadPostPhoto, watchPosts, watchThread } from './data.js';
import { composer } from './compose.js';

function photoEl(photo) {
  if (!photo?.path) return null;
  const img = el('img', { class: 'pphoto', alt: 'Photo', width: photo.w, height: photo.h, loading: 'lazy' });
  fileUrl(photo.path).then((u) => { img.src = u; }).catch(() => img.replaceWith(el('span', { class: 'small dim' }, '[photo unavailable]')));
  const a = el('a', { class: 'pphoto-link', target: '_blank', rel: 'noopener' }, img);
  fileUrl(photo.path).then((u) => { a.href = u; }).catch(() => {});
  return a;
}

function savedBox(saved) {
  if (!saved) return null;
  const at = saved.at?.toDate ? saved.at.toDate() : null;
  const when = at ? at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  return el('div', { class: 'savedfrom' },
    el('span', { class: 'label' }, `Saved from Shop Talk · ${saved.who}${when ? ` · ${when}` : ''}`),
    saved.text ? el('blockquote', { class: 'quote' }, saved.text) : null);
}

function postEl(ctx, thread, p) {
  const mine = p.authorUid === ctx.uid;
  const body = el('div', { class: 'md' });
  setMarkdown(body, p.body || '');
  const actions = el('div', { class: 'pactions' });
  if (mine && !thread.locked) {
    actions.append(el('button', { class: 'link', type: 'button', onclick: () => {
      const ta = el('textarea', { class: 'input', rows: 6, maxlength: '10000', 'aria-label': 'Edit post' });
      ta.value = p.body || '';
      const save = el('button', { class: 'btn primary sm', type: 'button', onclick: async () => {
        if (!ta.value.trim() && !p.photo) return;
        save.disabled = true;
        try { await editPost(thread.id, p.id, ta.value.trim()); } catch { alert('Couldn’t save the edit.'); save.disabled = false; }
      } }, 'Save');
      body.replaceWith(el('div', { class: 'form' }, ta, el('div', { class: 'row' }, save,
        el('button', { class: 'btn sm', type: 'button', onclick: () => ctx.refresh?.() }, 'Cancel'))));
      ta.focus();
    } }, 'Edit'));
  }
  const canDelete = (mine || ctx.isMod);
  if (canDelete) {
    actions.append(el('button', { class: 'link', type: 'button', style: 'color:var(--b-err)', onclick: async () => {
      const whole = p.id === 'op';
      if (!confirm(whole ? 'Delete this whole thread and its replies?' : 'Delete this post?')) return;
      try {
        if (whole) { await deleteThread(thread.id); location.hash = `boards/${thread.boardId}`; } else await deletePost(thread.id, p.id);
      } catch { alert('Couldn’t delete it.'); }
    } }, p.id === 'op' ? 'Delete thread' : 'Delete'));
  }
  return el('article', { class: 'post', id: `p-${p.id}` },
    el('header', {}, el('b', { class: 'mono' }, p.authorHandle), el('span', { class: 'mono small dim' }, ' · ', timeEl(p.createdAt), p.editedAt ? ' · edited' : '')),
    savedBox(p.saved), body, photoEl(p.photo),
    p.saved?.note ? el('p', { class: 'small', style: 'margin:0' }, el('span', { class: 'dim' }, `Note from ${p.authorHandle}: `), p.saved.note) : null,
    actions.childNodes.length ? actions : null);
}

export async function renderThread(ctx, [threadId]) {
  let thread = null, posts = [];
  const head = el('div', { class: 'b-sec' });
  const list = el('div', { class: 'posts' }, el('p', { class: 'modem' }, 'loading…'));
  const reply = el('div');
  const draw = () => {
    if (!thread) return;
    const board = ctx.boards.find((b) => b.id === thread.boardId);
    head.replaceChildren(...[
      el('a', { class: 'link', href: `#boards/${thread.boardId}` }, `← ${board ? board.name : 'Board'}`),
      el('h2', { class: 'sh', style: 'overflow-wrap:anywhere' }, thread.title),
      el('p', { class: 'small muted', style: 'margin:0' }, `${thread.replyCount} repl${thread.replyCount === 1 ? 'y' : 'ies'} · last ${timeAgo(thread.lastAt)}`,
        thread.pinned ? ' · Pinned' : '', thread.locked ? ' · Locked' : ''),
      ctx.isMod ? el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', onclick: () => setThreadFlags(thread.id, { pinned: !thread.pinned, locked: !!thread.locked }) }, thread.pinned ? 'Unpin' : 'Pin'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => setThreadFlags(thread.id, { pinned: !!thread.pinned, locked: !thread.locked }) }, thread.locked ? 'Unlock' : 'Lock')) : null,
    ].filter(Boolean));
    list.replaceChildren(...posts.map((p) => postEl(ctx, thread, p)));
    const archived = board?.archived;
    if (thread.locked || archived) reply.replaceChildren(el('p', { class: 'soon' }, archived ? 'This board is archived: read only.' : 'This thread is locked.'));
    else if (!reply.firstChild || reply.firstChild.classList.contains('soon')) {
      reply.replaceChildren(composer({
        label: 'Reply', button: 'Post reply',
        onSubmit: async ({ body, file, progress }) => {
          const photo = file ? await uploadPostPhoto(ctx.uid, file, progress) : null;
          await addReply({ uid: ctx.uid, handle: ctx.handle, threadId: thread.id, body, photo });
          setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 300);
        },
      }));
    }
  };
  const stops = [
    watchThread(threadId, (t) => {
      if (!t) { ctx.main.replaceChildren(el('p', { class: 'soon' }, 'That thread is gone.'), el('a', { class: 'link', href: '#boards' }, '← All boards')); return; }
      thread = t; draw();
    }, () => ctx.main.replaceChildren(el('p', { class: 'err' }, 'Couldn’t load this thread.'))),
    watchPosts(threadId, (ps) => { posts = ps; draw(); }, () => {}),
  ];
  ctx.cleanup = () => stops.forEach((s) => s());
  ctx.refresh = draw;
  ctx.main.replaceChildren(head, list, reply);
}
