// library-doc.js: the /wiki/{slug} page. One library item.
//
//   page items: rendered Markdown (sanitized), plus an optional attached file
//   file items: description and a Download button with the file size
// Also: related items from the same folder, "Discuss in the forum", and for
// the sysop: Edit, Publish/Unpublish, Delete.

import { mountHeader } from '../lib/header.js';
import { watchSession, currentSession } from '../lib/session.js';
import { FOLDERS, getItem, relatedItems, fileUrl, formatSize, saveItem, deleteItem } from '../lib/library.js';
import { el, setMarkdown, timeEl } from '../lib/ui.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
let item = null;
let loadedAsSysop = null;

const folderLabel = (id) => FOLDERS.find(([f]) => f === id)?.[1] ?? id;

function notFound() {
  document.title = 'Not found · Garage Terminal';
  $('d-title').textContent = 'Not in the library';
  $('d-status').hidden = false;
  $('d-status').replaceChildren('That document doesn’t exist, or it was removed. ', el('a', { href: '/wiki' }, 'Browse the library.'));
  $('d-article').hidden = true;
  $('d-after').hidden = true;
}

async function render() {
  if (!item) return notFound();
  document.title = `${item.title} · Garage Terminal`;
  $('d-title').textContent = item.title;
  $('d-folder').textContent = folderLabel(item.folder);
  $('d-folder').href = `/wiki?folder=${item.folder}`;
  $('d-tags').replaceChildren(...[
    el('span', { class: 'tag tag-type' }, item.type),
    item.status === 'draft' ? el('span', { class: 'tag tag-hidden' }, 'DRAFT') : null,
  ].filter(Boolean));
  $('d-meta').replaceChildren('Updated ', timeEl(item.updatedAt), ` · ${folderLabel(item.folder)}`);
  $('d-desc').textContent = item.description;
  $('d-desc').hidden = !item.description;
  $('d-status').hidden = true;
  $('d-article').hidden = false;

  // Written page
  $('d-body').hidden = item.kind !== 'page' || !item.body;
  if (item.kind === 'page' && item.body) setMarkdown($('d-body'), item.body);

  // File (the main thing for file items; an attachment for pages)
  const box = $('d-download');
  box.hidden = !item.storagePath;
  if (item.storagePath) {
    box.replaceChildren(el('p', { class: 'mutedt small' }, 'preparing download…'));
    try {
      const url = await fileUrl(item);
      box.replaceChildren(
        el('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' },
          `↓ ${item.kind === 'page' ? 'Attachment' : 'Download'} · ${item.type} · ${formatSize(item.size)}`),
        el('p', { class: 'mutedt small file-name' }, item.fileName));
    } catch (err) {
      console.error(err);
      box.replaceChildren(el('p', { class: 'field-status', dataset: { kind: 'bad' } }, 'The file isn’t available right now.'));
    }
  }

  // Discuss + related
  $('d-after').hidden = false;
  $('d-discuss').href = `/forum/new?area=general&title=${encodeURIComponent(`Re: ${item.title}`.slice(0, 120))}`;
  relatedItems(item).then((rel) => {
    $('d-related-box').hidden = !rel.length;
    $('d-related-title').textContent = `More in ${folderLabel(item.folder)}`;
    $('d-related').replaceChildren(...rel.map((r) => el('li', { class: 'thread' },
      el('a', { href: `/wiki/${encodeURIComponent(r.id)}` },
        el('span', { class: 'thread-title' }, el('span', { class: 'tag tag-type' }, r.type), r.title),
        el('span', { class: 'thread-meta' }, 'updated ', timeEl(r.updatedAt))))));
  }).catch(() => {});

  renderSysop();
}

// ---------- sysop tools ------------------------------------------------------------

function renderSysop() {
  const s = currentSession();
  const bar = $('d-sysop');
  bar.hidden = !(s.state === 'member' && s.isSysop && item);
  if (bar.hidden) return;
  const btn = (label, onclick, cls = 'link-btn') => el('button', { class: cls, type: 'button', onclick }, label);
  bar.replaceChildren(
    el('span', { class: 'modbar-label' }, 'SYSOP'),
    el('a', { class: 'link-btn', href: `/wiki/add?edit=${encodeURIComponent(item.id)}` }, 'Edit'),
    btn(item.status === 'draft' ? 'Publish' : 'Unpublish (make draft)', async () => {
      try {
        await saveItem(s.user.uid, item.id, { ...item, status: item.status === 'draft' ? 'published' : 'draft' }, item);
        item = await getItem(slug);
        render();
      } catch (err) {
        console.error(err);
        alert('Couldn’t change it. Try again.');
      }
    }, 'link-btn mod'),
    btn('Delete', async () => {
      if (!confirm(`Delete “${item.title}”${item.storagePath ? ' and its file' : ''}? This can’t be undone.`)) return;
      try {
        await deleteItem(item);
        location.href = '/wiki';
      } catch (err) {
        console.error(err);
        alert('Couldn’t delete it. Try again.');
      }
    }, 'link-btn danger'),
  );
}

// ---------- load (again once we know if it's the sysop, who can see drafts) -------

watchSession(async (s) => {
  if (s.state === 'loading') return;
  const sysop = s.state === 'member' && s.isSysop;
  if (!slug) return (location.href = '/wiki');
  if (sysop === loadedAsSysop) return renderSysop();
  loadedAsSysop = sysop;
  item = await getItem(slug);
  render();
});
