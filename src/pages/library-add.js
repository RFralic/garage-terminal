// library-add.js: the /wiki/add page (sysop only). Upload a file or write a
// page, then Save as draft or Publish. /wiki/add?edit={slug} edits an item.
//
// Order of operations when saving:
//   1. upload the new file (if one was chosen), with a progress bar
//   2. save the library/{slug} doc
//   3. if the file was replaced, delete the old one
// The page checks things for a nicer experience; firestore.rules and
// storage.rules enforce them.

import { mountHeader } from '../lib/header.js';
import { watchSession, currentSession } from '../lib/session.js';
import {
  FOLDERS, TYPES, SLUG_PATTERN, MAX_FILE_BYTES, slugify, typeFromFileName, formatSize,
  getItem, isSlugFree, uploadItemFile, saveItem, deleteFile,
} from '../lib/library.js';
import { el, setupComposer } from '../lib/ui.js';

mountHeader();

const $ = (id) => document.getElementById(id);
const form = $('a-form');
const editSlug = new URLSearchParams(location.search).get('edit') || '';
let existing = null; // the item being edited, if any
let slugTouched = false; // stop auto-filling the address once you edit it
let started = false;
const composer = setupComposer(form.querySelector('[data-composer]'), 100000);

// ---------- dropdowns --------------------------------------------------------------

$('a-folder').replaceChildren(...FOLDERS.map(([id, label]) => el('option', { value: id }, label)));
$('a-type').replaceChildren(...TYPES.map((t) => el('option', { value: t }, t)));

const kind = () => form.querySelector('input[name=kind]:checked').value;

/** Show the parts of the form that fit the chosen kind. */
function showKind() {
  const isFile = kind() === 'file';
  $('a-file-box').hidden = !isFile;
  $('a-attach-box').hidden = isFile;
  $('a-body-label').textContent = isFile ? 'Notes (optional, Markdown)' : 'Page text (Markdown)';
  if (!existing && !$('a-file').files[0]) $('a-type').value = isFile ? 'PDF' : 'GUIDE';
}
form.querySelectorAll('input[name=kind]').forEach((r) => r.addEventListener('change', showKind));

// Picking a file fills in the type, and the title if it's empty.
$('a-file').addEventListener('change', () => {
  const file = $('a-file').files[0];
  if (!file) return;
  $('a-type').value = typeFromFileName(file.name);
  if (!$('a-title').value.trim()) {
    $('a-title').value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    $('a-title').dispatchEvent(new Event('input'));
  }
  if (file.size > MAX_FILE_BYTES) $('a-error').textContent = `That file is ${formatSize(file.size)}; the limit is 50 MB.`;
  else $('a-error').textContent = '';
});

// ---------- address (slug) ---------------------------------------------------------

let slugCheck = 0;
async function checkSlug() {
  const status = $('a-slug-status');
  const slug = $('a-slug').value;
  if (existing) return true;
  if (!SLUG_PATTERN.test(slug)) {
    status.dataset.kind = 'bad';
    status.textContent = 'Use lowercase letters, numbers and single dashes (e.g. carb-rebuild-guide).';
    return false;
  }
  const mine = ++slugCheck;
  const free = await isSlugFree(slug);
  if (mine !== slugCheck) return free;
  status.dataset.kind = free ? 'ok' : 'bad';
  status.textContent = free ? `/wiki/${slug} is available` : `/wiki/${slug} is already used. Pick another.`;
  return free;
}

$('a-title').addEventListener('input', () => {
  if (!slugTouched && !existing) {
    $('a-slug').value = slugify($('a-title').value);
    checkSlug();
  }
});
$('a-slug').addEventListener('input', () => {
  slugTouched = true;
  checkSlug();
});

// ---------- who can see the form; load an item to edit -----------------------------

watchSession(async (s) => {
  if (s.state === 'loading' || started) return;
  const sysop = s.state === 'member' && s.isSysop;
  if (!sysop) {
    $('a-gate').replaceChildren('Only the sysop can add to the library. ', el('a', { href: '/wiki' }, 'Browse the library.'));
    return;
  }
  started = true;

  if (editSlug) {
    existing = await getItem(editSlug);
    if (!existing) {
      $('a-gate').replaceChildren('That item doesn’t exist. ', el('a', { href: '/wiki/add' }, 'Add a new one.'));
      return;
    }
    fillForm(existing);
  }
  showKind();
  $('a-gate').hidden = true;
  form.hidden = false;
});

function fillForm(item) {
  document.title = `Edit ${item.title} · Garage Terminal`;
  $('a-heading').textContent = '> edit library item';
  form.querySelector(`input[name=kind][value=${item.kind}]`).checked = true;
  form.querySelectorAll('input[name=kind]').forEach((r) => { r.disabled = true; });
  $('a-title').value = item.title;
  $('a-slug').value = item.id;
  $('a-slug').readOnly = true;
  $('a-slug-status').textContent = 'The address can’t change once saved.';
  $('a-folder').value = item.folder;
  $('a-type').value = item.type;
  $('a-desc').value = item.description;
  composer.textarea.value = item.body || '';
  composer.textarea.dispatchEvent(new Event('input'));
  if (item.storagePath) {
    $('a-current-file').hidden = false;
    $('a-current-file').textContent = `Current file: ${item.fileName} (${formatSize(item.size)}). Choose a new one to replace it.`;
    $('a-file-label').textContent = 'Replace file (optional, max 50 MB)';
  }
  $('a-publish').textContent = item.status === 'published' ? 'Save (published)' : 'Publish';
  $('a-draft').textContent = item.status === 'draft' ? 'Save draft' : 'Save as draft (unpublish)';
}

// ---------- save -----------------------------------------------------------------------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = e.submitter?.value === 'draft' ? 'draft' : 'published';
  const error = $('a-error');
  const isFile = kind() === 'file';
  const slug = $('a-slug').value;
  const newFile = (isFile ? $('a-file') : $('a-attach')).files[0] || null;

  // Friendly checks first.
  let problem = '';
  if (!$('a-title').value.trim()) problem = 'Give it a title.';
  else if (isFile && !newFile && !existing?.storagePath) problem = 'Choose a file to upload.';
  else if (newFile && newFile.size > MAX_FILE_BYTES) problem = 'Files can be at most 50 MB.';
  else if (!isFile && !composer.textarea.value.trim()) problem = 'Write the page text.';
  else if (!existing && !(await checkSlug())) problem = 'Fix the address first.';
  error.textContent = problem;
  if (problem) return;

  const buttons = [$('a-publish'), $('a-draft')];
  buttons.forEach((b) => { b.disabled = true; });
  const progress = $('a-progress');

  try {
    // 1. upload
    let file = existing
      ? { storagePath: existing.storagePath, fileName: existing.fileName, size: existing.size, contentType: existing.contentType }
      : { storagePath: '', fileName: '', size: 0, contentType: '' };
    if (newFile) {
      progress.hidden = false;
      error.dataset.kind = 'wait';
      file = await uploadItemFile(slug, newFile, (p) => {
        progress.value = p;
        error.textContent = `uploading… ${Math.round(p * 100)}%`;
      });
    }

    // 2. save the item
    error.dataset.kind = 'wait';
    error.textContent = 'saving…';
    await saveItem(currentSession().user.uid, slug, {
      kind: isFile ? 'file' : 'page',
      title: $('a-title').value,
      folder: $('a-folder').value,
      type: $('a-type').value,
      description: $('a-desc').value,
      body: composer.textarea.value,
      ...file,
      status,
    }, existing);

    // 3. remove a replaced file
    if (existing?.storagePath && existing.storagePath !== file.storagePath) {
      await deleteFile(existing.storagePath).catch(() => {});
    }
    location.href = `/wiki/${encodeURIComponent(slug)}`;
  } catch (err) {
    console.error(err);
    error.dataset.kind = 'bad';
    error.textContent = err.message?.startsWith('Upload') || err.message?.startsWith('Files')
      ? err.message
      : 'Couldn’t save. Check the fields and try again.';
    buttons.forEach((b) => { b.disabled = false; });
    progress.hidden = true;
  }
});
