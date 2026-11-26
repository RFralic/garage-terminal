// Spark Plug Finder: search. Pure logic over the data in plugs.json (no DOM), so it can be tested.
//
// plugs.json, pulled from NGK's 2009 catalogue for horticultural, agricultural and industrial
// engines (glow plugs and UK-only brands left out):
//   makers: ['Acme', ...]
//   fit:    [[makerIndex, category, models, ngkPlug, gapMm], ...]   which plug a machine takes
//   cross:  [[brand, theirNumber, ngkPlug], ...]                     other brands' numbers -> NGK
// Other brands' tables write some NGK numbers without the dash (BR2LM vs BR2-LM), so plug numbers
// are compared by key(): capitals and digits only.

export const key = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const MM_PER_IN = 25.4;
/** 0.6 -> '.024"' */
export const gapIn = (mm) => '.' + String(Math.round((mm / MM_PER_IN) * 1000)).padStart(3, '0') + '"';

export function makeIndex(data) {
  const fit = data.fit.map(([m, cat, models, plug, gap], i) => {
    const maker = data.makers[m];
    const text = `${maker} ${cat} ${models}`.toLowerCase();
    return { i, maker, cat, models, plug, gap, pk: key(plug), text, flat: text.replace(/[^a-z0-9]/g, '') };
  });
  // NGK plugs: the spelling the fitment tables use (with the dash), else the cross tables'
  const ngkName = new Map();
  for (const f of fit) if (!ngkName.has(f.pk)) ngkName.set(f.pk, f.plug);
  const cross = data.cross.map(([brand, num, ngk]) => {
    const pk = key(ngk);
    if (!ngkName.has(pk)) ngkName.set(pk, ngk);
    return { brand, num, nk: key(num), pk };
  });
  const byPlug = new Map(); // NGK key -> {equiv:[{brand,num}], fit:[rows]}
  const slot = (pk) => { if (!byPlug.has(pk)) byPlug.set(pk, { pk, name: ngkName.get(pk), equiv: [], fit: [] }); return byPlug.get(pk); };
  for (const c of cross) slot(c.pk).equiv.push({ brand: c.brand, num: c.num });
  for (const f of fit) slot(f.pk).fit.push(f);
  for (const v of byPlug.values()) {
    const seen = new Set();
    v.equiv = v.equiv.filter((e) => { const k = e.brand + '|' + key(e.num); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.brand.localeCompare(b.brand) || a.num.localeCompare(b.num));
  }
  return { fit, cross, byPlug, ngkName, src: data.src };
}

/**
 * Plug numbers matching q (any brand, or NGK itself): [{plug, hits:[{brand,num}], exact}]
 * best first. A number matches when it starts with what was typed (dashes and spaces ignored).
 */
export function findPlugs(ix, q, limit = 20) {
  const k = key(q);
  if (k.length < 2) return [];
  const out = new Map();
  const add = (pk, hit, exact) => {
    const v = ix.byPlug.get(pk); if (!v) return;
    const r = out.get(pk) || { plug: v, hits: [], exact: false };
    if (hit && !r.hits.some((h) => h.brand === hit.brand && key(h.num) === key(hit.num))) r.hits.push(hit);
    r.exact = r.exact || exact; out.set(pk, r);
  };
  for (const pk of ix.byPlug.keys()) if (pk.startsWith(k)) add(pk, { brand: 'NGK', num: ix.ngkName.get(pk) }, pk === k);
  for (const c of ix.cross) if (c.nk.startsWith(k)) add(c.pk, { brand: c.brand, num: c.num }, c.nk === k);
  return [...out.values()]
    .sort((a, b) => (b.exact - a.exact) || (Math.min(...a.hits.map((h) => key(h.num).length)) - Math.min(...b.hits.map((h) => key(h.num).length))) || a.plug.name.localeCompare(b.plug.name))
    .slice(0, limit);
}

/**
 * Machines matching q ("honda gx160", "stihl ms 290", "chainsaw"): every word must appear in the
 * maker, category or models (spaces and dashes inside a word are ignored, so GX-160 finds GX160).
 */
export function findMachines(ix, q, limit = 80) {
  const words = String(q || '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter((w) => w.length >= 1);
  if (!words.length || words.join('').length < 2) return { rows: [], more: 0 };
  const hit = ix.fit.filter((f) => words.every((w) => f.flat.includes(w)));
  // a model match ranks above a category match; the maker itself matching ranks higher still
  // ("honda gx160": Honda's own GX160 before other makers' machines with a Honda GX160 engine)
  const score = (f) => words.reduce((n, w) => n + (f.models.toLowerCase().replace(/[^a-z0-9]/g, '').includes(w) ? 2 : 0)
    + (f.maker.toLowerCase().replace(/[^a-z0-9]/g, '').includes(w) ? 3 : 0), 0);
  hit.sort((a, b) => score(b) - score(a) || a.maker.localeCompare(b.maker) || a.i - b.i);
  return { rows: hit.slice(0, limit), more: Math.max(0, hit.length - limit) };
}
