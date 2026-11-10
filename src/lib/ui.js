// ui.js: small DOM helpers shared by the pages.
//
// el() always sets text with textContent, so user text can't turn into HTML.
// The only place HTML from user text is inserted is via renderMarkdown()
// (src/lib/markdown.js), which sanitizes it first.

import { renderMarkdown } from './markdown.js';

/** Make an element: el('a', { class: 'x', href: '/y' }, 'text', childNode, ...) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Fill `node` with sanitized HTML rendered from Markdown. */
export function setMarkdown(node, text) {
  node.innerHTML = renderMarkdown(text);
}

/** "just now", "5m ago", "3h ago", "2d ago", or a date like "Nov 9" / "Nov 9, 2025". */
export function timeAgo(date) {
  if (!date) return '';
  const d = date.toDate ? date.toDate() : date;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** A <time> element showing timeAgo(), with the full date on hover. */
export function timeEl(date) {
  if (!date) return el('time', {}, '');
  const d = date.toDate ? date.toDate() : date;
  return el('time', { datetime: d.toISOString(), title: d.toLocaleString() }, timeAgo(d));
}

/**
 * Wire up a Markdown composer: a textarea, a Write/Preview toggle and a
 * character counter. Expects these elements inside `root`:
 *   textarea, [data-preview-toggle], [data-preview], [data-counter]
 */
export function setupComposer(root, maxLength) {
  const textarea = root.querySelector('textarea');
  const toggle = root.querySelector('[data-preview-toggle]');
  const preview = root.querySelector('[data-preview]');
  const counter = root.querySelector('[data-counter]');

  const update = () => {
    const n = textarea.value.length;
    counter.textContent = `${n.toLocaleString()} / ${maxLength.toLocaleString()}`;
    counter.dataset.over = n > maxLength ? 'true' : 'false';
  };
  textarea.addEventListener('input', update);
  update();

  toggle.addEventListener('click', () => {
    const showing = !preview.hidden;
    if (showing) {
      preview.hidden = true;
      textarea.hidden = false;
      toggle.textContent = 'Preview';
      textarea.focus();
    } else {
      setMarkdown(preview, textarea.value.trim() ? textarea.value : '_Nothing to preview._');
      preview.hidden = false;
      textarea.hidden = true;
      toggle.textContent = 'Write';
    }
  });

  return {
    textarea,
    reset() {
      textarea.value = '';
      preview.hidden = true;
      textarea.hidden = false;
      toggle.textContent = 'Preview';
      update();
    },
  };
}
