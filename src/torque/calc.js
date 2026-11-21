// Torque Chart: the numbers.
//
// Every value is calculated, not copied from someone else's chart, using the
// same short-form formula the published tables use:
//
//   T = K × D × F
//     D  nominal bolt diameter
//     F  clamp load = 75% of the bolt's proof load (proof stress × tensile stress area)
//     K  nut factor: 0.20 dry (plain or zinc-plated, as received), 0.15 oiled
//
// Proof stress comes from the standards:
//   SAE J429 (inch):  Grade 2  55,000 psi up to 3/4", 33,000 psi above
//                     Grade 5  85,000 psi up to 1"
//                     Grade 8 120,000 psi
//   ISO 898-1 (metric): 8.8  580 MPa up to M16, 600 MPa above
//                       10.9 830 MPa
//                       12.9 970 MPa
// Tensile stress area:
//   inch    As = 0.7854 × (D − 0.9743 / TPI)²     (in²)
//   metric  As = 0.7854 × (d − 0.9382 × P)²       (mm²)
//
// Pure functions, no page code, so tests can check them (tests/torque.calc.test.js).

export const K = { dry: 0.2, oiled: 0.15 };
export const CLAMP = 0.75;

// [size label, diameter in inches, coarse TPI, fine TPI, hex wrench size]
export const SAE_SIZES = [
  ['#8', 0.164, 32, 36, ''],
  ['#10', 0.19, 24, 32, ''],
  ['1/4', 0.25, 20, 28, '7/16"'],
  ['5/16', 0.3125, 18, 24, '1/2"'],
  ['3/8', 0.375, 16, 24, '9/16"'],
  ['7/16', 0.4375, 14, 20, '5/8"'],
  ['1/2', 0.5, 13, 20, '3/4"'],
  ['9/16', 0.5625, 12, 18, '13/16"'],
  ['5/8', 0.625, 11, 18, '15/16"'],
  ['3/4', 0.75, 10, 16, '1-1/8"'],
  ['7/8', 0.875, 9, 14, '1-5/16"'],
  ['1', 1, 8, 12, '1-1/2"'],
];

// [size label, diameter mm, pitch mm, coarse or fine, hex wrench (ISO 4017), older DIN 931 wrench if different]
export const METRIC_SIZES = [
  ['M4', 4, 0.7, 'Coarse', '7 mm', ''],
  ['M5', 5, 0.8, 'Coarse', '8 mm', ''],
  ['M6', 6, 1, 'Coarse', '10 mm', ''],
  ['M8', 8, 1.25, 'Coarse', '13 mm', ''],
  ['M8', 8, 1, 'Fine', '13 mm', ''],
  ['M10', 10, 1.5, 'Coarse', '16 mm', '17 mm'],
  ['M10', 10, 1.25, 'Fine', '16 mm', '17 mm'],
  ['M12', 12, 1.75, 'Coarse', '18 mm', '19 mm'],
  ['M12', 12, 1.5, 'Fine', '18 mm', '19 mm'],
  ['M12', 12, 1.25, 'Fine', '18 mm', '19 mm'],
  ['M14', 14, 2, 'Coarse', '21 mm', '22 mm'],
  ['M14', 14, 1.5, 'Fine', '21 mm', '22 mm'],
  ['M16', 16, 2, 'Coarse', '24 mm', ''],
  ['M16', 16, 1.5, 'Fine', '24 mm', ''],
  ['M18', 18, 2.5, 'Coarse', '27 mm', ''],
  ['M18', 18, 1.5, 'Fine', '27 mm', ''],
  ['M20', 20, 2.5, 'Coarse', '30 mm', ''],
  ['M20', 20, 1.5, 'Fine', '30 mm', ''],
  ['M22', 22, 2.5, 'Coarse', '34 mm', '32 mm'],
  ['M24', 24, 3, 'Coarse', '36 mm', ''],
  ['M24', 24, 2, 'Fine', '36 mm', ''],
];

export const SAE_GRADES = ['2', '5', '8'];
export const METRIC_CLASSES = ['8.8', '10.9', '12.9'];

export const MARKINGS = {
  '2': 'none',
  '5': '3 lines',
  '8': '6 lines',
  '8.8': '8.8 stamped',
  '10.9': '10.9 stamped',
  '12.9': '12.9 stamped',
};

/** SAE J429 proof stress, psi. */
export function saeProof(grade, d) {
  if (grade === '2') return d <= 0.75 ? 55000 : 33000;
  if (grade === '5') return d <= 1 ? 85000 : 74000;
  if (grade === '8') return 120000;
  throw new Error('Unknown grade ' + grade);
}

/** ISO 898-1 proof stress, MPa. */
export function metricProof(cls, d) {
  if (cls === '8.8') return d <= 16 ? 580 : 600;
  if (cls === '10.9') return 830;
  if (cls === '12.9') return 970;
  throw new Error('Unknown class ' + cls);
}

export const saeArea = (d, tpi) => 0.7854 * (d - 0.9743 / tpi) ** 2; // in²
export const metricArea = (d, p) => 0.7854 * (d - 0.9382 * p) ** 2; // mm²

// ---------- units ----------------------------------------------------------------

const NM = { 'ft-lb': 1.3558179483, 'in-lb': 0.1129848290, 'N·m': 1, 'kgf·m': 9.80665, 'kgf·cm': 0.0980665 };
export const UNITS = Object.keys(NM);

/** Convert a torque from one unit to another. */
export function convert(value, from, to) {
  if (!(from in NM) || !(to in NM)) throw new Error('Unknown unit');
  return (value * NM[from]) / NM[to];
}

/** A torque value rounded the way a wrench is read: whole numbers, one decimal under 10 (two under 1). */
export function fmt(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return String(Math.round(v));
  if (a >= 1) return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return (Math.round(v * 100) / 100).toFixed(2).replace(/0$/, '');
}

/** Clamp load and torque for one bolt. Torque comes back in N·m (exact); use convert() for others. */
export function sae(size, tpi, grade, cond) {
  const s = SAE_SIZES.find((r) => r[0] === size);
  if (!s) throw new Error('Unknown size ' + size);
  const d = s[1];
  const area = saeArea(d, tpi);
  const clampLb = CLAMP * saeProof(grade, d) * area;
  const inLb = K[cond] * d * clampLb;
  return { nm: convert(inLb, 'in-lb', 'N·m'), clampLb, clampN: clampLb * 4.4482216 };
}

export function metric(size, pitch, cls, cond) {
  const s = METRIC_SIZES.find((r) => r[0] === size && r[2] === pitch);
  if (!s) throw new Error('Unknown size ' + size + 'x' + pitch);
  const d = s[1];
  const clampN = CLAMP * metricProof(cls, d) * metricArea(d, pitch);
  const nm = (K[cond] * d * clampN) / 1000;
  return { nm, clampN, clampLb: clampN / 4.4482216 };
}

// ---------- the bolts, as rows ----------------------------------------------------

/** Every inch bolt: {sys, size, tpi, series, id, label, wrench, d}. */
export function saeRows() {
  const out = [];
  for (const [size, d, c, f, wrench] of SAE_SIZES) {
    out.push({ sys: 'sae', size, tpi: c, series: 'UNC', id: `${size}-${c}`, label: `${size}-${c}`, wrench, d });
    out.push({ sys: 'sae', size, tpi: f, series: 'UNF', id: `${size}-${f}`, label: `${size}-${f}`, wrench, d });
  }
  return out;
}
export function metricRows() {
  return METRIC_SIZES.map(([size, d, p, series, wrench, din]) => ({
    sys: 'metric', size, pitch: p, series, id: `${size}x${p}`, label: `${size}×${p}`, wrench, din, d,
  }));
}

/** Torque for a row: {nm, clampLb, clampN}. */
export function torqueFor(row, grade, cond) {
  return row.sys === 'sae' ? sae(row.size, row.tpi, grade, cond) : metric(row.size, row.pitch, grade, cond);
}

// ---------- reading what someone typed ---------------------------------------------

/**
 * "3/8-16", "3/8", "3/8 fine", "#10-32", "10-24", "M10", "M10x1.25", "m12 fine", "10mm"
 * -> {kind:'sae'|'metric', row, rows} | {kind:'miss', near?} | {kind:'empty'}
 */
export function parseBolt(raw) {
  let s = String(raw || '').toLowerCase().replace(/[″"']|inch(es)?|\bin\b/g, '').replace(/×/g, 'x').replace(/\s+/g, ' ').trim();
  if (!s) return { kind: 'empty' };
  const fine = /\b(fine|unf)\b/.test(s);
  s = s.replace(/\b(fine|unf|coarse|unc|bolt|screw|grade|gr)\b/g, '').trim();
  let m = s.replace(/\s/g, '').match(/^m?(\d+(?:\.\d+)?)(?:mm)?(?:x(\d*\.?\d+))?$/);
  const isMetric = /^m/.test(s.replace(/\s/g, '')) || /mm/.test(s);
  if (m && isMetric) {
    const size = 'M' + +m[1];
    const rows = metricRows().filter((r) => r.size === size);
    if (!rows.length) return { kind: 'miss' };
    const row = m[2] ? rows.find((r) => Math.abs(r.pitch - parseFloat(m[2])) < 1e-6) : fine ? rows.find((r) => r.series === 'Fine') : rows[0];
    return row ? { kind: 'metric', row, rows } : { kind: 'miss', near: rows.map((r) => r.id) };
  }
  m = s.replace(/\s*-\s*/g, '-').replace(/\s/g, '').match(/^(#?\d+(?:\/\d+)?)(?:[-x](\d+))?$/);
  if (m) {
    let size = m[1];
    if (!size.includes('/') && !size.startsWith('#') && size !== '1') size = '#' + size;
    const rows = saeRows().filter((r) => r.size === size);
    if (!rows.length) return { kind: 'miss' };
    const row = m[2] ? rows.find((r) => r.tpi === +m[2]) : fine ? rows.find((r) => r.series === 'UNF') : rows[0];
    return row ? { kind: 'sae', row, rows } : { kind: 'miss', near: rows.map((r) => r.id) };
  }
  return { kind: 'miss' };
}

// ---------- the bolt grades reference tab -------------------------------------------
// Strengths from SAE J429 and ISO 898-1 (minimum values).

export const GRADE_INFO = [
  { g: '2', sys: 'sae', name: 'SAE Grade 2', marks: 'No marks (maybe a maker\'s mark)', steel: 'Low or medium carbon steel',
    tensile: '74,000 psi (1/4" to 3/4"), 60,000 psi above', proof: '55,000 psi (1/4" to 3/4"), 33,000 psi above',
    like: 'About like metric class 4.6 / 5.8', uses: 'Light duty: household, trim, brackets, hardware-store bolts. Not for anything that carries a real load.' },
  { g: '5', sys: 'sae', name: 'SAE Grade 5', marks: '3 lines, 120° apart', steel: 'Medium carbon steel, hardened (quenched and tempered)',
    tensile: '120,000 psi (1/4" to 1")', proof: '85,000 psi (1/4" to 1")',
    like: 'About like metric class 8.8', uses: 'Most car, truck and equipment bolts: engine accessories, brackets, body and frame bolts.' },
  { g: '8', sys: 'sae', name: 'SAE Grade 8', marks: '6 lines, 60° apart', steel: 'Medium carbon alloy steel, hardened',
    tensile: '150,000 psi', proof: '120,000 psi',
    like: 'About like metric class 10.9', uses: 'High stress: suspension, steering, hitches, heavy equipment. Harder, so it snaps rather than bends when overloaded.' },
  { g: '8.8', sys: 'metric', name: 'Metric class 8.8', marks: '"8.8" stamped on the head', steel: 'Medium carbon steel, hardened',
    tensile: '800 MPa (M16 and under), 830 MPa above', proof: '580 MPa (M16 and under), 600 MPa above',
    like: 'About like SAE Grade 5', uses: 'The everyday metric bolt on cars, mowers and machinery.' },
  { g: '10.9', sys: 'metric', name: 'Metric class 10.9', marks: '"10.9" stamped on the head', steel: 'Alloy steel, hardened',
    tensile: '1,040 MPa', proof: '830 MPa',
    like: 'About like SAE Grade 8', uses: 'High stress metric bolts: suspension, drivetrain, engine mounts.' },
  { g: '12.9', sys: 'metric', name: 'Metric class 12.9', marks: '"12.9" stamped on the head', steel: 'Alloy steel, hardened',
    tensile: '1,220 MPa', proof: '970 MPa',
    like: 'Stronger than SAE Grade 8', uses: 'Mostly socket head (Allen) cap screws in machines and tooling. Brittle compared with 8.8; don\'t swap one in where a softer bolt was meant to stretch.' },
];
