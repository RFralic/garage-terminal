// Spark Plug Finder page (apps/spark-plugs). No sign-in. The last search is remembered on this device.
import data from '../sparkplug/plugs.json';
import { makeIndex, findPlugs, findMachines, gapIn, key } from '../sparkplug/search.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ix = makeIndex(data);
const EXAMPLES = ['RJ19LM', 'BPMR7A', 'F7RTC', 'Honda GX160', 'Stihl MS 290', 'Kohler CV'];
let showAllMachines = false;
let openPlug = ''; // NGK key whose machine list is open

// ---------- My plugs: a short list of the plugs you use most ----------
// Kept on this device (localStorage gt-sparkplug-mine) and, when signed in, in your account
// (src/sparkplug/sync.js) so every device shows the same list. Items: {p: NGK plug, note, at}.
// Starred while signed out = {local: true} until they reach the account.
let mine = [];
try { mine = JSON.parse(localStorage.getItem('gt-sparkplug-mine') || '[]').filter((x) => x && x.p); } catch { mine = []; }
let sync = null; let signedIn = false; let noteFor = ''; // NGK key whose note is being edited
const keepLocal = () => { try { localStorage.setItem('gt-sparkplug-mine', JSON.stringify(mine)); } catch { /* fine */ } };
const isMine = (pk) => mine.some((x) => key(x.p) === pk);
function saveMine() {
  keepLocal();
  if (sync && signedIn) sync.save(mine).then(() => { mine = mine.map(({ local, ...x }) => x); keepLocal(); }).catch(() => { /* kept on this device; tries again next change */ });
}

const q = $('q');
const qs = new URLSearchParams(location.search);
try { q.value = qs.get('q') || localStorage.getItem('gt-sparkplug-q') || ''; } catch { q.value = qs.get('q') || ''; }

function renderChips() {
  $('eg').innerHTML = mine.length
    ? `<span class="lbl" style="flex-basis:100%">My plugs</span>` + mine.map((x) => `<button type="button" class="chip mine" data-eg="${esc(x.p)}" title="${esc(x.note || '')}">★ ${esc(x.p)}${x.note ? ` <span>${esc(x.note)}</span>` : ''}</button>`).join('')
    : EXAMPLES.map((e) => `<button type="button" class="chip" data-eg="${esc(e)}">${esc(e)}</button>`).join('');
}
renderChips();
$('src').textContent = `From ${data.src}. Equivalents are a guide: heat range and reach can differ a little between brands, so check the engine's manual when in doubt. Gaps are NGK's; inches are converted from millimeters.`;

const gapTxt = (mm) => `${mm.toFixed(1)} mm · ${gapIn(mm)}`;

function plugCard({ plug, hits, exact }, typed) {
  const tk = key(typed);
  const brands = new Map();
  for (const e of plug.equiv) { if (!brands.has(e.brand)) brands.set(e.brand, []); brands.get(e.brand).push(e.num); }
  const mark = (n) => (key(n) === tk ? `<mark>${esc(n)}</mark>` : esc(n));
  const via = hits.filter((h) => h.brand !== 'NGK');
  const machines = plug.fit;
  const open = openPlug === plug.pk;
  return `<article class="plug${exact ? ' exact' : ''}">
    <div class="ptop"><span class="ngk"><small>NGK</small>${esc(plug.name)}</span>
      <button type="button" class="star${isMine(plug.pk) ? ' on' : ''}" data-star="${esc(plug.name)}" aria-pressed="${isMine(plug.pk)}">${isMine(plug.pk) ? '★ In my plugs' : '☆ Add to my plugs'}</button></div>
    ${via.length ? `<span class="matched">Matched ${via.slice(0, 3).map((h) => `${esc(h.brand)} <b>${esc(h.num)}</b>`).join(', ')}${via.length > 3 ? ' …' : ''}</span>` : ''}
    ${noteFor === plug.pk ? `<form class="noteform" data-note="${esc(plug.pk)}"><label class="lbl" for="pn-${esc(plug.pk)}">Note (optional)</label><div class="inrow2"><input id="pn-${esc(plug.pk)}" maxlength="40" placeholder="e.g. Shop mowers, Stihl saws" value="${esc((mine.find((x) => key(x.p) === plug.pk) || {}).note || '')}"><button type="submit" class="more">Save</button></div></form>`
      : isMine(plug.pk) ? `<span class="mynote">${esc((mine.find((x) => key(x.p) === plug.pk) || {}).note || '')}<button type="button" class="plink" style="font-size:.85rem" data-editnote="${esc(plug.pk)}">${(mine.find((x) => key(x.p) === plug.pk) || {}).note ? 'Edit note' : 'Add a note'}</button></span>` : ''}
    ${brands.size ? `<dl class="eq">${[...brands].map(([b, nums]) => `<dt>${esc(b)}</dt><dd>${nums.map(mark).join(', ')}</dd>`).join('')}</dl>` : '<p class="hint">No other brands listed for this plug.</p>'}
    ${machines.length ? `<div class="uses">Fits <b>${machines.length}</b> machine${machines.length === 1 ? '' : ' listings'} in the catalogue. <button type="button" class="plink" style="font-size:.9rem" data-machines="${esc(plug.pk)}" aria-expanded="${open}">${open ? 'Hide them' : 'Show them'}</button></div>
      ${open ? `<div class="mlist">${machines.map(machineRow).join('')}</div>` : ''}` : ''}
  </article>`;
}

function machineRow(f) {
  return `<div class="mrow"><span class="who"><b>${esc(f.maker)} · ${esc(f.models)}</b><span>${esc(f.cat || '')}</span></span>
    <span class="what"><button type="button" class="plink" data-plug="${esc(f.plug)}" aria-label="NGK ${esc(f.plug)}: show other brands">${esc(f.plug)}</button><span class="gap">${gapTxt(f.gap)}</span></span></div>`;
}

function render() {
  const typed = q.value.trim();
  try { localStorage.setItem('gt-sparkplug-q', typed); } catch { /* fine */ }
  if (key(typed).length < 2) {
    const list = mine.map((x) => ix.byPlug.get(key(x.p))).filter(Boolean);
    if (list.length) { $('out').innerHTML = `<h2 class="sec">My plugs <span>${list.length}</span></h2>` + list.map((p) => plugCard({ plug: p, hits: [], exact: false }, '')).join('') + syncNote(); return; }
    $('out').innerHTML = `<p class="empty">Tap ☆ on any plug to keep it in <b>My plugs</b> for next time. Start typing: a plug number like <b>RJ19LM</b> or <b>BPR6ES</b>, or a machine like <b>Honda GX160</b>. ${ix.byPlug.size.toLocaleString()} NGK plugs, ${data.cross.length.toLocaleString()} other-brand numbers and ${data.fit.length.toLocaleString()} machine listings.</p>`;
    return;
  }
  const plugs = findPlugs(ix, typed, 12);
  const m = findMachines(ix, typed, showAllMachines ? 400 : 40);
  let h = '';
  if (plugs.length) h += `<h2 class="sec">Plug numbers <span>${plugs.length}${plugs.length === 12 ? '+' : ''}</span></h2>` + plugs.map((p) => plugCard(p, typed)).join('');
  if (m.rows.length) h += `<h2 class="sec">Machines <span>${m.rows.length + m.more}</span></h2><div class="mlist">${m.rows.map(machineRow).join('')}</div>`
    + (m.more ? `<button type="button" class="more" data-more>Show ${m.more} more</button>` : '');
  if (!h) h = `<p class="empty">Nothing found for “${esc(typed)}”. Try just the model number (GX160), or part of the plug number (RJ19). The catalogue is from 2009, so newer machines may not be in it.</p>`;
  $('out').innerHTML = h;
}

function syncNote() {
  return `<p class="caveat">${signedIn ? 'My plugs is saved to your account, so it shows on all your devices.' : `My plugs is saved on this device.${sync ? ' <button type="button" class="plink" style="font-size:.85rem" data-signin>Sign in</button> to have it on all your devices.' : ''}`}</p>`;
}

let t = 0;
q.addEventListener('input', () => { showAllMachines = false; openPlug = ''; clearTimeout(t); t = setTimeout(render, 120); });
document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-note]'); if (!f) return; e.preventDefault();
  const it = mine.find((x) => key(x.p) === f.dataset.note); if (it) it.note = f.querySelector('input').value.trim().slice(0, 40);
  noteFor = ''; saveMine(); renderChips(); render();
});
document.addEventListener('click', (e) => {
  const st = e.target.closest('[data-star]');
  if (st) {
    const p = st.dataset.star, pk = key(p);
    if (isMine(pk)) { mine = mine.filter((x) => key(x.p) !== pk); noteFor = ''; }
    else { mine.push({ p, note: '', at: new Date().toISOString(), ...(signedIn ? {} : { local: true }) }); noteFor = pk; }
    saveMine(); renderChips(); render();
    if (noteFor) setTimeout(() => { const i = document.getElementById('pn-' + pk); if (i) i.focus(); }, 0);
    return;
  }
  if (e.target.closest('[data-signin]')) { if (sync) sync.signIn().catch(() => {}); return; }
  const en = e.target.closest('[data-editnote]');
  if (en) { noteFor = en.dataset.editnote; render(); setTimeout(() => { const i = document.getElementById('pn-' + noteFor); if (i) i.focus(); }, 0); return; }
  const eg = e.target.closest('[data-eg]');
  if (eg) { q.value = eg.dataset.eg; showAllMachines = false; openPlug = ''; render(); return; }
  const pl = e.target.closest('[data-plug]');
  if (pl) { q.value = pl.dataset.plug; showAllMachines = false; openPlug = ''; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const ms = e.target.closest('[data-machines]');
  if (ms) { openPlug = openPlug === ms.dataset.machines ? '' : ms.dataset.machines; render(); return; }
  if (e.target.closest('[data-more]')) { showAllMachines = true; render(); }
});
render();

// Sign-in loads after the page is up, so the finder works offline and without an account.
import('../sparkplug/sync.js').then((m) => {
  sync = m;
  m.start((list) => {
    // the account's list wins; plugs starred on this device while signed out are added to it
    const extra = mine.filter((x) => x.local && !(list || []).some((y) => key(y.p) === key(x.p)));
    mine = [...(list || []).filter((x) => x && x.p), ...extra.map(({ local, ...x }) => x)];
    keepLocal(); if (extra.length || list === null) m.save(mine).catch(() => {});
    renderChips(); render();
  }, (u) => { signedIn = u; if (!q.value.trim()) render(); });
}).catch(() => { /* offline or blocked: My plugs stays on this device */ });
