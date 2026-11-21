// Fuel Mix page (apps/fuel-mix). No sign-in; choices are remembered on this device.
import {
  RATIOS, CANS_GAL, CANS_L, BOTTLES_OZ, ML_PER_OZ, L_PER_GAL,
  oilFor, gasForOil, fixMix, fmtOz, fmtMl, fmtAmt, kitchen, parseRatio,
} from '../fuelmix/calc.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; };

const S = { unit: 'gal', gas: '5', ratio: 50, tab: 'chart' };
try { Object.assign(S, JSON.parse(localStorage.getItem('gt-fuelmix') || '{}')); } catch { /* fine */ }
const qs = new URLSearchParams(location.search);
if (parseRatio(qs.get('ratio'))) S.ratio = parseRatio(qs.get('ratio'));
if (qs.get('unit') === 'L' || qs.get('unit') === 'gal') S.unit = qs.get('unit');
if (num(qs.get('gas')) > 0) S.gas = String(num(qs.get('gas')));
if (!['gal', 'L'].includes(S.unit)) S.unit = 'gal';
if (!parseRatio(S.ratio)) S.ratio = 50;
if (!['chart', 'bottle', 'fix'].includes(S.tab)) S.tab = 'chart';
const save = () => { try { localStorage.setItem('gt-fuelmix', JSON.stringify(S)); } catch { /* fine */ } };

const gasIn = $('gas'), other = $('ratioOther');
gasIn.value = S.gas;
if (!RATIOS.includes(S.ratio)) other.value = String(S.ratio);

const metric = () => S.unit === 'L';
const uName = (v) => (metric() ? 'L' : v === 1 ? 'gal' : 'gal');
const oilTxt = (oz) => (metric() ? `${fmtMl(oz * ML_PER_OZ)} mL` : `${fmtOz(oz)} fl oz`);
const oilAlt = (oz) => (metric() ? `${fmtOz(oz)} fl oz` : `${fmtMl(oz * ML_PER_OZ)} mL`);

// ---------- mixer ------------------------------------------------------------------

function renderMixer() {
  $('unit').innerHTML = [['gal', 'gal'], ['L', 'liters']].map(([v, l]) => `<button type="button" data-unit="${v}" aria-pressed="${S.unit === v}">${l}</button>`).join('');
  const cans = metric() ? CANS_L : CANS_GAL;
  $('cans').innerHTML = cans.map((c) => `<button type="button" class="chip" data-gas="${c}" aria-pressed="${num(gasIn.value) === c}">${c} ${metric() ? 'L' : 'gal'}</button>`).join('');
  $('ratios').innerHTML = RATIOS.map((r) => `<button type="button" class="chip" data-ratio="${r}" aria-pressed="${S.ratio === r && !other.value}">${r}:1</button>`).join('');
  for (const el of document.querySelectorAll('.ou')) el.textContent = metric() ? 'mL' : 'fl oz';
  for (const el of document.querySelectorAll('.gu')) el.textContent = metric() ? 'liters' : 'gal';

  const gas = num(gasIn.value);
  const r = oilFor(gas, S.unit, S.ratio);
  if (!r) { $('out').innerHTML = '<div class="miss">Enter how much gas you\'re mixing.</div>'; return; }
  const kit = kitchen(r.oz);
  $('out').innerHTML = `<div class="res">
      <span class="lbl">Add 2-stroke oil</span>
      <div class="big">${metric() ? fmtMl(r.ml) : fmtOz(r.oz)} <small>${metric() ? 'mL' : 'fl oz'}</small></div>
      <div class="alt">${esc(oilAlt(r.oz))}${kit ? ' · ' + esc(kit) : ''}</div>
      <p class="say">Mix <b>${esc(oilTxt(r.oz))}</b> of oil into <b>${esc(fmtAmt(gas))} ${metric() ? 'L' : 'gal'}</b> of gas for <b>${esc(fmtAmt(S.ratio))}:1</b>.</p>
    </div>
    <div class="tip">Check the ratio on the engine or in its manual. Too little oil can ruin a 2-stroke.</div>`;
}

// ---------- chart --------------------------------------------------------------------

function renderChart() {
  const cans = metric() ? CANS_L : CANS_GAL;
  const gas = num(gasIn.value);
  const rows = [...new Set([...cans, ...(gas > 0 && !cans.includes(gas) ? [gas] : [])])].sort((a, b) => a - b);
  const cols = [...new Set([...RATIOS, S.ratio])].sort((a, b) => a - b);
  $('p-chart').innerHTML = `<h2>Oil for common cans</h2>
    <p class="note">Oil in ${metric() ? 'milliliters' : 'fluid ounces'}. The highlighted cell is what's picked above.</p>
    <div class="scroll"><table>
      <thead><tr><th>Gas</th>${cols.map((c) => `<th class="${c === S.ratio ? 'cur' : ''}">${esc(fmtAmt(c))}:1</th>`).join('')}</tr></thead>
      <tbody>${rows.map((g) => `<tr class="${g === gas ? 'cur' : ''}"><td>${esc(fmtAmt(g))} ${metric() ? 'L' : 'gal'}</td>${cols.map((c) => {
        const o = oilFor(g, S.unit, c);
        return `<td class="${c === S.ratio ? 'cur' : ''}">${metric() ? fmtMl(o.ml) : fmtOz(o.oz)}</td>`;
      }).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  // phones: keep the picked ratio's column in view
  const th = $('p-chart').querySelector('th.cur'), sc = th && th.closest('.scroll');
  if (sc && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = Math.max(0, th.offsetLeft - sc.clientWidth / 2 + th.offsetWidth / 2);
}

// ---------- I have a bottle ------------------------------------------------------------

function renderBottle() {
  $('bottles').innerHTML = (metric() ? [50, 75, 100, 250] : BOTTLES_OZ).map((b) => `<button type="button" class="chip" data-bottle="${b}" aria-pressed="${num($('bottle').value) === b}">${b} ${metric() ? 'mL' : 'oz'}</button>`).join('');
  const v = num($('bottle').value);
  const oz = metric() ? v / ML_PER_OZ : v;
  const r = gasForOil(oz, S.ratio);
  $('bottleOut').innerHTML = r ? `<div class="answer"><span class="lbl">At ${esc(fmtAmt(S.ratio))}:1 it mixes with</span>
      <div class="big">${esc(fmtAmt(metric() ? r.L : r.gal))} <small>${metric() ? 'L' : 'gal'}</small></div>
      <div class="alt">${esc(metric() ? fmtAmt(r.gal) + ' gal' : fmtAmt(r.L) + ' L')} of gas</div></div>` : '<p class="note">Enter how much oil is in the bottle.</p>';
}

// ---------- Fix a mix ------------------------------------------------------------------

function renderFix() {
  const g = num($('fixGas').value), o = num($('fixOil').value);
  const gal = metric() ? g / L_PER_GAL : g;
  const oz = metric() ? o / ML_PER_OZ : o;
  const r = fixMix(gal, oz, S.ratio);
  const want = `${fmtAmt(S.ratio)}:1`;
  if (!r) { $('fixOut').innerHTML = '<p class="note">Enter the gas in the can and the oil you put in.</p>'; return; }
  const now = isFinite(r.actual) ? `It's about <b>${esc(String(Math.round(r.actual)))}:1</b> now.` : 'There\'s no oil in it yet.';
  if (r.ok) { $('fixOut').innerHTML = `<div class="answer ok"><div class="big">It's already right</div><div class="alt">That's ${esc(want)}. Nothing to add.</div></div>`; return; }
  if (r.addGasGal != null) {
    const add = metric() ? r.addGasGal * L_PER_GAL : r.addGasGal;
    $('fixOut').innerHTML = `<div class="answer warn"><p class="st">Too much oil. ${now}</p><span class="lbl">Add gas</span>
      <div class="big">${esc(fmtAmt(add))} <small>${metric() ? 'L' : 'gal'}</small></div>
      <div class="alt">Then it's ${esc(want)} with ${esc(fmtAmt(g + add))} ${metric() ? 'L' : 'gal'} in all. If that won't fit, pour some off first and use this page again.</div></div>`;
    return;
  }
  const add = r.addOilOz;
  $('fixOut').innerHTML = `<div class="answer warn"><p class="st">Not enough oil. ${now}</p><span class="lbl">Add oil</span>
    <div class="big">${esc(metric() ? fmtMl(add * ML_PER_OZ) : fmtOz(add))} <small>${metric() ? 'mL' : 'fl oz'}</small></div>
    <div class="alt">Then it's ${esc(want)}. ${esc(kitchen(add))}</div></div>`;
}

// ---------- all together ----------------------------------------------------------------

function render() {
  renderMixer();
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.t === S.tab));
  for (const t of ['chart', 'bottle', 'fix']) $('p-' + t).hidden = S.tab !== t;
  if (S.tab === 'chart') renderChart();
  if (S.tab === 'bottle') renderBottle();
  if (S.tab === 'fix') renderFix();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.unit && b.dataset.unit !== S.unit) {
    // keep the same amount of gas (and fix-a-mix amounts) when switching units
    const k = b.dataset.unit === 'L' ? L_PER_GAL : 1 / L_PER_GAL;
    const conv = (el, f) => { const v = num(el.value); if (v > 0) el.value = fmtAmt(v * f); };
    conv(gasIn, k); conv($('fixGas'), k);
    const ok = b.dataset.unit === 'L' ? ML_PER_OZ : 1 / ML_PER_OZ;
    conv($('fixOil'), ok); conv($('bottle'), ok);
    S.unit = b.dataset.unit;
  } else if (b.dataset.gas) gasIn.value = b.dataset.gas;
  else if (b.dataset.ratio) { S.ratio = +b.dataset.ratio; other.value = ''; }
  else if (b.dataset.bottle) $('bottle').value = b.dataset.bottle;
  else if (b.dataset.t) S.tab = b.dataset.t;
  else return;
  S.gas = gasIn.value; save(); render();
});
gasIn.addEventListener('input', () => { S.gas = gasIn.value; save(); render(); });
other.addEventListener('input', () => { const r = parseRatio(other.value); if (r) { S.ratio = r; save(); } render(); });
for (const id of ['bottle', 'fixGas', 'fixOil']) $(id).addEventListener('input', render);
render();
