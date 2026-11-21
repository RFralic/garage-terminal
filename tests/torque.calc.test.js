// Torque Chart: check the calculated values against well-known published charts
// (dry, K = 0.20, 75% of proof load). Charts round differently, so allow 6%.
// Pure logic, no emulator needed.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sae, metric, convert, fmt, parseBolt, saeRows, metricRows, torqueFor, UNITS } from '../src/torque/calc.js';

const near = (got, want, pct = 6) => assert.ok(Math.abs(got - want) / want * 100 <= pct, `got ${got.toFixed(1)}, want about ${want}`);
const ftlb = (r) => convert(r.nm, 'N·m', 'ft-lb');

describe('Torque Chart: SAE values match published charts', () => {
  const grade5 = [['1/4', 20, 8], ['5/16', 18, 17], ['3/8', 16, 31], ['7/16', 14, 49], ['1/2', 13, 75], ['9/16', 12, 110], ['5/8', 11, 150], ['3/4', 10, 265], ['1', 8, 640]];
  for (const [s, t, want] of grade5) test(`${s}-${t} Grade 5 dry ≈ ${want} ft-lb`, () => near(ftlb(sae(s, t, '5', 'dry')), want));
  const grade8 = [['1/4', 20, 12], ['3/8', 16, 44], ['1/2', 13, 106], ['5/8', 11, 212], ['3/4', 10, 376], ['1', 8, 900]];
  for (const [s, t, want] of grade8) test(`${s}-${t} Grade 8 dry ≈ ${want} ft-lb`, () => near(ftlb(sae(s, t, '8', 'dry')), want));
  test('Grade 2 drops above 3/4"', () => {
    assert.ok(ftlb(sae('7/8', 9, '2', 'dry')) < ftlb(sae('3/4', 10, '2', 'dry')) * 1.3);
  });
  test('oiled is 25% less than dry', () => near(sae('1/2', 13, '5', 'oiled').nm, sae('1/2', 13, '5', 'dry').nm * 0.75, 0.01));
  test('clamp load: 3/8-16 Grade 5 ≈ 4,940 lb', () => near(sae('3/8', 16, '5', 'dry').clampLb, 4940, 1));
});

describe('Torque Chart: metric values match published charts', () => {
  const c88 = [['M6', 1, 10], ['M8', 1.25, 25], ['M10', 1.5, 49], ['M12', 1.75, 86], ['M16', 2, 210], ['M20', 2.5, 425]];
  for (const [s, p, want] of c88) test(`${s}×${p} class 8.8 dry ≈ ${want} N·m`, () => near(metric(s, p, '8.8', 'dry').nm, want));
  const c109 = [['M8', 1.25, 36], ['M10', 1.5, 72], ['M12', 1.75, 125]];
  for (const [s, p, want] of c109) test(`${s}×${p} class 10.9 dry ≈ ${want} N·m`, () => near(metric(s, p, '10.9', 'dry').nm, want));
});

describe('Torque Chart: units and rounding', () => {
  test('conversions', () => {
    near(convert(1, 'ft-lb', 'N·m'), 1.3558, 0.01);
    near(convert(1, 'ft-lb', 'in-lb'), 12, 0.001);
    near(convert(1, 'kgf·m', 'ft-lb'), 7.233, 0.01);
    near(convert(100, 'kgf·cm', 'N·m'), 9.80665, 0.001);
    for (const u of UNITS) near(convert(convert(42, 'N·m', u), u, 'N·m'), 42, 0.0001);
  });
  test('fmt', () => {
    assert.equal(fmt(30.9), '31');
    assert.equal(fmt(8.44), '8.4');
    assert.equal(fmt(8.0), '8');
    assert.equal(fmt(0.456), '0.46');
    assert.equal(fmt(640.4), '640');
  });
});

describe('Torque Chart: reading a bolt size', () => {
  const id = (s) => { const p = parseBolt(s); return p.row ? p.row.id : p.kind; };
  test('inch', () => {
    assert.equal(id('3/8-16'), '3/8-16');
    assert.equal(id('3/8'), '3/8-16');
    assert.equal(id('3/8 fine'), '3/8-24');
    assert.equal(id('#10-32'), '#10-32');
    assert.equal(id('10-24'), '#10-24');
    assert.equal(id('1/2" unf'), '1/2-20');
    assert.equal(id('1-8'), '1-8');
  });
  test('metric', () => {
    assert.equal(id('M10'), 'M10x1.5');
    assert.equal(id('m10x1.25'), 'M10x1.25');
    assert.equal(id('M12 fine'), 'M12x1.5');
    assert.equal(id('12mm'), 'M12x1.75');
    assert.equal(id('M10×1.25'), 'M10x1.25');
  });
  test('misses', () => {
    assert.equal(id(''), 'empty');
    assert.equal(id('M7'), 'miss');
    assert.deepEqual(parseBolt('3/8-20').near, ['3/8-16', '3/8-24']);
  });
  test('every row in the chart calculates for every grade', () => {
    for (const r of saeRows()) for (const g of ['2', '5', '8']) assert.ok(torqueFor(r, g, 'dry').nm > 0);
    for (const r of metricRows()) for (const g of ['8.8', '10.9', '12.9']) assert.ok(torqueFor(r, g, 'oiled').nm > 0);
  });
});
