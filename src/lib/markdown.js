// markdown.js: turns member-written Markdown into safe HTML.
//
// Every bit of user text that is shown as formatted HTML goes through
// renderMarkdown(). Steps:
//   1. `marked` converts Markdown to HTML.
//   2. `DOMPurify` removes anything not on a short allow-list: no scripts,
//      no styles, no event handlers, no iframes, no images (for now), no
//      javascript: links.
//   3. Links get rel="nofollow ugc noopener noreferrer" and open in a new tab.
//
// Plain fields (handles, titles) are never rendered as HTML at all; pages set
// them with textContent.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.use({ gfm: true, breaks: true });

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];
const ALLOWED_ATTR = ['href', 'title'];
// http(s), mailto, and links within this site.
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|\/(?!\/)|#)/i;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'nofollow ugc noopener noreferrer');
    node.setAttribute('target', '_blank');
  }
});

/** Markdown in, sanitized HTML string out. Safe to assign to innerHTML. */
export function renderMarkdown(text) {
  const html = marked.parse(String(text ?? ''), { async: false });
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP });
}
