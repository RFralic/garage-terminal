// code128.js: Code 128 barcodes for Pantry labels, with no libraries.
//
// Homemade batch codes are all digits (8 of them, see batchCode() in logic.js),
// so they use Code 128 set C, which packs two digits into each symbol. That
// keeps the barcode short enough for a 30 × 20 mm label at 203 dpi with bars
// 2 printer dots wide. Tested on a Katasymbol T50M + the Logbook scanner.

// Bar/space widths of each symbol value 0–106, in modules (each adds up to 11; Stop is 13).
const PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

const START_C = 105;
const STOP = 106;
/** White space required on each side of the bars, in modules. */
export const QUIET = 10;

/** Symbol values for an even-length string of digits: Start C, digit pairs, check, Stop. */
export function code128cValues(digits) {
  if (!/^(\d\d)+$/.test(digits)) throw new Error('Code 128 set C needs an even number of digits');
  const vals = [START_C];
  for (let i = 0; i < digits.length; i += 2) vals.push(Number(digits.slice(i, i + 2)));
  const check = vals.reduce((sum, v, i) => sum + (i === 0 ? v : v * i), 0) % 103;
  return [...vals, check, STOP];
}

/** The barcode as modules: true = bar, false = space. No quiet zones. */
export function code128cModules(digits) {
  const mods = [];
  for (const v of code128cValues(digits)) {
    let bar = true;
    for (const w of PATTERNS[v]) {
      for (let i = 0; i < Number(w); i++) mods.push(bar);
      bar = !bar;
    }
  }
  return mods;
}

/** Width in printer dots, quiet zones included, for bars `module` dots wide. */
export function code128cWidth(digits, module) {
  return (code128cModules(digits).length + 2 * QUIET) * module;
}

/** Reads modules back into symbol values (used by the tests to prove the bars are right). */
export function decodeModules(mods) {
  const runs = [];
  for (const m of mods) {
    if (runs.length && runs[runs.length - 1].bar === m) runs[runs.length - 1].n++;
    else runs.push({ bar: m, n: 1 });
  }
  const widths = runs.map((r) => r.n).join('');
  const vals = [];
  for (let i = 0; i < widths.length;) {
    if (widths.slice(i, i + 7) === PATTERNS[STOP]) { vals.push(STOP); break; }
    const v = PATTERNS.indexOf(widths.slice(i, i + 6));
    if (v < 0) throw new Error('bad symbol at ' + i);
    vals.push(v);
    i += 6;
  }
  return vals;
}

export const _PATTERNS = PATTERNS;
