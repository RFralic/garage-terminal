// Fuel Mix: 2-stroke gas and oil ratios. Pure functions, tested in tests/fuelmix.calc.test.js.
//
// A ratio of 50:1 means 50 parts gas to 1 part oil, so oil = gas / 50.
// US: 1 gallon = 128 fl oz. Metric: 1 liter = 1000 mL. 1 US fl oz = 29.5735 mL.

export const OZ_PER_GAL = 128;
export const ML_PER_OZ = 29.5735295625;
export const L_PER_GAL = 3.785411784;
export const RATIOS = [16, 20, 24, 25, 32, 40, 50, 100];
export const CANS_GAL = [1, 2, 2.5, 5];
export const CANS_L = [1, 5, 10, 20];
export const BOTTLES_OZ = [2.6, 3.2, 5.2, 6.4, 12.8];

/** Gas in gallons from an amount and unit ('gal' | 'L'). */
export const toGal = (amount, unit) => (unit === 'L' ? amount / L_PER_GAL : amount);

/** Oil for this much gas at ratio:1 -> {oz, ml}. */
export function oilFor(amount, unit, ratio) {
  if (!(amount > 0) || !(ratio > 0)) return null;
  const oz = (toGal(amount, unit) * OZ_PER_GAL) / ratio;
  return { oz, ml: oz * ML_PER_OZ };
}

/** How much gas one bottle of oil mixes with at ratio:1 -> {gal, L}. */
export function gasForOil(oilOz, ratio) {
  if (!(oilOz > 0) || !(ratio > 0)) return null;
  const gal = (oilOz * ratio) / OZ_PER_GAL;
  return { gal, L: gal * L_PER_GAL };
}

/**
 * Fix a mix: there's `gasGal` gallons of gas with `oilOz` of oil in it, and it should be ratio:1.
 * -> {actual, ok} | {actual, addGasGal} (too much oil) | {actual, addOilOz} (too little oil)
 * `actual` is the ratio it is now (gas:oil), e.g. 40 for 40:1.
 */
export function fixMix(gasGal, oilOz, ratio) {
  if (!(gasGal > 0) || !(ratio > 0) || !(oilOz >= 0)) return null;
  const actual = oilOz > 0 ? (gasGal * OZ_PER_GAL) / oilOz : Infinity;
  const needOz = (gasGal * OZ_PER_GAL) / ratio;
  if (Math.abs(actual - ratio) / ratio < 0.02) return { actual, ok: true };
  if (oilOz > needOz) return { actual, addGasGal: (oilOz * ratio) / OZ_PER_GAL - gasGal };
  return { actual, addOilOz: needOz - oilOz };
}

// ---------- showing amounts ----------------------------------------------------------

/** Fluid ounces, one decimal (two under 1 oz). */
export const fmtOz = (oz) => (oz < 1 ? (Math.round(oz * 100) / 100).toString() : (Math.round(oz * 10) / 10).toFixed(1).replace(/\.0$/, ''));
/** Milliliters, whole numbers. */
export const fmtMl = (ml) => String(Math.round(ml));
/** Gallons or liters, up to two decimals, no trailing zeros. */
export const fmtAmt = (v) => String(Math.round(v * 100) / 100);

const FRAC8 = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];
/**
 * A kitchen measure for the oil: under 4 oz (½ cup) in tablespoons (1 fl oz = 2 tbsp),
 * otherwise cups to the nearest ⅛ (1 cup = 8 fl oz). Always says "about".
 */
export function kitchen(oz) {
  if (!(oz > 0)) return '';
  if (oz < 4) {
    if (oz < 0.5) return `about ${Math.max(0.5, Math.round(oz * 6 * 2) / 2)} tsp`; // under 1 tbsp: teaspoons (1 fl oz = 6 tsp)
    return `about ${Math.round(oz * 2 * 2) / 2} tbsp`; // nearest half tablespoon
  }
  const eighths = Math.round((oz / 8) * 8);
  const whole = Math.floor(eighths / 8), part = eighths % 8;
  const txt = whole ? `${whole}${FRAC8[part]}` : FRAC8[part] || '0';
  return `about ${txt} cup${eighths > 8 ? 's' : ''}`;
}

/** "50" or "50:1" or "50 : 1" -> 50; anything else -> 0. */
export function parseRatio(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,3}(?:\.\d+)?)\s*(?::\s*1)?$/);
  const n = m ? parseFloat(m[1]) : 0;
  return n >= 5 && n <= 200 ? n : 0;
}
