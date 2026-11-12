// import-home-projects.mjs: builds apps/home-projects/index.html from the
// Home Projects Claude artifact's HTML file
// (https://claude.ai/artifact/P6rzcGnqwQksfxxWn3uKiG).
//
//   node scripts/import-home-projects.mjs path/to/home-projects-artifact.html
//
// The app's styles, markup and code are copied unchanged, except for these
// marked Garage Terminal changes:
//   1. page head: title, site icons, web manifest
//   2. a thin bar at the top: "< garage_terminal" link + account sync status
//   3. storage: a small window.claude stand-in (before the app's script) that
//      hands the app the site's sign-in, Firestore and Storage, from
//      src/apps/homeprojects-backend.js
//   4. photos: shown from this site's Storage instead of claude.ai's /_blob/ addresses
//   5. wording: messages that say "sign in to claude.ai" talk about this site's sign-in
// The script stops with an error if the artifact changed in a way these edits
// no longer fit, rather than producing a broken page.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = readFileSync(process.argv[2] || '', 'utf8');
const OUT = 'apps/home-projects/index.html';

function count(h, n) { return h.split(n).length - 1; }
function swap(h, from, to, what, times = 1) {
  const n = count(h, from);
  if (n !== times) throw new Error(`Expected "${what}" ${times}× in the artifact, found ${n}. Home Projects has changed; update this script.`);
  return h.split(from).join(to);
}
function between(s, start, end) {
  const i = s.indexOf(start);
  const j = s.indexOf(end, i);
  if (i < 0 || j < 0) throw new Error(`Couldn't find ${start} … ${end} in the artifact.`);
  return s.slice(i, j + end.length);
}

const wrapperStyle = between(src, '<style>:root{color-scheme:light', '</style>');
const appStyle = between(src, '<style>\n/* Layout: shop-manual logbook', '</style>');
const fontsLink = between(src, '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?', '>');
let markup = src.slice(src.indexOf('</style>', src.indexOf(appStyle)) + '</style>'.length, src.indexOf('<script>\n(function(){'));
let script = between(src, '<script>\n(function(){', '</script>');

// 2. sync bar at the top
markup = swap(markup, '<div class="wrap">\n  <header class="top">',
  '<div class="wrap">\n  <!-- Garage Terminal: back link + account sync status (src/apps/homeprojects-backend.js) -->\n'
  + '  <div class="gt-bar"><a class="gt-back" href="/#apps">&lt; garage_terminal</a><span class="gt-sync" id="gtSync" aria-live="polite"></span></div>\n'
  + '  <header class="top">', 'page wrapper + header');

// 4. photos from this site's Storage
script = swap(script, '<img src="/_blob/${esc(x.id)}"', '<img src="${esc(window.__gtPhoto(x.id))}" data-gtphoto="${esc(x.id)}"', 'photo images', 2);

// 5. wording
script = swap(script, 'Sign in to claude.ai to save projects to your account.', 'Sign in to save projects to your account.', 'sign-in message');
script = swap(script, 'Sign in to claude.ai to keep your own project list.', 'Sign in to keep your own project list.', 'sign-in message 2');
script = swap(script, 'Photos need your claude.ai sign-in. Links still work here.', 'Sign in to add photos. Links still work here.', 'photos message');
script = swap(script, 'Photo uploads are available to you as the owner of this page.', 'Photo uploads aren’t available right now.', 'photo uploads message');

const extraStyle = `<style>
/* Garage Terminal additions: back link + sync status bar */
.gt-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;font:600 .85rem var(--f-body)}
.gt-back{display:inline-flex;align-items:center;min-height:44px;color:var(--muted);text-decoration:none;font-family:var(--f-mono);white-space:nowrap;flex:none}
.gt-back:hover{color:var(--ink)}
.gt-back:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.gt-sync{color:var(--muted);text-align:right;overflow-wrap:anywhere}
.gt-sync a{color:var(--accent);display:inline-flex;align-items:center;min-height:44px}
.gt-sync[data-state="ok"]{color:var(--ok)}
</style>`;

const page = `<!doctype html>
<html lang="en">
<!--
  Home Projects, served at /apps/home-projects. Built by scripts/import-home-projects.mjs
  from the Claude artifact https://claude.ai/artifact/P6rzcGnqwQksfxxWn3uKiG.
  Don't edit by hand: re-run the script with a newer artifact file instead.
  Storage (sign-in, projects, photos): src/apps/homeprojects-backend.js.
-->
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Home Projects · Garage Terminal</title>
<meta name="description" content="Home projects by room: tasks, shopping lists, notes, links and photos.">
<meta name="theme-color" content="#2f4a43">
<!-- Site icons: SVG for modern browsers, .ico/.png fallbacks, home-screen icon, web manifest -->
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
${fontsLink}
<!-- Base styles from the artifact's page wrapper -->
${wrapperStyle}
${appStyle}
${extraStyle}
<script type="module" src="/src/apps/homeprojects-backend.js"></script>
</head>
<body>
${markup.trim()}

<script>
// Garage Terminal: the app asks for window.claude.use("db" | "user" | "assets").
// Here those come from src/apps/homeprojects-backend.js once it knows who's
// signed in; until then the app's own "Loading your projects…" shows.
(function(){
  var ready=new Promise(function(r){window.__gtReady=r});
  window.claude={use:function(name){return ready.then(function(b){return b.use(name)})}};
  window.__gtPhoto=window.__gtPhoto||function(){return 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='};
})();
</script>
${script}
</body>
</html>
`;

mkdirSync('apps/home-projects', { recursive: true });
writeFileSync(OUT, page);
console.log(`Wrote ${OUT} (${page.length.toLocaleString()} characters).`);
