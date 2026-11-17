// compose.js: the post box (text + optional photo) and the new-post screen (#new or #new/<board>).
// "Quote in a new post" from Shop Talk arrives as ctx.draft = { body }.
import { el } from '../lib/ui.js';
import { boardNo, createThread, uploadPostPhoto } from './data.js';

const CAMERA = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>';

/** A text box with a photo button. onSubmit({ body, file, progress }) may throw to show an error. */
export function composer({ label, button, body = '', onSubmit, extra = [] }) {
  const id = `c-${Math.random().toString(36).slice(2, 8)}`;
  const ta = el('textarea', { class: 'input', id, rows: 5, maxlength: '10000', placeholder: 'Write it here. Links and **bold** work.' });
  ta.value = body;
  const pick = el('input', { type: 'file', accept: 'image/*', class: 'sr', id: `${id}-p`, tabindex: '-1' });
  const photoBtn = el('label', { class: 'iconbtn', for: `${id}-p`, role: 'button', tabindex: '0', 'aria-label': 'Add a photo' });
  photoBtn.innerHTML = CAMERA;
  photoBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.click(); } });
  const chosen = el('span', { class: 'small muted' });
  pick.addEventListener('change', () => { chosen.textContent = pick.files[0] ? `Photo: ${pick.files[0].name}` : ''; });
  const msg = el('p', { class: 'small', role: 'status', style: 'margin:0' });
  const go = el('button', { class: 'btn primary', type: 'submit' }, button);
  const form = el('form', { class: 'form' }, ...extra, el('label', { for: id }, label), ta,
    el('div', { class: 'row' }, photoBtn, pick, chosen), msg, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    const file = pick.files[0] || null;
    if (!text && !file) { msg.textContent = 'Write something or add a photo.'; ta.focus(); return; }
    go.disabled = true;
    msg.textContent = file ? 'Shrinking the photo…' : 'Posting…';
    try {
      await onSubmit({ body: text, file, progress: (p) => { msg.textContent = `Uploading the photo… ${Math.round(p * 100)}%`; } });
      form.reset(); chosen.textContent = ''; msg.textContent = '';
    } catch (err) {
      console.error(err);
      msg.textContent = /permission/i.test(err.code || err.message) ? 'That wasn’t allowed (is the thread locked?).' : (err.message || 'Couldn’t post. Try again.');
    } finally { go.disabled = false; }
  });
  return form;
}

export async function renderNew(ctx, [boardId]) {
  const open = ctx.boards.filter((b) => !b.archived);
  const sel = el('select', { class: 'input', id: 'n-board' }, ...open.map((b) => el('option', { value: b.id }, `${boardNo(b)} ${b.name}`)));
  sel.value = open.some((b) => b.id === boardId) ? boardId : (open[0]?.id ?? '');
  const title = el('input', { class: 'input', id: 'n-title', maxlength: '120', autocomplete: 'off' });
  const draft = ctx.draft; ctx.draft = null;
  if (draft?.title) title.value = draft.title;
  const form = composer({
    label: 'Post', button: 'Post it', body: draft?.body || '',
    extra: [el('label', { for: 'n-board' }, 'Board'), sel, el('label', { for: 'n-title' }, 'Title'), title],
    onSubmit: async ({ body, file, progress }) => {
      const t = title.value.trim();
      if (!t) { title.focus(); throw new Error('Give it a title.'); }
      if (!sel.value) throw new Error('Pick a board.');
      const photo = file ? await uploadPostPhoto(ctx.uid, file, progress) : null;
      const id = await createThread({ uid: ctx.uid, handle: ctx.handle, boardId: sel.value, title: t, body, photo });
      location.hash = `t/${id}`;
    },
  });
  ctx.main.replaceChildren(
    el('a', { class: 'link', href: boardId ? `#boards/${boardId}` : '#boards' }, '← Back'),
    el('section', { class: 'b-sec' }, el('h2', { class: 'sh' }, 'New post'), el('div', { class: 'panel', style: 'padding:12px' }, form)));
  (draft ? title : title).focus();
}
