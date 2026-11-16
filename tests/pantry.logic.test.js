// Pantry (apps/pantry): counts, expiration dates, barcode matching, homemade
// batch codes and the Code 128 bars printed on labels.
// Pure logic (no emulator needed), but runs with the rest via:  npm test

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeKey, findByCode, batchCode, batchFromCode, spacedCode, addMonths, daysBetween, fmtMDY, fmtMY, fmtShort,
  useByFor, sortLots, totalQty, useFromLots, addToLots, nextExpiry, expiryStatus, shortBy, lowItems,
  expiringItems, shoppingText, makeInviteCode, normalizeInvite, spacedInvite, parseSize, formatSize, SIZE_UNITS,
} from '../src/pantry/logic.js';
import { code128cValues, code128cModules, code128cWidth, decodeModules, QUIET, _PATTERNS } from '../src/pantry/code128.js';

describe('Pantry: barcodes', () => {
  test('a UPC read as EAN-13 (extra leading 0) still matches', () => {
    assert.equal(codeKey('0041331021551'), '041331021551');
    assert.equal(codeKey(' 041331021551\r'), '041331021551');
    const items = [{ id: 'a', barcodes: ['041331021551'] }, { id: 'b', barcodes: [] }];
    assert.deepEqual(findByCode(items, '0041331021551').map((i) => i.id), ['a']);
  });

  test('other codes ignore spaces, dashes and capitals', () => {
    assert.equal(codeKey('ab-12 3'), 'AB123');
    assert.deepEqual(findByCode([{ id: 'x', barcodes: ['AB123'] }], 'ab-123').map((i) => i.id), ['x']);
    assert.deepEqual(findByCode([{ id: 'x', barcodes: ['AB123'] }], ''), []);
  });

  test('homemade batch codes: 8 digits starting with 2', () => {
    assert.equal(batchCode(42), '20000042');
    assert.equal(batchCode(9999999), '29999999');
    assert.throws(() => batchCode(0));
    assert.equal(batchFromCode('20000042'), 42);
    assert.equal(batchFromCode('041331021551'), null);
    assert.equal(batchFromCode('20000000'), null);
    assert.equal(spacedCode('20000042'), '2000 0042');
  });
});

describe('Pantry: Code 128 labels', () => {
  test('every symbol pattern adds up to 11 modules (Stop: 13)', () => {
    assert.equal(_PATTERNS.length, 107);
    _PATTERNS.forEach((p, i) => assert.equal([...p].reduce((s, d) => s + +d, 0), i === 106 ? 13 : 11, `symbol ${i}`));
  });

  test('20000042 encodes as Start C, 20, 00, 00, 42, check 87, Stop (the label that scanned)', () => {
    assert.deepEqual(code128cValues('20000042'), [105, 20, 0, 0, 42, 87, 106]);
    assert.deepEqual(decodeModules(code128cModules('20000042')), [105, 20, 0, 0, 42, 87, 106]);
  });

  test('fits a 30 mm label (240 dots) with 2-dot bars, quiet zones included', () => {
    assert.equal(code128cModules('20000042').length, 79);
    assert.equal(code128cWidth('20000042', 2), (79 + 2 * QUIET) * 2);
    assert.ok(code128cWidth('29999999', 2) <= 240);
  });

  test('only even-length digit strings', () => {
    assert.throws(() => code128cValues('123'));
    assert.throws(() => code128cValues('12AB'));
  });
});

describe('Pantry: dates', () => {
  test('adding months keeps the day, or the month\'s last day', () => {
    assert.equal(addMonths('2026-06-14', 12), '2027-06-14');
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  });

  test('formats', () => {
    assert.equal(fmtMDY('2026-06-14'), '06/14/26');
    assert.equal(fmtMY('2027-06-14'), '06/2027');
    assert.equal(fmtShort('2026-11-18', '2026-11-16'), 'Nov 18');
    assert.equal(fmtShort('2027-03-01', '2026-11-16'), 'Mar 1, 2027');
    assert.equal(daysBetween('2026-11-16', '2026-11-18'), 2);
  });

  test('use-by defaults by method, or the pantry\'s own setting', () => {
    assert.equal(useByFor('Water bath', '2026-06-14'), '2027-06-14');
    assert.equal(useByFor('Frozen', '2026-06-14'), '2026-12-14');
    assert.equal(useByFor('Frozen', '2026-06-14', { Frozen: 9 }), '2027-03-14');
    assert.equal(useByFor('Something new', '2026-06-14'), '2026-09-14');
  });
});

describe('Pantry: counts and lots', () => {
  const beans = { name: 'Black beans', lots: [{ qty: 4, expires: '2028-03-01' }, { qty: 2, expires: '2027-08-01' }] };

  test('total and soonest expiration', () => {
    assert.equal(totalQty(beans), 6);
    assert.equal(nextExpiry(beans), '2027-08-01');
    assert.deepEqual(sortLots([{ qty: 1, expires: '' }, { qty: 2, expires: '2027-01-01' }, { qty: 0, expires: '2026-01-01' }]),
      [{ qty: 2, expires: '2027-01-01' }, { qty: 1, expires: '' }]);
  });

  test('Used 1 takes from the lot that expires first; empty lots go away', () => {
    let r = useFromLots(beans.lots, 1);
    assert.deepEqual(r, { lots: [{ qty: 1, expires: '2027-08-01' }, { qty: 4, expires: '2028-03-01' }], taken: 1 });
    r = useFromLots(beans.lots, 3);
    assert.deepEqual(r.lots, [{ qty: 3, expires: '2028-03-01' }]);
    assert.equal(useFromLots([], 1).taken, 0);
    assert.equal(useFromLots(beans.lots, 10).taken, 6);
  });

  test('Got 1 joins the newest lot, or a lot with the same date', () => {
    assert.deepEqual(addToLots(beans.lots, 1), [{ qty: 2, expires: '2027-08-01' }, { qty: 5, expires: '2028-03-01' }]);
    assert.deepEqual(addToLots(beans.lots, 2, '2027-08-01'), [{ qty: 4, expires: '2027-08-01' }, { qty: 4, expires: '2028-03-01' }]);
    assert.deepEqual(addToLots([], 1), [{ qty: 1, expires: '' }]);
    assert.deepEqual(addToLots([{ qty: 1, expires: '' }], 2, '2026-12-01'), [{ qty: 2, expires: '2026-12-01' }, { qty: 1, expires: '' }]);
  });

  test('expiring soon, expired, low stock and the shopping list', () => {
    const today = '2026-11-16';
    assert.equal(expiryStatus('2026-11-15', today), 'expired');
    assert.equal(expiryStatus('2026-11-23', today), 'soon');
    assert.equal(expiryStatus('2026-11-24', today), 'ok');
    assert.equal(expiryStatus('', today), '');
    const milk = { name: 'Milk', lots: [{ qty: 1, expires: '2026-11-18' }], keepAtLeast: 2 };
    const towels = { name: 'Paper towels', size: '6 pk', lots: [{ qty: 2, expires: '' }], keepAtLeast: 6 };
    const gone = { name: 'Old', lots: [{ qty: 0, expires: '2026-11-01' }] };
    assert.equal(shortBy(milk), 1);
    assert.equal(shortBy(beans), 0);
    assert.deepEqual(lowItems([towels, beans, milk]).map((i) => i.name), ['Milk', 'Paper towels']);
    assert.deepEqual(expiringItems([beans, milk, gone], today).map((i) => i.name), ['Milk']);
    assert.equal(shoppingText([towels], [{ name: 'Bananas', done: false }, { name: 'Done', done: true }]),
      '- Paper towels (6 pk): buy 4\n- Bananas');
  });
});

describe('Pantry: size or count', () => {
  test('reads sizes and counts back into number + unit', () => {
    assert.deepEqual(parseSize('8 oz'), { num: '8', unit: 'oz' });
    assert.deepEqual(parseSize('1.5 lb'), { num: '1.5', unit: 'lb' });
    assert.deepEqual(parseSize('12 pieces'), { num: '12', unit: 'pieces' });
    assert.deepEqual(parseSize('24 ct'), { num: '24', unit: 'count' });
    assert.deepEqual(parseSize('2 Quarts'), { num: '2', unit: 'qt' });
    assert.deepEqual(parseSize('16 fl oz'), { num: '16', unit: 'fl oz' });
    assert.deepEqual(parseSize('1 L'), { num: '1', unit: 'L' });
    assert.deepEqual(parseSize(''), { num: '', unit: '' });
  });

  test('anything else stays as typed', () => {
    assert.deepEqual(parseSize('8 oz (half-pint)'), { other: '8 oz (half-pint)' });
    assert.deepEqual(parseSize('family size'), { other: 'family size' });
    assert.deepEqual(parseSize('12 cookies'), { other: '12 cookies' });
  });

  test('writes them out', () => {
    assert.equal(formatSize('12', 'pieces'), '12 pieces');
    assert.equal(formatSize('8', 'oz'), '8 oz');
    assert.equal(formatSize('', 'oz'), '');
    for (const [, units] of SIZE_UNITS) for (const u of units) assert.deepEqual(parseSize(formatSize('3', u)), { num: '3', unit: u });
  });
});

describe('Pantry: invite codes', () => {
  test('8 easy-to-read characters, typed any way', () => {
    const c = makeInviteCode();
    assert.match(c, /^[A-HJKMNP-Z2-9]{8}$/);
    assert.equal(normalizeInvite('k7q2-mxab'), 'K7Q2MXAB');
    assert.equal(normalizeInvite('short'), '');
    assert.equal(spacedInvite('K7Q2MXAB'), 'K7Q2-MXAB');
  });
});

describe('Pantry: label images', () => {
  test('PNGs are marked 203 dpi (one pHYs chunk, right after the header)', async () => {
    const { withDpi, labelFileName } = await import('../src/pantry/label.js');
    const { readFileSync } = await import('node:fs');
    const png = new Uint8Array(readFileSync(new URL('../public/favicon-32.png', import.meta.url)));
    const out = withDpi(withDpi(png)); // twice: still one chunk
    const v = new DataView(out.buffer);
    const types = [];
    for (let at = 8; at + 12 <= out.length; at += 12 + v.getUint32(at)) types.push(String.fromCharCode(...out.subarray(at + 4, at + 8)));
    assert.deepEqual(types.slice(0, 2), ['IHDR', 'pHYs']);
    assert.equal(types.filter((t) => t === 'pHYs').length, 1);
    const at = 8 + 25;
    assert.equal(v.getUint32(at + 8), 7992); // 203 dpi in pixels per metre
    assert.equal(labelFileName({ name: 'Strawberry Jam!', batch: 42 }, '40x30'), 'label-strawberry-jam-batch42-40x30mm.png');
  });
});
