// library.js: every read and write for the wiki / library.
//
// Data (see PLAN.md):
//   library/{slug}                  one item; the doc ID is its address /wiki/{slug}
//   Storage library/{slug}/{file}   the item's file, if it has one
//
// Anyone can read published items and download their files; drafts and all
// writes are sysop-only. firestore.rules and storage.rules enforce that.

import {
  collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, where,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from 'firebase/storage';
import { db, storage } from './firebase.js';

export const FOLDERS = [
  ['guides', '/guides'],
  ['manuals', '/manuals'],
  ['ebooks', '/ebooks'],
  ['files', '/files'],
];
export const TYPES = ['PDF', 'EPUB', 'GUIDE', 'MANUAL', 'DOC', 'SHEET', 'IMAGE', 'ZIP', 'TEXT', 'FILE'];
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------- small helpers --------------------------------------------------------

/** "Carb Rebuild: Part 2!" -> "carb-rebuild-part-2" */
export function slugify(text) {
  return String(text)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é -> e
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '');
}

/** Guess the type tag from a file name. */
export function typeFromFileName(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'PDF';
  if (ext === 'epub') return 'EPUB';
  if (['zip', '7z', 'rar', 'gz', 'tgz'].includes(ext)) return 'ZIP';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg'].includes(ext)) return 'IMAGE';
  if (['doc', 'docx', 'odt', 'rtf', 'pages'].includes(ext)) return 'DOC';
  if (['xls', 'xlsx', 'ods', 'csv', 'numbers'].includes(ext)) return 'SHEET';
  if (['txt', 'md'].includes(ext)) return 'TEXT';
  return 'FILE';
}

/** A file name that's safe in a Storage path (keeps the extension). */
export function safeFileName(name) {
  const clean = String(name).normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(-100);
  return clean || 'file';
}

/** 4404019 -> "4.2 MB" */
export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- reading ----------------------------------------------------------------

/** All items, newest first. Published only, unless includeDrafts (sysop). */
export async function listLibrary({ includeDrafts = false } = {}) {
  const q = includeDrafts
    ? query(collection(db, 'library'), orderBy('updatedAt', 'desc'), limit(500))
    : query(collection(db, 'library'), where('status', '==', 'published'), orderBy('updatedAt', 'desc'), limit(500));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** One item, or null if it doesn't exist or is a draft you can't see. */
export async function getItem(slug) {
  try {
    const snap = await getDoc(doc(db, 'library', slug));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch {
    return null; // drafts are refused for non-sysops: treat as not found
  }
}

/** Up to 5 other published items in the same folder. */
export async function relatedItems(item) {
  const snap = await getDocs(query(
    collection(db, 'library'),
    where('status', '==', 'published'),
    where('folder', '==', item.folder),
    orderBy('updatedAt', 'desc'),
    limit(6),
  ));
  return snap.docs.filter((d) => d.id !== item.id).slice(0, 5).map((d) => ({ id: d.id, ...d.data() }));
}

/** Download link for an item's file (the Storage rules are checked here). */
export function fileUrl(item) {
  return getDownloadURL(ref(storage, item.storagePath));
}

/** Simple search: every word must appear in the title or description. */
export function matches(item, text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${item.title} ${item.description}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

// ---------- writing (sysop) ----------------------------------------------------------

/**
 * Upload a file for an item. Calls onProgress(0..1) as it goes.
 * Returns the Storage details to save on the item.
 */
export function uploadItemFile(slug, file, onProgress = () => {}) {
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error('Files can be at most 50 MB.'));
  const fileName = safeFileName(file.name);
  const storagePath = `library/${slug}/${fileName}`;
  const task = uploadBytesResumable(ref(storage, storagePath), file, {
    contentType: file.type || 'application/octet-stream',
    // Open in the browser where possible, and keep the original name when saved.
    contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  });
  return new Promise((resolve, reject) => {
    task.on('state_changed',
      (s) => onProgress(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0),
      (err) => reject(new Error(err.code === 'storage/unauthorized' ? 'Upload refused (sysop only, max 50 MB).' : 'Upload failed. Check your connection and try again.')),
      () => resolve({ storagePath, fileName, size: file.size, contentType: file.type || '' }));
  });
}

/** Delete a file from Storage, ignoring "already gone". */
export async function deleteFile(storagePath) {
  if (!storagePath) return;
  try {
    await deleteObject(ref(storage, storagePath));
  } catch (err) {
    if (err.code !== 'storage/object-not-found') throw err;
  }
}

/**
 * Create or update an item. `existing` is the item as loaded (for edits).
 * Fields match the rules in firestore.rules (validLibraryItem).
 */
export async function saveItem(uid, slug, fields, existing = null) {
  await setDoc(doc(db, 'library', slug), {
    slug,
    title: fields.title.trim(),
    folder: fields.folder,
    kind: fields.kind,
    type: fields.type,
    description: fields.description.trim(),
    body: fields.body ?? '',
    storagePath: fields.storagePath ?? '',
    fileName: fields.fileName ?? '',
    size: fields.size ?? 0,
    contentType: fields.contentType ?? '',
    status: fields.status,
    createdAt: existing ? existing.createdAt : serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });
}

/** Delete an item and its file. */
export async function deleteItem(item) {
  await deleteFile(item.storagePath);
  await deleteDoc(doc(db, 'library', item.id));
}

/** True if no item uses this address yet (sysop can see drafts too). */
export async function isSlugFree(slug) {
  const snap = await getDoc(doc(db, 'library', slug));
  return !snap.exists();
}
