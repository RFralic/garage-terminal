// Torque Chart page (apps/torque-chart). Works without signing in; only
// "Add to a vehicle or engine" needs an account, and its code loads when used.

import {
  parseBolt, saeRows, metricRows, torqueFor, convert, fmt, UNITS,
  SAE_GRADES, METRIC_CLASSES, MARKINGS, GRADE_INFO,
} from '../torque/calc.js';
import { headSvg } from '../torque/heads.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const SHOW_UNITS = ['ft-lb', 'in-lb', 'N·m']; // the Logbook's units
const QUICK = ['1/4-20', '5/16-18', '3/8-16', '1/2-13', 'M6', 'M8', 'M10', 'M12'];

// Choices, remembered on this device.
const S = { sae: '5', metric: '8.8', cond: 'dry', unit: 'ft-lb', tab: 'sae' };
try { Object.assign(S, JSON.parse(localStorage.getItem('gt-torque') || '{}')); } catch { /* fine */ }
if (!SAE_GRADES.includes(S.sae)) S.sae = '5';
if (!METRIC_CLASSES.includes(S.metric)) S.metric = '8.8';
if (!['dry', 'oiled'].includes(S.cond)) S.cond = 'dry';
if (!SHOW_UNITS.includes(S.unit)) S.unit = 'ft-lb';
const save = () => { try { localStorage.setItem('gt-torque', JSON.stringify(S)); } catch { /* fine */ } };

const inp = $('bolt');
let found = null;

const gradeName = (sys, g) => (sys === 'sae' ? 'Grade ' + g : 'Class ' + g);
const inUnit = (nm, u = S.unit) => fmt(convert(nm, 'N·m', u));
const chip = (l) => `<button class="chip" type="button" data-v="${esc(l)}">${esc(l)}</button>`;
const segBtns = (el, items, cur, attr) => {
  el.innerHTML = items.map(([v, l]) => `<button type="button" data-${attr}="${esc(v)}" aria-pressed="${v === cur}">${esc(l)}</button>`).join('');
};

// ---------- finder ----------------------------------------------------------------

function renderFinder() {
  const p = parseBolt(inp.value);
  found = p.row ? p : null;
  const sys = found ? found.kind : S.tab === 'metric' ? 'metric' : 'sae';
  segBtns($('grade'), (sys === 'sae' ? SAE_GRADES : METRIC_CLASSES).map((g) => [g, sys === 'sae' ? g : g]), S[sys], 'g');
  segBtns($('cond'), [['dry', 'Dry'], ['oiled', 'Oiled']], S.cond, 'c');
  segBtns($('unit'), SHOW_UNITS.map((u) => [u, u]), S.unit, 'u');
  $('gl').textContent = sys === 'sae' ? 'Grade' : 'Property class';
  for (const c of document.querySelectorAll('#quick .chip')) c.setAttribute('aria-pressed', String(c.dataset.v.toLowerCase() === inp.value.trim().toLowerCase()));

  const out = $('out');
  if (p.kind === 'empty') { out.innerHTML = '<div class="miss">Enter a bolt size, or pick a common one.</div>'; return; }
  if (p.kind === 'miss') {
    out.innerHTML = `<div class="miss"><span><b>No match for “${esc(inp.value)}”.</b> ${p.near ? 'That size comes in:' : 'Try a format like:'}</span><div class="chips">${(p.near || ['3/8-16', '#10-32', 'M10', 'M8x1']).map(chip).join('')}</div></div>`;
    return;
  }
  const r = p.row, g = S[sys];
  const t = torqueFor(r, g, S.cond);
  const other = S.cond === 'dry' ? 'oiled' : 'dry';
  const t2 = torqueFor(r, g, other);
  const others = SHOW_UNITS.filter((u) => u !== S.unit).map((u) => `${inUnit(t.nm, u)} ${u}`).join(' · ');
  const clamp = sys === 'sae' ? `${Math.round(t.clampLb).toLocaleString()} lb` : `${(t.clampN / 1000).toFixed(1)} kN`;
  const wrench = r.wrench ? (r.din ? `${r.wrench} <span class="dim">(${r.din} on older DIN bolts)</span>` : r.wrench) : '';
  const pitches = p.rows.filter((x) => x !== r).map((x) => chip(x.id)).join('');
  out.innerHTML = `<div class="res-head"><h2>${esc(r.label)}</h2><span class="tag">${esc(r.series)}</span><span class="tag">${esc(gradeName(sys, g))}</span></div>
    <div class="figs">
      <div class="fig"><span class="lbl">${S.cond === 'dry' ? 'Dry' : 'Oiled'}</span><div class="big">${inUnit(t.nm)} <small>${S.unit}</small></div><div class="alt">${others}</div></div>
      <div class="fig"><span class="lbl">${other === 'dry' ? 'Dry' : 'Oiled'}</span><div class="big two">${inUnit(t2.nm)} <small>${S.unit}</small></div><div class="alt">${SHOW_UNITS.filter((u) => u !== S.unit).map((u) => `${inUnit(t2.nm, u)} ${u}`).join(' · ')}</div></div>
    </div>
    <div class="extra">
      <span class="hm">${headSvg(g, 34, gradeName(sys, g) + ' head')}<span>Head marks: <b>${esc(MARKINGS[g])}</b> <button type="button" class="lnk" data-t="grades">See all grades</button></span></span>
      ${wrench ? `<span>Wrench: <b>${wrench}</b></span>` : ''}
      <span>Clamp load: <b>${clamp}</b></span>
      ${pitches ? `<span>Other pitch <span class="chips" style="display:inline-flex">${pitches}</span></span>` : ''}
    </div>
    <div class="acts"><button type="button" class="btn" id="addBtn">+ Add to a vehicle or engine</button></div>
    <div class="tip">A typical value for this size and grade, not a spec for any particular machine.${sys === 'sae' && g === '2' ? ' Grade 2 values are for bolts up to 6" long.' : ''}</div>`;
  $('addBtn').onclick = openAdd;
}

// ---------- converter ------------------------------------------------------------

const cvIn = $('cv-in'), cvUnit = $('cv-unit');
cvUnit.innerHTML = UNITS.map((u) => `<option>${u}</option>`).join('');
function renderConverter() {
  const v = parseFloat(cvIn.value.replace(',', '.'));
  if (!isFinite(v)) { $('cv-out').innerHTML = '<div><span>Type a number to convert.</span></div>'; return; }
  const NAMES = { 'ft-lb': 'foot-pounds', 'in-lb': 'inch-pounds', 'N·m': 'newton-meters', 'kgf·m': 'kilogram-meters', 'kgf·cm': 'kilogram-centimeters' };
  $('cv-out').innerHTML = UNITS.map((u) => {
    const x = convert(v, cvUnit.value, u);
    const shown = u === cvUnit.value ? String(v) : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);
    return `<div class="${u === cvUnit.value ? 'from' : ''}"><b>${esc(shown)} ${esc(u)}</b><span>${NAMES[u]}</span></div>`;
  }).join('');
}
cvIn.addEventListener('input', renderConverter);
cvUnit.addEventListener('change', renderConverter);

// ---------- chart ----------------------------------------------------------------

const tbl = $('tbl'), q = $('q');
function renderGrades() {
  const cur = found ? S[found.kind] : null;
  $('grades').innerHTML = `<p class="note">How to tell a bolt's grade from the marks on its head. "ABC" stands in for the maker's mark; every brand has its own. No marks at all usually means Grade 2 or unknown, so treat it as Grade 2.</p>
    <div class="gcards">${GRADE_INFO.map((x) => `<article class="gcard${x.g === cur ? ' cur' : ''}">
      <div class="gtop">${headSvg(x.g, 88, x.name + ' head')}<div><h3>${esc(x.name)}</h3><p class="gm">${esc(x.marks)}</p><p class="glike">${esc(x.like)}</p></div></div>
      <dl><div><dt>Steel</dt><dd>${esc(x.steel)}</dd></div><div><dt>Tensile strength</dt><dd>${esc(x.tensile)}</dd></div><div><dt>Proof load</dt><dd>${esc(x.proof)}</dd></div><div><dt>Used for</dt><dd>${esc(x.uses)}</dd></div></dl>
      <button type="button" class="btn ghost" data-use="${esc(x.sys)}:${esc(x.g)}">Use ${esc(x.sys === 'sae' ? 'Grade ' + x.g : 'class ' + x.g)} in the finder</button>
    </article>`).join('')}</div>
    <p class="note">Nuts have grades too: use a nut at least as strong as the bolt (Grade 5 or 8 nuts, or metric class 8 / 10 nuts). Stainless bolts are usually marked 18-8, 304 or 316 (A2 / A4 on metric) and are about as strong as Grade 2, so this chart doesn't cover them.</p>`;
}
function renderChart() {
  const grades0 = S.tab === 'grades';
  for (const id of ['note', 'q']) $(id).hidden = grades0;
  tbl.parentElement.hidden = grades0;
  $('grades').hidden = !grades0;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.t === S.tab));
  if (grades0) { renderGrades(); return; }
  const sae = S.tab === 'sae';
  const grades = sae ? SAE_GRADES : METRIC_CLASSES;
  const rows = sae ? saeRows() : metricRows();
  const term = q.value.trim().toLowerCase();
  const mid = found && found.kind === S.tab ? found.row.id : null;
  $('note').textContent = sae
    ? `Torque in ${S.unit}. Coarse (UNC) and fine (UNF) threads, #8 to 1". Wrench sizes are for standard hex head bolts. Grade 2 is weaker above 3/4", so its numbers drop there.`
    : `Torque in ${S.unit}. Coarse and fine pitches, M4 to M24. Wrench sizes are ISO; older DIN bolts can be one size bigger.`;
  const shown = rows.filter((r) => !term || `${r.label} ${r.id} ${r.size} ${r.series}`.toLowerCase().includes(term));
  tbl.innerHTML = `<thead>
    <tr class="group"><th colspan="3"></th>${grades.map((g) => `<th class="g" colspan="2">${esc(sae ? 'Grade ' + g : 'Class ' + g)}</th>`).join('')}</tr>
    <tr><th>Size</th><th>Series</th><th>Wrench</th>${grades.map(() => '<th class="g">Dry</th><th>Oiled</th>').join('')}</tr></thead>
    <tbody>${shown.length ? shown.map((r, i) => {
      const first = !term && i > 0 && shown[i - 1].size !== r.size;
      const match = r.id === mid;
      const cells = grades.map((g) => ['dry', 'oiled'].map((c, j) => {
        const pick = match && g === S[S.tab] && c === S.cond;
        return `<td class="${j ? '' : 'g '}${c === 'dry' ? 'v' : 'dim'}${pick ? ' pick' : ''}">${inUnit(torqueFor(r, g, c).nm)}</td>`;
      }).join('')).join('');
      return `<tr class="${[first ? 'first' : '', match ? 'match' : ''].filter(Boolean).join(' ')}"><td class="size"><button type="button" data-v="${esc(r.id)}" title="Look up ${esc(r.label)}">${esc(r.label)}</button></td><td><span class="pill">${esc(r.series)}</span></td><td class="dim">${esc(r.wrench || '—')}</td>${cells}</tr>`;
    }).join('') : `<tr><td class="empty" colspan="9">No sizes match “${esc(q.value)}”.</td></tr>`}</tbody>`;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.t === S.tab));
}

function lookup(scroll) {
  renderFinder();
  if (found && S.tab !== 'grades') S.tab = found.kind;
  renderChart();
  if (scroll) { const m = tbl.querySelector('tr.match'); if (m) m.scrollIntoView({ block: 'nearest' }); }
}

// ---------- events -----------------------------------------------------------------

$('quick').innerHTML = QUICK.map(chip).join('');
document.addEventListener('click', (e) => {
  const b = e.target.closest('.chip, td.size button');
  if (b && b.dataset.v) {
    inp.value = b.dataset.v; lookup(false);
    if (b.matches('td.size button')) window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return;
  }
  const g = e.target.closest('[data-g]');
  if (g) { S[found ? found.kind : S.tab] = g.dataset.g; save(); lookup(false); return; }
  const c = e.target.closest('[data-c]');
  if (c) { S.cond = c.dataset.c; save(); lookup(false); return; }
  const u = e.target.closest('[data-u]');
  if (u) { S.unit = u.dataset.u; save(); lookup(false); return; }
  const t = e.target.closest('.tabs button, button.lnk[data-t]');
  if (t) {
    S.tab = t.dataset.t; save(); renderChart();
    if (t.matches('.lnk')) document.querySelector('.bar').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    return;
  }
  const use = e.target.closest('[data-use]');
  if (use) {
    const [sys, g] = use.dataset.use.split(':');
    S[sys] = g;
    if (!found || found.kind !== sys) inp.value = sys === 'sae' ? '3/8-16' : 'M10';
    save(); lookup(false); window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
});
inp.addEventListener('input', () => lookup(false));
q.addEventListener('input', renderChart);
const startAt = new URLSearchParams(location.search).get('bolt');
if (startAt) inp.value = startAt.slice(0, 20);
lookup(false);
renderConverter();

// ---------- add to a vehicle or engine -----------------------------------------------

async function openAdd() {
  if (!found) return;
  const r = found.row, sys = found.kind, g = S[sys];
  const nm = torqueFor(r, g, S.cond).nm;
  const spec = {
    label: `${r.label} ${gradeName(sys, g)}, ${S.cond}`,
    value: inUnit(nm),
    unit: S.unit,
    wrench: r.wrench || '',
  };
  const btn = $('addBtn');
  if (btn) btn.disabled = true;
  try {
    const m = await import('../torque/machines.js');
    m.openAdd(spec, $('add'));
  } catch {
    alertBox('Couldn\'t load that just now. Check your connection and try again.');
  } finally {
    if (btn) btn.disabled = false;
  }
}
// Back from a phone sign-in for "Add to a vehicle or engine": pick up where they left off.
try {
  if (sessionStorage.getItem('gt-torque-add')) import('../torque/machines.js').then((m) => m.resume($('add'))).catch(() => {});
} catch { /* fine */ }

function alertBox(text) {
  const d = $('add');
  d.innerHTML = `<div class="dlg"><h2>Add to a vehicle or engine</h2><p class="msg err">${esc(text)}</p><div class="btns"><button type="button" class="btn" data-close>OK</button></div></div>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  if (!d.open) d.showModal();
}
