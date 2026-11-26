// Spark Plug Finder: the data and the search. Pure logic, no emulator needed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeIndex, findPlugs, findMachines, gapIn, key } from '../src/sparkplug/search.js';

const data = JSON.parse(readFileSync(new URL('../src/sparkplug/plugs.json', import.meta.url), 'utf8'));
const ix = makeIndex(data);

describe('Spark Plug Finder: data', () => {
  test('has the small-engine tables and no glow plugs or UK-only brands', () => {
    assert.ok(data.fit.length > 2000 && data.cross.length > 4000);
    assert.ok(!data.makers.some((m) => /^(Flymo|Hayter|Qualcast|Mountfield|Atco)$/.test(m)));
    assert.ok(!data.fit.some((r) => /^Y-|^YE/.test(r[3]))); // glow plugs
    assert.ok(!data.cross.some((r) => /Unipart|Lodge|KLG/.test(r[0])));
  });
  test('every gap is a real gap in mm', () => {
    assert.ok(data.fit.every((r) => r[4] >= 0.3 && r[4] <= 1.2));
  });
});

describe('Spark Plug Finder: plug numbers', () => {
  test('Champion RJ19LM -> NGK BR2-LM (the dashless spelling is matched)', () => {
    const r = findPlugs(ix, 'rj19lm');
    assert.equal(r[0].plug.name, 'BR2-LM');
    assert.ok(r[0].exact);
    assert.ok(r[0].plug.fit.some((f) => f.maker === 'Briggs & Stratton'));
  });
  test('an NGK number lists other brands for the same plug', () => {
    const r = findPlugs(ix, 'BPMR7A');
    assert.equal(r[0].plug.name, 'BPMR7A');
    assert.ok(r[0].plug.equiv.some((e) => e.brand === 'Champion' && e.num === 'RCJ7Y'));
  });
  test('dashes and spaces are ignored; too short finds nothing', () => {
    assert.equal(findPlugs(ix, 'RJ-19 LM')[0].plug.name, 'BR2-LM');
    assert.deepEqual(findPlugs(ix, 'R'), []);
  });
});

describe('Spark Plug Finder: machines', () => {
  test('Stihl blowers: BR500 takes CMR6H at 0.7 mm', () => {
    const { rows } = findMachines(ix, 'stihl br500');
    assert.ok(rows.length);
    assert.equal(rows[0].plug, 'CMR6H');
    assert.equal(rows[0].gap, 0.7);
  });
  test("a maker's own machines come first", () => {
    const { rows } = findMachines(ix, 'honda gx160');
    assert.equal(rows[0].maker, 'Honda');
    assert.equal(rows[0].models, 'GX160');
    assert.equal(rows[0].plug, 'BPR6ES');
  });
  test('every word must match', () => {
    assert.equal(findMachines(ix, 'stihl zzzzz').rows.length, 0);
  });
  test('gap in inches', () => {
    assert.equal(gapIn(0.6), '.024"');
    assert.equal(gapIn(0.7), '.028"');
    assert.equal(gapIn(1.0), '.039"');
    assert.equal(key('BR2-LM'), 'BR2LM');
  });
});
