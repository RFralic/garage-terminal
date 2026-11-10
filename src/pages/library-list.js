// library-list.js: the /wiki page. Search, folder filter with counts, item list.
//
// URL: /wiki?folder=manuals&q=carb   (both optional; kept in sync as you type)
// Search runs in the browser over the loaded items (fine for a few hundred).
// The sysop also sees drafts (tagged DRAFT) and an "Add to library" button.

import { mountHeader } from '../lib/header.js';
import { watchSession, currentSession } from '../lib/session.js';
import { FOLDERS, listLibrary, matches, formatSize } from '../lib/library.js';
import { el, timeEl } from '../lib/ui.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let folder = FOLDERS.some(([id]) => id === params.get('folder')) ? params.get('folder') : '';
let items = [];
let loadedAsSysop = null;
$('l-search').value = params.get('q') || '';

// ---------- render --------------------------------------------------------------

function renderFolders() {
  const searched = items.filter((i) => matches(i, $('l-search').value));
  const count = (id) => searched.filter((i) => !id || i.folder === id).length;
  const chip = (id, label) => el('a', {
    class: 'chip', href: id ? `/wiki?folder=${id}` : '/wiki', 'aria-current': id === folder ? 'true' : false,
    onclick: (e) => { e.preventDefault(); folder = id; update(); },
  }, `${label} `, el('span', { class: 'chip-count' }, String(count(id))));
  $('l-folders').replaceChildren(chip('', 'All'), ...FOLDERS.map(([id, label]) => chip(id, label)));
}

function row(item) {
  const folderLabel = FOLDERS.find(([id]) => id === item.folder)?.[1] ?? item.folder;
  return el('li', { class: item.status === 'draft' ? 'thread is-hidden' : 'thread' },
    el('a', { href: `/wiki/${encodeURIComponent(item.id)}` },
      el('span', { class: 'thread-title' },
        el('span', { class: 'tag tag-type' }, item.type),
        item.status === 'draft' ? el('span', { class: 'tag tag-hidden' }, 'DRAFT') : null,
        item.title),
      item.description ? el('span', { class: 'lib-row-desc' }, item.description) : null,
      el('span', { class: 'thread-meta' },
        el('span', { class: 'area-key lib-folder' }, folderLabel),
        item.size ? el('span', {}, formatSize(item.size)) : null,
        el('span', {}, 'updated ', timeEl(item.updatedAt)))));
}

function update() {
  const q = $('l-search').value;
  const url = new URLSearchParams();
  if (folder) url.set('folder', folder);
  if (q.trim()) url.set('q', q.trim());
  history.replaceState(null, '', `/wiki${url.toString() ? `?${url}` : ''}`);
  $('l-file').textContent = folder ? `${folder}.txt` : 'library.txt';

  renderFolders();
  const shown = items.filter((i) => (!folder || i.folder === folder) && matches(i, q));
  $('l-list').replaceChildren(...shown.map(row));
  const status = $('l-status');
  status.hidden = shown.length > 0;
  if (!items.length) status.textContent = '> Library is being stocked. Check back soon.';
  else if (!shown.length) status.textContent = q.trim() ? `> No matches for “${q.trim()}”.` : '> Nothing in this folder yet.';
}

$('l-search').addEventListener('input', update);

// ---------- load (again if the reader turns out to be the sysop) ----------------

async function load() {
  const s = currentSession();
  const sysop = s.state === 'member' && s.isSysop;
  if (sysop === loadedAsSysop) return;
  loadedAsSysop = sysop;
  try {
    items = await listLibrary({ includeDrafts: sysop });
  } catch (err) {
    console.error(err);
    $('l-status').textContent = 'Couldn’t load the library. Try again shortly.';
    return;
  }
  update();
}

watchSession((s) => {
  if (s.state === 'loading') return;
  $('l-add').hidden = !(s.state === 'member' && s.isSysop);
  load();
});
