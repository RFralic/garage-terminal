// Morning Brief: Home Projects upkeep reminders in the maintenance list.
// Pure logic (no emulator needed), but runs with the rest via:  npm test

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { alertKey, buildAlert, buildBrief, renderBrief, upkeepStatus } from '../src/brief/brief.js';

// Noon UTC on Sun Nov 15, 2026 (morning in New York)
const NOW = Date.UTC(2026, 10, 15, 12);
const TZ = 'America/New_York';
const r = (over) => ({ kind: 'upkeep', name: 'Furnace filter', every: 3, unit: 'months', location: 'Basement', part: '16x25x1', history: [], ...over });
const log = (...dates) => dates.map((date, i) => ({ id: `h${i}`, date, note: '' }));

describe('upkeepStatus: same rules as the Home Projects app', () => {
  test('next due is last done + interval, end-of-month safe', () => {
    assert.equal(upkeepStatus(r({ history: log('2026-08-31') }), '2026-11-15').due, '2026-11-30');
    assert.equal(upkeepStatus(r({ every: 1, unit: 'months', history: log('2026-01-31') }), '2026-02-01').due, '2026-02-28');
    assert.equal(upkeepStatus(r({ every: 2, unit: 'weeks', history: log('2026-11-01') }), '2026-11-15').due, '2026-11-15');
    assert.equal(upkeepStatus(r({ every: 1, unit: 'years', history: log('2024-02-29') }), '2025-01-01').due, '2025-02-28');
  });

  test('uses the latest logged date, whatever order the log is in', () => {
    assert.equal(upkeepStatus(r({ history: log('2026-10-01', '2026-02-01', '2026-06-01') }), '2026-11-15').last, '2026-10-01');
  });

  test('overdue, due soon (20% of the interval, 3 to 14 days) and fine', () => {
    assert.equal(upkeepStatus(r({ history: log('2026-08-01') }), '2026-11-15').state, 'over'); // due Nov 1
    assert.equal(upkeepStatus(r({ history: log('2026-08-25') }), '2026-11-15').state, 'soon'); // due Nov 25, 10 days
    assert.equal(upkeepStatus(r({ history: log('2026-09-15') }), '2026-11-15').state, 'ok'); // due Dec 15
    // monthly: window is 6 days
    assert.equal(upkeepStatus(r({ every: 1, history: log('2026-10-21') }), '2026-11-15').state, 'soon');
    assert.equal(upkeepStatus(r({ every: 1, history: log('2026-10-23') }), '2026-11-15').state, 'ok');
    // weekly: window is at least 3 days
    assert.equal(upkeepStatus(r({ every: 1, unit: 'weeks', history: log('2026-11-11') }), '2026-11-15').state, 'soon');
  });

  test('never logged gives no status', () => {
    assert.equal(upkeepStatus(r(), '2026-11-15'), null);
  });
});

describe('Maintenance list in the brief and the alerts', () => {
  const upkeep = [
    r({ id: 'a', history: log('2026-08-01') }), // overdue
    r({ id: 'b', name: 'Smoke alarm batteries', every: 1, unit: 'years', location: '', part: '9V', history: log('2025-11-20') }), // due in 5 days
    r({ id: 'c', name: 'Fridge water filter', every: 6, history: log('2026-10-01') }), // fine
    r({ id: 'd', name: 'Gutters' }), // never logged
    { id: 'p', kind: 'room', name: 'Kitchen', tasks: [] }, // not a reminder
  ];

  test('includes due and overdue reminders only, overdue first', () => {
    const items = buildAlert({ upkeep, nowMs: NOW, tz: TZ }).sections.maintenance;
    assert.deepEqual(items.map((m) => [m.machine, m.item, m.state]), [
      ['Basement', 'Furnace filter', 'over'],
      ['Home', 'Smoke alarm batteries', 'soon'],
    ]);
    assert.match(items[0].detail, /^14 days overdue · Sun, Nov 1 · 16x25x1$/);
    assert.match(items[1].detail, /^due in 5 days · Fri, Nov 20 · 9V$/);
  });

  test('the daily brief shows them in its Maintenance section too', () => {
    const brief = buildBrief({ upkeep, nowMs: NOW, tz: TZ });
    assert.equal(brief.sections.maintenance.length, 2);
    assert.match(brief.summary, /2 services due/);
  });

  test('a change in what is due changes the alert key (so a new alert goes out)', () => {
    const before = alertKey(buildAlert({ upkeep, nowMs: NOW, tz: TZ }));
    const done = upkeep.map((x) => (x.id === 'a' ? { ...x, history: [...x.history, { id: 'n', date: '2026-11-15', note: '' }] } : x));
    assert.notEqual(alertKey(buildAlert({ upkeep: done, nowMs: NOW, tz: TZ })), before);
  });

  test('the email names them and links to Home Projects', () => {
    const mail = renderBrief(buildAlert({ upkeep, nowMs: NOW, tz: TZ }), { siteUrl: 'https://example.test' });
    assert.match(mail.subject, /^Maintenance due · 2 items: Basement furnace filter, Home smoke alarm batteries$/);
    assert.match(mail.html, /Basement: Furnace filter/);
    assert.match(mail.html, /example\.test\/apps\/home-projects/);
    assert.match(mail.text, /Home: Smoke alarm batteries, due in 5 days/);
  });

  test('Logbook-only members see no change', () => {
    const mail = renderBrief(buildAlert({ records: [], nowMs: NOW, tz: TZ }));
    assert.doesNotMatch(mail.html, /apps\/home-projects/);
  });
});
