// Fuel Mix: the math. Pure logic, no emulator needed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { oilFor, gasForOil, fixMix, fmtOz, fmtMl, kitchen, parseRatio } from '../src/fuelmix/calc.js';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `got ${a}, want ${b}`);

describe('Fuel Mix: oil for the gas', () => {
  test('5 gal at 50:1 = 12.8 oz (379 mL)', () => {
    const r = oilFor(5, 'gal', 50);
    near(r.oz, 12.8);
    assert.equal(fmtMl(r.ml), '379');
  });
  test('common US amounts', () => {
    near(oilFor(1, 'gal', 50).oz, 2.56);
    near(oilFor(1, 'gal', 40).oz, 3.2);
    near(oilFor(2.5, 'gal', 50).oz, 6.4);
    near(oilFor(1, 'gal', 32).oz, 4);
    near(oilFor(1, 'gal', 16).oz, 8);
  });
  test('liters: 5 L at 50:1 = 100 mL, 1 L at 40:1 = 25 mL', () => {
    near(oilFor(5, 'L', 50).ml, 100, 0.01);
    near(oilFor(1, 'L', 40).ml, 25, 0.01);
  });
  test('nothing for empty or zero', () => {
    assert.equal(oilFor(0, 'gal', 50), null);
    assert.equal(oilFor(5, 'gal', 0), null);
  });
});

describe('Fuel Mix: I have a bottle', () => {
  test('2.6 oz at 50:1 ≈ 1 gal; 12.8 oz at 50:1 = 5 gal; 3.2 oz at 40:1 = 1 gal', () => {
    near(gasForOil(2.6, 50).gal, 1.016);
    near(gasForOil(12.8, 50).gal, 5);
    near(gasForOil(3.2, 40).gal, 1);
  });
});

describe('Fuel Mix: fix a mix', () => {
  test('right already', () => assert.equal(fixMix(5, 12.8, 50).ok, true));
  test('too much oil: 5 gal with 16 oz meant for 50:1 -> add 1.25 gal gas', () => {
    const r = fixMix(5, 16, 50);
    near(r.actual, 40);
    near(r.addGasGal, 1.25);
  });
  test('too little oil: 5 gal with 6.4 oz meant for 50:1 -> add 6.4 oz oil', () => {
    const r = fixMix(5, 6.4, 50);
    near(r.actual, 100);
    near(r.addOilOz, 6.4);
  });
  test('no oil yet', () => near(fixMix(1, 0, 50).addOilOz, 2.56));
});

describe('Fuel Mix: showing amounts', () => {
  test('ounces', () => {
    assert.equal(fmtOz(12.8), '12.8');
    assert.equal(fmtOz(2.56), '2.6');
    assert.equal(fmtOz(4), '4');
    assert.equal(fmtOz(0.64), '0.64');
  });
  test('kitchen measures', () => {
    assert.equal(kitchen(12.8), 'about 1⅝ cups');
    assert.equal(kitchen(8), 'about 1 cup');
    assert.equal(kitchen(4), 'about ½ cup');
    assert.equal(kitchen(2.56), 'about 5 tbsp');
    assert.equal(kitchen(1.28), 'about 2.5 tbsp');
    assert.equal(kitchen(0.2), 'about 1 tsp');
  });
  test('ratios typed in', () => {
    assert.equal(parseRatio('50'), 50);
    assert.equal(parseRatio('50:1'), 50);
    assert.equal(parseRatio(' 40 : 1 '), 40);
    assert.equal(parseRatio('abc'), 0);
    assert.equal(parseRatio('1000'), 0);
  });
});
