// files.js: the file cabinet (#files). Members-only, separate from the public Wiki & library.
// Any member uploads (PDF, photos, ZIP, text, office documents; 25 MB each) with a title
// and an optional note. Each file shows type, size, who added it and when, and a download
// button; the uploader and the sysop / co-sysops can delete. Searchable by title.
import { el, timeAgo } from '../lib/ui.js';
import { addFile, deleteFile, fileKind, fileUrl, fmtSize, markRead, MAX_FILE } from './data.js';

const DOWNLOAD = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M6 11l6 6 6-6M5 20h14"/></svg>';

/** One file row (also used on the home page). */
export function fileRow(ctx, f, { withDelete = false } = {}) {
  const dl = el('button', { class: 'iconbtn primary', type: 'button', 'aria-label': `Download ${f.title}` });
  dl.innerHTML = DOWNLOAD;
  dl.addEventListener('click', async () => {
    dl.disabled = true;
    try {
      const url = await fileUrl(f.path);
      const a = el('a', { href: url, target: '_blank', rel: 'noopener', download: f.name });
      document.body.append(a); a.click(); a.remove();
    } catch { alert('Couldn’t get that file. Try again.'); } finally { dl.disabled = false; }
  });
  const canDelete = withDelete && (f.byUid === ctx.uid || ctx.isMod);
  const del = canDelete ? el('button', { class: 'link', type: 'button', style: 'color:var(--b-err)', onclick: async () => {
    if (!confirm(`Delete “${f.title}” from the file cabinet?`)) return;
    try { await deleteFile(f.id); } catch { alert('Couldn’t delete it.'); }
  } }, 'Delete') : null;
  return el('li', {},
    el('span', { class: 'ftype', 'aria-hidden': 'true' }, f.type),
    el('span', { class: 'main' }, el('b', {}, f.title),
      el('span', { class: 'small muted' }, `${fmtSize(f.size)} · ${f.byHandle} · ${timeAgo(f.createdAt)}`),
      f.note && withDelete ? el('span', { class: 'small', style: 'overflow-wrap:anywhere' }, f.note) : null,
      del),
    dl);
}

export async function renderFiles(ctx) {
  markRead(ctx.uid, 'files').then(() => ctx.recount?.());
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search by title', 'aria-label': 'Search files by title', autocomplete: 'off' });
  const list = el('ul', { class: 'panel rows' });
  const count = el('span', { class: 'mono small dim' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = ctx.files.filter((f) => !q || f.titleLower.includes(q));
    count.textContent = `${ctx.files.length} file${ctx.files.length === 1 ? '' : 's'}`;
    list.replaceChildren(...(shown.length ? shown.map((f) => fileRow(ctx, f, { withDelete: true }))
      : [el('li', { class: 'empty' }, q ? 'No file titles match.' : 'Nothing filed yet. Add the first one above.')]));
  };
  search.addEventListener('input', draw);

  // ---- add a file ----
  const file = el('input', { type: 'file', id: 'f-file', class: 'input', accept: '.pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.zip,.txt,.csv,.md,.rtf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods' });
  const title = el('input', { class: 'input', id: 'f-title', maxlength: '120', placeholder: 'e.g. 8N wiring diagram', autocomplete: 'off' });
  const note = el('input', { class: 'input', id: 'f-note', maxlength: '500', placeholder: 'Optional', autocomplete: 'off' });
  const msg = el('p', { class: 'small muted', role: 'status', style: 'margin:0' });
  const go = el('button', { class: 'btn primary', type: 'submit' }, 'Add to the cabinet');
  let autoTitle = ''; // the title we filled in from a file name (replaced when another file is picked)
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (f && (!title.value.trim() || title.value === autoTitle)) {
      autoTitle = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120);
      title.value = autoTitle;
    }
    msg.textContent = f ? (f.size > MAX_FILE ? 'That file is over 25 MB.' : !fileKind(f.name) ? 'That type of file isn’t allowed.' : '') : '';
  });
  const form = el('form', { class: 'panel form' },
    el('label', { for: 'f-file' }, 'File (PDF, photos, ZIP, text, office documents; 25 MB max)'), file,
    el('label', { for: 'f-title' }, 'Title'), title,
    el('label', { for: 'f-note' }, 'Note'), note, msg, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = file.files[0];
    if (!f) { msg.textContent = 'Pick a file first.'; return; }
    if (!title.value.trim()) { msg.textContent = 'Give it a title.'; title.focus(); return; }
    go.disabled = true;
    try {
      await addFile({ uid: ctx.uid, handle: ctx.handle, file: f, title: title.value.trim(), note: note.value.trim(),
        onProgress: (p) => { msg.textContent = `Uploading… ${Math.round(p * 100)}%`; } });
      form.reset();
      msg.textContent = 'Filed.';
      markRead(ctx.uid, 'files');
    } catch (err) {
      msg.textContent = /permission|unauthorized/i.test(err.code || err.message) ? 'That upload wasn’t allowed (type or size).' : err.message;
    } finally { go.disabled = false; }
  });

  ctx.refresh = draw;
  draw();
  ctx.main.replaceChildren(
    el('section', { class: 'b-sec' }, el('div', { class: 'sh-row' }, el('h2', { class: 'sh' }, 'The file cabinet'), count), search, list),
    el('section', { class: 'b-sec' }, el('h2', { class: 'sh' }, 'Add a file'), form));
}
