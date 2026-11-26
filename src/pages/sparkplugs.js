// Spark Plug Finder page (apps/spark-plugs). No sign-in. The last search is remembered on this device.
import data from '../sparkplug/plugs.json';
import { makeIndex, findPlugs, findMachines, gapIn, key } from '../sparkplug/search.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ix = makeIndex(data);
const EXAMPLES = ['RJ19LM', 'BPMR7A', 'F7RTC', 'Honda GX160', 'Stihl MS 290', 'Kohler CV'];
let showAllMachines = false;
let openPlug = ''; // NGK key whose machine list is open

const q = $('q');
const qs = new URLSearchParams(location.search);
try { q.value = qs.get('q') || localStorage.getItem('gt-sparkplug-q') || ''; } catch { q.value = qs.get('q') || ''; }

$('eg').innerHTML = EXAMPLES.map((e) => `<button type="button" class="chip" data-eg="${esc(e)}">${esc(e)}</button>`).join('');
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
      ${via.length ? `<span class="matched">${via.slice(0, 3).map((h) => `${esc(h.brand)} <b>${esc(h.num)}</b>`).join(', ')}${via.length > 3 ? ' …' : ''}</span>` : ''}</div>
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
    $('out').innerHTML = `<p class="empty">Start typing: a plug number like <b>RJ19LM</b> or <b>BPR6ES</b>, or a machine like <b>Honda GX160</b>. ${ix.byPlug.size.toLocaleString()} NGK plugs, ${data.cross.length.toLocaleString()} other-brand numbers and ${data.fit.length.toLocaleString()} machine listings.</p>`;
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

let t = 0;
q.addEventListener('input', () => { showAllMachines = false; openPlug = ''; clearTimeout(t); t = setTimeout(render, 120); });
document.addEventListener('click', (e) => {
  const eg = e.target.closest('[data-eg]');
  if (eg) { q.value = eg.dataset.eg; showAllMachines = false; openPlug = ''; render(); return; }
  const pl = e.target.closest('[data-plug]');
  if (pl) { q.value = pl.dataset.plug; showAllMachines = false; openPlug = ''; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const ms = e.target.closest('[data-machines]');
  if (ms) { openPlug = openPlug === ms.dataset.machines ? '' : ms.dataset.machines; render(); return; }
  if (e.target.closest('[data-more]')) { showAllMachines = true; render(); }
});
render();
