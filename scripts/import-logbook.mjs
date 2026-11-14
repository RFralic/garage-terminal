// import-logbook.mjs: builds apps/logbook/index.html and
// apps/project-tracker/index.html from the Engine & Vehicle Logbook's own pages
// (github.com/RFralic/vehicle_logbook, folder public/).
//
//   node scripts/import-logbook.mjs path/to/vehicle_logbook/public
//
// The apps' styles, markup and code are copied unchanged, except for these
// marked Garage Terminal changes:
//   1. page head: title, icons and the Logbook's home-screen manifest on this site
//   2. a thin bar at the top: "< garage_terminal" link + who's signed in
//   3. sign-in and storage: the page's own Firebase setup (another project) is
//      replaced by src/apps/logbook-backend.js, which hands it this site's
//      Google sign-in and Firestore, with the offline cache switched on
//   4. links between the two apps point at their new addresses
//   5. offline: the old /sw.js is replaced by /apps/sw.js (public/apps/sw.js)
// The script stops with an error if a page changed in a way these edits no
// longer fit, rather than producing a broken page.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = process.argv[2];
if (!srcDir) {
  console.error('Usage: node scripts/import-logbook.mjs path/to/vehicle_logbook/public');
  process.exit(1);
}

function count(h, n) { return h.split(n).length - 1; }
function swap(h, from, to, what, times = 1) {
  const n = count(h, from);
  if (n !== times) throw new Error(`Expected "${what}" ${times}× in the page, found ${n}. The Logbook has changed; update this script.`);
  return h.split(from).join(to);
}
/** Replaces the page's one <script type="module">…</script> (its old Firebase setup). */
function swapFirebaseModule(h, to, page) {
  const open = '<script type="module">';
  if (count(h, open) !== 1) throw new Error(`Expected one Firebase module script in ${page}; the Logbook has changed, update this script.`);
  const i = h.indexOf(open);
  const j = h.indexOf('</script>', i) + '</script>'.length;
  const block = h.slice(i, j);
  if (!block.includes('firebase-auth.js') || !block.includes('window.fbResolve')) {
    throw new Error(`The module script in ${page} isn't the Firebase setup any more; update this script.`);
  }
  return h.slice(0, i) + to + h.slice(j);
}

const ICONS = [
  '<link rel="icon" href="/img/logbook-192.png" type="image/png">',
  '<link rel="apple-touch-icon" href="/img/logbook-192.png">',
  '<link rel="manifest" href="/logbook.webmanifest">',
].join('');

const BACKEND = [
  '<!-- Garage Terminal: sign-in and storage from this site (src/apps/logbook-backend.js), kept offline too -->',
  '<script>window.__gtOfflineCache=true</script>',
  '<script type="module" src="/src/apps/logbook-backend.js"></script>',
].join('\n');

const SW = '<script>if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/apps/sw.js",{scope:"/apps/"}).catch(()=>{}));</script>';

const barStyle = (maxWidth) => `<style>
/* Garage Terminal additions: back link + who's signed in */
.gt-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;font:600 .85rem var(--f-body);color:var(--muted)}
.gt-bar.gt-solo{max-width:${maxWidth};margin:0 auto;padding:8px max(16px,env(safe-area-inset-right,0px)) 0 max(16px,env(safe-area-inset-left,0px))}
.gt-back{display:inline-flex;align-items:center;min-height:44px;color:var(--muted);text-decoration:none;font-family:var(--f-mono);white-space:nowrap;flex:none}
.gt-back:hover{color:var(--ink)}
.gt-back:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.gt-sync{text-align:right;overflow-wrap:anywhere}
.gt-sync[data-state="ok"]{color:var(--ok)}
</style>`;

const bar = (extraClass = '') =>
  `<!-- Garage Terminal: back link + who's signed in (src/apps/logbook-backend.js) -->\n`
  + `<div class="gt-bar${extraClass}"><a class="gt-back" href="/#apps">&lt; garage_terminal</a><span class="gt-sync" id="gtSync" aria-live="polite"></span></div>`;

const note = (what, path) => `<!--
  ${what}, served at ${path}. Built by scripts/import-logbook.mjs from the
  Logbook repo (github.com/RFralic/vehicle_logbook, public/).
  Don't edit by hand: re-run the script with the newer Logbook files instead.
  Sign-in and storage: src/apps/logbook-backend.js.
-->`;

// ---------- the Logbook ---------------------------------------------------------

let lb = readFileSync(join(srcDir, 'index.html'), 'utf8');
// 1. head
lb = swap(lb, '<title>Engine &amp; Vehicle Logbook</title>', '<title>Engine &amp; Vehicle Logbook · Garage Terminal</title>', 'title');
lb = swap(lb, '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/icon-192.png">', ICONS, 'icons + manifest');
lb = swap(lb, '<!doctype html><html lang="en"><head>', `<!doctype html><html lang="en">\n${note('Engine & Vehicle Logbook', '/apps/logbook')}\n<head>`, 'page start');
lb = swap(lb, '</style>\n</head>', `</style>\n${barStyle('980px')}\n</head>`, 'end of styles');
// 2. bar
lb = swap(lb, '<div class="wrap">\n  <header class="top">', `<div class="wrap">\n  ${bar()}\n  <header class="top">`, 'page wrapper + header');
// 3. storage
lb = swapFirebaseModule(lb, BACKEND, 'index.html');
// 4. links
lb = swap(lb, 'href="/tracker"', 'href="/apps/project-tracker"', 'Project Tracker link');
// 5. offline
lb = swap(lb, 'if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));\n</script>', '</script>\n' + SW, 'service worker');

// ---------- the Project Tracker -----------------------------------------------------

let pt = readFileSync(join(srcDir, 'tracker.html'), 'utf8');
// 1. head
pt = swap(pt, /<!--\n  Project Tracker: served at \/tracker[\s\S]*?-->/.exec(pt)?.[0] ?? '(header comment)', note('Project Tracker', '/apps/project-tracker'), 'header comment');
pt = swap(pt, '<title>Project Tracker · Engine &amp; Vehicle Logbook</title>', '<title>Project Tracker · Garage Terminal</title>', 'title');
pt = swap(pt, '<link rel="manifest" href="/manifest.webmanifest">\n<link rel="icon" href="/icon-192.png">\n<link rel="apple-touch-icon" href="/icon-192.png">', ICONS, 'icons + manifest');
pt = swap(pt, '<link rel="preconnect" href="https://fonts.googleapis.com">', `${barStyle('640px')}\n<link rel="preconnect" href="https://fonts.googleapis.com">`, 'fonts link');
// 2. bar (the app redraws its own wrapper, so the bar sits above it)
pt = swap(pt, '<body>\n<div class="wrap" id="app">', `<body>\n${bar(' gt-solo')}\n<div class="wrap" id="app">`, 'page wrapper');
// 3. storage
pt = swapFirebaseModule(pt, BACKEND, 'tracker.html');
// 4. links
pt = swap(pt, 'href="/"', 'href="/apps/logbook"', 'Logbook links', 2);
// 5. offline
pt = swap(pt, '<script>if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));</script>', SW, 'service worker');

for (const [dir, html] of [['apps/logbook', lb], ['apps/project-tracker', pt]]) {
  if (/vehicle-logbook-c7e27|gstatic\.com\/firebasejs/.test(html)) throw new Error(`${dir} still points at the old Firebase project.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/index.html`, html);
  console.log(`Wrote ${dir}/index.html (${html.length.toLocaleString()} characters).`);
}
