// Morning Brief: the Pantry sections (expiring soon, shopping list), built
// with the Pantry's own rules (src/pantry/logic.js) so the email and the app agree.
// Pure logic (no emulator needed), but runs with the rest via:  npm test

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlert, buildBrief, renderBrief, SECTIONS } from '../src/brief/brief.js';

// Noon UTC on Mon Nov 16, 2026 (morning in New York)
const NOW = Date.UTC(2026, 10, 16, 12);
const TZ = 'America/New_York';
const item = (name, lots, extra = {}) => ({ name, lots, location: 'Pantry', ...extra });
const home = {
  name: 'Fralic household',
  items: [
    item('Whole milk', [{ qty: 1, expires: '2026-11-18' }], { location: 'Fridge', keepAtLeast: 2 }),
    item('Greek yogurt', [{ qty: 2, expires: '2026-11-14' }], { location: 'Fridge' }),
    item('Black beans', [{ qty: 2, expires: '2026-11-20' }, { qty: 4, expires: '2028-03-01' }]),
    item('Rice', [{ qty: 3, expires: '2027-06-01' }]),
    item('Paper towels', [{ qty: 2, expires: '' }], { location: 'Supplies', keepAtLeast: 6, size: '6 pk' }),
    item('Old soup', [{ qty: 0, expires: '2026-11-01' }]),
  ],
  shopping: [{ name: 'Bananas', who: 'Jess', done: false }, { name: 'Bread', who: 'Ryan', done: true }],
};
const build = (extra = {}) => buildBrief({ pantries: [home], nowMs: NOW, tz: TZ, ...extra });

describe('Morning Brief: Pantry sections', () => {
  test('expiring soon: within 7 days or already expired, soonest first; nothing left = left out', () => {
    const rows = build().sections.pantryExpiring;
    assert.deepEqual(rows.map((r) => r.name), ['Greek yogurt', 'Whole milk', 'Black beans']);
    assert.equal(rows[0].expired, true);
    assert.match(rows[0].detail, /expired Sat, Nov 14/);
    assert.match(rows[1].detail, /^1 · Fridge · expires Wed, Nov 18/);
    assert.match(rows[2].detail, /^2 of 6 · Pantry · expires Fri, Nov 20/); // only the lot that's expiring
  });

  test('shopping list: running low (buy the difference) plus things added by hand', () => {
    const rows = build().sections.pantryShopping;
    assert.deepEqual(rows.map((r) => [r.name, r.buy]), [['Paper towels', 4], ['Whole milk', 1], ['Bananas', 0]]);
    assert.match(rows[0].detail, /have 2 · keep 6 · 6 pk/);
    assert.match(rows[2].detail, /added by Jess/);
  });

  test('summary and email', () => {
    const b = build();
    assert.match(b.summary, /3 expiring · 3 to buy/);
    const { html, text, subject } = renderBrief(b);
    assert.match(subject, /3 expiring · 3 to buy/);
    assert.ok(html.includes(SECTIONS.pantryExpiring) && html.includes(SECTIONS.pantryShopping));
    assert.ok(html.includes('/apps/pantry'));
    assert.ok(html.includes('Expired') && html.includes('buy 4'));
    assert.match(text, /PANTRY: SHOPPING LIST\n- Paper towels: buy 4/);
    assert.match(text, /Greek yogurt: .*\(EXPIRED\)/);
  });

  test('more than one pantry: each line says which', () => {
    const camp = { name: 'Camp', items: [item('Propane', [{ qty: 0, expires: '' }], { keepAtLeast: 2 })], shopping: [] };
    const rows = build({ pantries: [home, camp] }).sections.pantryShopping;
    assert.match(rows.find((r) => r.name === 'Propane').detail, /^Camp · have 0 · keep 2/);
    assert.match(rows.find((r) => r.name === 'Bananas').detail, /^Fralic household · added by Jess/);
  });

  test('not in a pantry, or the sections turned off: no Pantry sections at all', () => {
    for (const b of [buildBrief({ nowMs: NOW, tz: TZ }), build({ sections: { pantryExpiring: false, pantryShopping: false } })]) {
      assert.equal(b.sections.pantryExpiring, undefined);
      assert.equal(b.sections.pantryShopping, undefined);
      assert.ok(!renderBrief(b).html.includes('/apps/pantry'));
    }
  });

  test('nothing to report still shows the section, briefly', () => {
    const quiet = { name: 'Home', items: [item('Rice', [{ qty: 3, expires: '2027-06-01' }])], shopping: [] };
    const b = build({ pantries: [quiet] });
    assert.deepEqual(b.sections.pantryExpiring, []);
    assert.ok(renderBrief(b).text.includes('Nothing expiring in the next 7 days.'));
    assert.ok(renderBrief(b).text.includes('Nothing to buy.'));
  });

  test('long lists stop at 25, with a count of the rest', () => {
    const many = { name: 'Big', items: Array.from({ length: 30 }, (_, i) => item(`Can ${String(i).padStart(2, '0')}`, [{ qty: 1, expires: '2026-11-17' }])), shopping: [] };
    const b = build({ pantries: [many] });
    assert.equal(b.sections.pantryExpiring.length, 25);
    assert.ok(renderBrief(b).html.includes('and 5 more in the Pantry'));
    assert.match(b.summary, /30 expiring/);
  });

  test('"Only maintenance alerts" never includes the Pantry', () => {
    const a = buildAlert({ nowMs: NOW, tz: TZ });
    assert.equal(a.sections.pantryExpiring, undefined);
  });
});
