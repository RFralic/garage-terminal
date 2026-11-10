// common.js: loaded by plain pages (home, 404). Adds the sign-in status line
// to the header.
//
// The sign-in code (Firebase) is the biggest download on the site, so it's
// loaded once the page has appeared: the first screen shows a little sooner on
// phones, and the header line fills in a moment later. The header keeps its
// space reserved, so nothing jumps.

const start = () => import('../lib/header.js').then((m) => m.mountHeader());

if ('requestIdleCallback' in window) {
  requestIdleCallback(start, { timeout: 1500 });
} else {
  setTimeout(start, 200);
}
