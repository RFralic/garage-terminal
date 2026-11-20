// Barcode scanning in the Logbook and the Project Tracker (public/apps/scanner.js,
// copied from the Logbook repo by scripts/import-logbook.mjs).
// Checks the code cleaning, store-barcode detection, the Bluetooth burst detector,
// and how a scanned code finds a part in the Logbook's inventory.
// Pure logic (no emulator needed), but runs with the rest via:  npm test

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const scannerSrc = readFileSync(new URL('../public/apps/scanner.js', import.meta.url), 'utf8');
const logbook = readFileSync(new URL('../apps/logbook/index.html', import.meta.url), 'utf8');
const tracker = readFileSync(new URL('../apps/job-board/index.html', import.meta.url), 'utf8');

// scanner.js with no page around it: it only sets GTScan.util.
const sandbox = {};
vm.runInNewContext(scannerSrc, sandbox);
const { clean, isRetail, formatName, makeBurst, BURST_GAP_MS } = sandbox.GTScan.util;

/** Pulls the Logbook page's own matching code out of the page and runs it. */
function logbookMatching(parts) {
  const grab = (re, what) => {
    const m = logbook.match(re);
    assert.ok(m, `couldn't find ${what} in apps/logbook/index.html; update this test`);
    return m[0];
  };
  const code = [
    grab(/const normPN=.*\n/, 'normPN'),
    grab(/function pnMatch\(a,b\)\{[\s\S]*?\}\n/, 'pnMatch'),
    grab(/const partHits=.*\n/, 'partHits'),
    grab(/const codeHit=.*\n/, 'codeHit'),
    grab(/function scanHits\(p,code\)\{[\s\S]*?return partHits\(p,code\)\}\n/, 'scanHits'),
  ].join('');
  const ctx = { window: sandbox, GTScan: sandbox.GTScan, parts };
  vm.runInNewContext(code + 'this.find=(c)=>parts.filter(p=>scanHits(p,c)).map(p=>p.id);', ctx);
  return ctx.find;
}

describe('scanned codes', () => {
  test('clean() trims and drops control characters', () => {
    assert.equal(clean('  FL-500S\r\n'), 'FL-500S');
    assert.equal(clean('\u0002024721123456\u0003'), '024721123456');
    assert.equal(clean(null), '');
  });
  test('isRetail() spots store barcodes (UPC / EAN)', () => {
    assert.ok(isRetail('024721123456')); // UPC-A
    assert.ok(isRetail('4006381333931')); // EAN-13
    assert.ok(isRetail('96385074')); // EAN-8
    assert.ok(!isRetail('492932S'));
    assert.ok(!isRetail('12345'));
    assert.ok(!isRetail('FL-500S'));
  });
  test('formatName() names the barcode type', () => {
    assert.equal(formatName('upc_a', 'x'), 'UPC');
    assert.equal(formatName('qr_code', 'x'), 'QR code');
    assert.equal(formatName('', '024721123456'), 'UPC');
    assert.equal(formatName('', '4006381333931'), 'EAN-13');
    assert.equal(formatName('', 'RJ19LM'), '');
  });
});

describe('Bluetooth scanner (keyboard mode)', () => {
  const type = (b, text, gap, start = 1000) => {
    let t = start, out = null;
    for (const k of [...text, 'Enter']) { out = b.feed(k, t); t += gap; }
    return out;
  };
  test('a fast burst ending in Enter is a scan', () => {
    assert.equal(type(makeBurst(), 'RJ19LM', 15), 'RJ19LM');
  });
  test('Tab also ends a scan', () => {
    const b = makeBurst();
    [...'492932S'].forEach((k, i) => b.feed(k, 100 + i * 10));
    assert.equal(b.feed('Tab', 170), '492932S');
  });
  test('normal typing is never a scan', () => {
    assert.equal(type(makeBurst(), 'RJ19LM', BURST_GAP_MS + 80), null);
  });
  test('fewer than 4 characters is not a scan', () => {
    assert.equal(type(makeBurst(), 'AB1', 10), null);
  });
  test('a pause before the burst is forgotten', () => {
    const b = makeBurst();
    b.feed('x', 0); // stray key long before
    assert.equal(type(b, '07-200', 10, 5000), '07-200');
  });
});

describe('a scan finds the right part', () => {
  const parts = [
    { id: 'oil', name: 'Oil filter', brand: 'Briggs & Stratton', number: '492932S' },
    { id: 'fl', name: 'Oil filter', brand: 'Motorcraft', number: 'FL-500S' },
    { id: 'plug', name: 'Spark plug', brand: 'Champion', number: 'RJ19LM', barcodes: ['037551000586'] },
    { id: 'short', name: 'Air filter', number: '21123' },
  ];
  const find = logbookMatching(parts);
  test('by part #, ignoring dashes, spaces and capitals', () => {
    assert.deepEqual(find('fl 500s'), ['fl']);
    assert.deepEqual(find('492932S'), ['oil']);
  });
  test('by a barcode saved on the part', () => {
    assert.deepEqual(find('037551000586'), ['plug']);
  });
  test('a UPC never matches a short part # it happens to contain', () => {
    assert.deepEqual(find('024721123456'), []); // contains "21123"
  });
  test('an unknown code finds nothing', () => {
    assert.deepEqual(find('ZZ-0000'), []);
  });
});

describe('the pages load the scanner', () => {
  test('both apps use /apps/scanner.js', () => {
    for (const [name, html] of [['Logbook', logbook], ['Job_Board', tracker]]) {
      assert.ok(html.includes('<script src="/apps/scanner.js"></script>'), `${name} doesn't load /apps/scanner.js`);
      assert.ok(html.includes('GTScan'), `${name} doesn't use the scanner`);
      // Part # boxes have no inline scan button: it only pasted barcode text (UPCs go on a part's barcode list instead).
      assert.ok(!/<input[^>]*(aria-label="Part #"|id="p-number"|id="pnum-|class="pn")[^>]*data-scan/.test(html), `${name} has a scan button on a Part # field`);
    }
  });
});
