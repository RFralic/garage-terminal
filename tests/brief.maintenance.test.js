// Morning Brief: the Logbook's maintenance-due rules.
// The brief keeps a word-for-word copy of the Logbook's "due rules" block, so
// the email and the app always agree. These tests check that the copy matches
// the Logbook page (apps/logbook/index.html) and that the brief lists the
// right services. Pure logic (no emulator needed), but runs with the rest via:  npm test

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildAlert, buildBrief, dueList, renderBrief } from '../src/brief/brief.js';

const page = readFileSync(new URL('../apps/logbook/index.html', import.meta.url), 'utf8');
const briefSrc = readFileSync(new URL('../src/brief/brief.js', import.meta.url), 'utf8');
const START = '/* ---- due rules: start ----';
const END = '/* ---- due rules: end ---- */';
const blockOf = (src, where) => {
  const i = src.indexOf(START);
  const j = src.indexOf(END);
  assert.ok(i >= 0 && j > i, `no "due rules" block in ${where}`);
  return src.slice(i, j + END.length);
};

// Noon UTC on Sun Nov 15, 2026 (morning in New York)
const NOW = Date.UTC(2026, 10, 15, 12);
const TZ = 'America/New_York';
const TODAY = '2026-11-15';
const entry = (date, hours, ...tasks) => ({ id: `${date}-${tasks[0]}`, date, hours, cost: '', tasks, notes: '' });
const RECORDS = [
  { id: 'v1', kind: 'vehicle', name: 'Work truck', hours: '86,240', oilInterval: '5000',
    log: [entry('2026-06-02', '80,000', 'Oil & filter'), entry('2026-08-30', '79,140', 'Tire rotation', 'Brakes'), entry('2026-03-11', '76,800', 'Air filter')] },
  { id: 'e1', kind: 'engine', name: 'Back yard mower', hours: '46',
    log: [entry('2026-09-16', '0', 'Oil change'), entry('2025-10-01', '', 'Spark plug')] },
  { id: 'e2', kind: 'engine', name: 'Generator', hours: '60',
    schedule: [
      { id: 'run', task: 'Run it / exercise', every: '', months: '3', warnMeter: '5', warnDays: '14', part: '', brief: true },
      { id: 'oil', task: 'Oil change', every: '50', months: '', warnMeter: '5', warnDays: '14', part: '', brief: false },
      { id: 'fuel', task: 'Fuel filter', every: '', months: '1', warnMeter: '5', warnDays: '14', part: '', brief: true, snooze: '2026-11-20' },
    ],
    log: [entry('2026-08-25', '', 'Run it / exercise'), entry('2026-08-01', '0', 'Oil change'), entry('2026-09-01', '', 'Fuel filter')] },
  { id: 'p1', kind: 'part', name: 'Oil filter', number: 'FL-500S', qty: '3', reorderAt: '1' },
];

describe('the due rules are the Logbook\'s own', () => {
  test('brief.js has an exact copy of the Logbook page\'s block', () => {
    assert.equal(blockOf(briefSrc, 'src/brief/brief.js'), blockOf(page, 'apps/logbook/index.html'),
      'The due rules differ. Copy the block from apps/logbook/index.html into src/brief/brief.js.');
  });

  test('and gives the same answers as the page\'s copy run with the page\'s own helpers', () => {
    const helper = (name) => {
      const m = page.match(new RegExp(`^const ${name}=.*$`, 'm'));
      assert.ok(m, `helper ${name} not found in the Logbook page`);
      return m[0];
    };
    const ctx = vm.createContext({});
    vm.runInContext(`${['milesN', 'fmtMi', 'sortedLog'].map(helper).join('\n')}\n${blockOf(page, 'the page')}\nthis.dueList=dueList;`, ctx);
    const pick = (d) => ({ task: d.task, state: d.state, text: d.text, short: d.short, upcoming: d.upcoming, snoozed: d.snoozed, brief: d.brief });
    for (const e of RECORDS.filter((r) => r.kind !== 'part')) {
      assert.deepEqual(JSON.parse(JSON.stringify(ctx.dueList(e, TODAY).map(pick))), dueList(e, TODAY).map(pick), e.name); // JSON: plain objects from the sandbox
    }
  });
});

describe('due rules', () => {
  const by = (e) => Object.fromEntries(dueList(e, TODAY).map((d) => [d.task, d]));

  test('vehicle: mileage from the last log entry, oil interval from the spec', () => {
    const d = by(RECORDS[0]);
    assert.equal(d['Oil & filter'].state, 'over');
    assert.equal(d['Oil & filter'].text, '1,240 mi overdue · was due at 85,000 mi');
    assert.equal(d['Tire rotation'].state, 'soon');
    assert.equal(d['Tire rotation'].text, 'Due in 400 mi · at 86,640 mi');
    assert.equal(d.Brakes.state, 'ok');
    assert.equal(d.Brakes.upcoming, true); // 71% of its miles used
    assert.equal(d['Air filter'].upcoming, false); // ~4 months away, 63% of its miles
    const shorter = by({ ...RECORDS[0], oilInterval: '3000' })['Oil & filter'];
    assert.equal(shorter.text, '3,240 mi overdue · was due at 83,000 mi');
  });

  test('small engine: hours, months, never logged', () => {
    const d = by(RECORDS[1]);
    assert.equal(d['Oil change'].text, 'Due in 4 h · at 50 h');
    assert.equal(d['Spark plug'].state, 'over'); // no hours logged: 12 months decides
    assert.equal(d['Spark plug'].text, '6 weeks overdue · was due Oct 1, 2026');
    assert.equal(d['Air filter'].state, 'none');
  });

  test('saved schedule: months only, snooze, left out of the brief', () => {
    const d = by(RECORDS[2]);
    assert.equal(d['Run it / exercise'].text, 'Due Nov 25, 2026 · in 10 days');
    assert.equal(d['Oil change'].brief, false);
    assert.equal(d['Fuel filter'].state, 'over');
    assert.equal(d['Fuel filter'].snoozed, true);
    assert.equal(dueList(RECORDS[2], '2026-11-20').find((x) => x.task === 'Fuel filter').snoozed, true); // through that day
    assert.equal(dueList(RECORDS[2], '2026-11-21').find((x) => x.task === 'Fuel filter').snoozed, false);
  });

  test('months are end-of-month safe', () => {
    const e = { kind: 'engine', schedule: [{ id: 'x', task: 'Belt', months: '1' }], log: [entry('2026-01-31', '', 'Belt')] };
    assert.equal(dueList(e, '2026-02-10')[0].t.due, '2026-02-28');
  });
});

describe('the brief\'s maintenance list', () => {
  const items = buildBrief({ records: RECORDS, nowMs: NOW, tz: TZ }).sections.maintenance;

  test('overdue first, then due soon; snoozed and unticked services left out', () => {
    assert.deepEqual(items.map((m) => `${m.state} ${m.machine}: ${m.item}`), [
      'over Back yard mower: Spark plug',
      'over Work truck: Oil & filter',
      'soon Back yard mower: Oil change',
      'soon Generator: Run it / exercise',
      'soon Work truck: Tire rotation',
    ]);
    assert.equal(items[1].detail, '1,240 mi overdue · was due at 85,000 mi');
  });

  test('the email shows the same words as the app', () => {
    const { html, text } = renderBrief(buildBrief({ records: RECORDS, nowMs: NOW, tz: TZ }));
    assert.match(text, /Work truck: Oil & filter, 1,240 mi overdue · was due at 85,000 mi/);
    assert.match(text, /Generator: Run it \/ exercise, Due Nov 25, 2026 · in 10 days/);
    assert.match(html, />Overdue</);
    assert.doesNotMatch(html, />Check</);
  });

  test('maintenance alert uses the same list', () => {
    const alert = buildAlert({ records: RECORDS, nowMs: NOW, tz: TZ });
    assert.equal(alert.sections.maintenance.length, 5);
    assert.match(alert.summary, /^5 items: Back yard mower spark plug, Work truck oil & filter and 3 more$/);
  });

  test("customer machines (Shop mode) are never in the brief", () => {
    const theirs = { ...RECORDS[0], id: 'c1', name: "Cory's truck", owner: { id: 'cu1', name: 'Cory' } };
    const got = buildBrief({ records: [...RECORDS, theirs], nowMs: NOW, tz: TZ }).sections.maintenance;
    assert.equal(got.length, 5);
    assert.ok(!got.some((m) => /Cory/.test(m.machine)));
  });

  test('nothing due when everything is on schedule', () => {
    const fresh = { id: 'v2', kind: 'vehicle', name: 'Car', hours: '10,000', log: [entry('2026-11-01', '10,000', 'Oil & filter', 'Tire rotation', 'Air filter', 'Brakes')] };
    assert.deepEqual(buildBrief({ records: [fresh], nowMs: NOW, tz: TZ }).sections.maintenance, []);
  });
});
