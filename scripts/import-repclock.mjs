// import-repclock.mjs: builds apps/repclock/index.html from the RepClock
// Claude artifact's HTML file (https://claude.ai/artifact/JKeLMiprJDSDuf9GudpJpF).
//
//   node scripts/import-repclock.mjs path/to/repclock-artifact.html
//
// RepClock's own styles, markup and code are copied unchanged, except for
// these marked Garage Terminal changes:
//   1. page head: title, site icons, web manifest
//   2. a thin bar at the top: "< garage_terminal" link + account sync status
//   3. the app starts when the sync module says so (src/apps/repclock-sync.js),
//      so a signed-in member's saved workouts are loaded first
//      (fallback: starts after 4 seconds no matter what)
//   4. the History status line says where workouts are saved on this site
//      ("on this device" or "in your account"), instead of RepClock's own
//      note about the Claude account
// The script stops with an error if the artifact's code has changed in a way
// these edits no longer fit, rather than producing a broken page.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = readFileSync(process.argv[2] || '', 'utf8');
const OUT = 'apps/repclock/index.html';

/** Find text that must appear exactly once. */
function once(haystack, needle, what) {
  const n = haystack.split(needle).length - 1;
  if (n !== 1) throw new Error(`Expected "${what}" once in the artifact, found ${n} times. RepClock has changed; update this script.`);
  return needle;
}
function between(s, start, end) {
  const i = s.indexOf(start);
  const j = s.indexOf(end, i);
  if (i < 0 || j < 0) throw new Error(`Couldn't find ${start} … ${end} in the artifact.`);
  return s.slice(i, j + end.length);
}

const wrapperStyle = between(src, '<style>:root{color-scheme:light', '</style>');
const appStyle = between(src, '<style>\n/* Layout: one-screen phone app', '</style>');
const fontsLink = between(src, '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders', '>');
let markup = src.slice(src.indexOf('</style>', src.indexOf(appStyle)) + '</style>'.length, src.indexOf('<script>\n(()=>{'));
let script = between(src, '<script>\n(()=>{', '</script>');

// 2. sync bar at the top of the home screen
markup = markup.replace(once(markup, '<div class="wrap" id="home">\n', 'home wrapper'),
  '<div class="wrap" id="home">\n  <!-- Garage Terminal: back link + account sync status (src/apps/repclock-sync.js) -->\n'
  + '  <div class="gt-bar"><a class="gt-back" href="/#apps">&lt; garage_terminal</a><span class="gt-sync" id="gtSync" aria-live="polite"></span></div>\n');

// 3. start when told to (instead of immediately)
script = script.replace(once(script, '<script>\n(()=>{', 'app start'),
  '<script>\n// Garage Terminal: started by src/apps/repclock-sync.js once saved workouts are loaded.\n'
  + 'window.__startRepClock=()=>{if(window.__rcStarted)return;window.__rcStarted=true;');
if (!script.endsWith('})();\n</script>')) throw new Error('RepClock no longer ends with })(); update this script.');
script = script.slice(0, -'})();\n</script>'.length) + '};\n</script>';

// 4. History status line: RepClock's own note talks about the Claude account
//    (its claude.ai storage isn't available here); say where workouts are saved
//    on this site instead.
script = script.replace(once(script, 'function acctNote(){\n', 'History status line (acctNote)'),
  'function acctNote(){\n'
  + "  // Garage Terminal: where workouts are saved on this site (src/apps/repclock-sync.js)\n"
  + "  if(window.__rcNote)return '<div class=\"acct'+(window.__rcSynced?' on':'')+'\">'+esc(window.__rcNote)+'</div>';\n");

const extraStyle = `<style>
/* Garage Terminal additions: back link + sync status bar */
.gt-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:-6px;font:600 .85rem var(--body)}
.gt-back{display:inline-flex;align-items:center;min-height:44px;color:var(--muted);text-decoration:none;font-family:ui-monospace,Menlo,Consolas,monospace}
.gt-back:hover{color:var(--fg)}
.gt-back:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
.gt-sync{color:var(--muted);text-align:right;overflow-wrap:anywhere}
.gt-sync a{color:var(--accent);display:inline-flex;align-items:center;min-height:44px}
.gt-sync[data-state="ok"]{color:var(--good)}
.gt-sync[data-state="error"]{color:var(--danger)}
</style>`;

const page = `<!doctype html>
<html lang="en">
<!--
  RepClock, served at /apps/repclock. Built by scripts/import-repclock.mjs from
  the Claude artifact https://claude.ai/artifact/JKeLMiprJDSDuf9GudpJpF.
  Don't edit by hand: re-run the script with a newer artifact file instead.
  Signed-in members' workouts sync to their account: src/apps/repclock-sync.js.
-->
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>RepClock · Garage Terminal</title>
<meta name="description" content="Rep counter, stopwatch and circuit interval timer with workout history.">
<meta name="theme-color" content="#12161f">
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
<script type="module" src="/src/apps/repclock-sync.js"></script>
</head>
<body>
${markup.trim()}

${script}
<script>
// Garage Terminal: on a device no one has signed in on, there's nothing to load
// first, so start right away. Otherwise wait for the sync module (it starts the
// app as soon as saved workouts are in), but never longer than 4 seconds.
(function(){var linked=null;try{linked=localStorage.getItem('gt.repclock.owner')}catch(e){}
if(!linked)window.__startRepClock();else setTimeout(function(){window.__startRepClock()},4000)})();
</script>
</body>
</html>
`;

mkdirSync('apps/repclock', { recursive: true });
writeFileSync(OUT, page);
console.log(`Wrote ${OUT} (${page.length.toLocaleString()} characters).`);
