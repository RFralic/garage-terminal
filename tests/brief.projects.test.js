// Morning Brief: the "Open projects and jobs" section and its customer jobs option.
// Pure logic (no emulator needed), but runs with the rest via:  npm test

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECTIONS, buildBrief, renderBrief } from '../src/brief/brief.js';

const NOW = Date.UTC(2026, 10, 20, 12);
const TZ = 'America/New_York';
const projects = [
  { title: 'Ford 8N tune up', kind: 'mine', status: 'In progress', tasks: [] },
  { title: 'Craftsman mower', kind: 'customer', status: 'Waiting on parts', tasks: [], customer: { promised: '2026-11-22' } },
  { title: 'Snow blower', kind: 'mine', status: 'Done', tasks: [] },
];
const titles = (sections) => buildBrief({ projects, nowMs: NOW, tz: TZ, sections }).sections.projects.map((p) => p.title);

describe('Morning Brief: Job_Board customer jobs', () => {
  test('included by default', () => {
    assert.equal(DEFAULT_SECTIONS.customerJobs, true);
    assert.deepEqual(titles(undefined).sort(), ['Craftsman mower', 'Ford 8N tune up']);
    assert.deepEqual(titles({ projects: true }).sort(), ['Craftsman mower', 'Ford 8N tune up']);
  });

  test('left out when the option is off; your own projects stay', () => {
    assert.deepEqual(titles({ ...DEFAULT_SECTIONS, customerJobs: false }), ['Ford 8N tune up']);
  });

  test('the option is not a heading of its own', () => {
    const brief = buildBrief({ projects, nowMs: NOW, tz: TZ, sections: { ...DEFAULT_SECTIONS, customerJobs: false } });
    const { html, text } = renderBrief(brief, { siteUrl: 'https://example.com' });
    assert.ok(!/customer jobs/i.test(text));
    assert.ok(!/customerJobs/.test(html));
    assert.match(text, /Ford 8N tune up/);
  });
});

describe('Morning Brief: job parts (not on a task)', () => {
  test('count toward parts to order with task parts', () => {
    const ps = [{ title: 'Cory mower', kind: 'customer', status: 'In progress',
      parts: [{ name: 'Air filter', status: 'To order' }, { name: 'Oil', status: 'In stock' }],
      tasks: [{ title: 'Belt', parts: [{ name: 'Belt', status: 'To order' }] }] }];
    const [p] = buildBrief({ projects: ps, nowMs: NOW, tz: TZ, sections: { projects: true } }).sections.projects;
    assert.match(JSON.stringify(p), /2 parts to order/);
  });
});

describe('Morning Brief: parts marked ordered', () => {
  const recs = [
    { kind: 'part', name: 'Oil filter', number: '52 050 02', qty: '0', reorderAt: '1' },
    { kind: 'part', name: 'Spark plug', number: 'BKR5E', qty: '1', reorderAt: '1', order: { on: '2026-11-18', qty: 2, expected: '2026-11-25' } },
    { kind: 'part', name: 'Belt', number: 'A-1', qty: '0', reorderAt: '1', order: { on: '2026-11-10', qty: 1, expected: '2026-11-15' } },
  ];
  const brief = buildBrief({ records: recs, nowMs: NOW, tz: TZ, sections: { lowStock: true } });
  const by = Object.fromEntries(brief.sections.lowStock.map((p) => [p.name, p]));
  test('ordered parts carry their dates; late when the expected date has passed', () => {
    assert.equal(by['Oil filter'].ordered, undefined);
    assert.equal(by['Spark plug'].ordered, '2026-11-18');
    assert.equal(by['Spark plug'].late, false);
    assert.equal(by['Belt'].late, true);
  });
  test('the email says Ordered / Late instead of Low', () => {
    const { html, text } = renderBrief(brief, { siteUrl: 'https://example.com' });
    assert.match(text, /Spark plug #BKR5E: 1 on hand \(reorder at 1\), ordered 11\/18, expected 11\/25/);
    assert.match(text, /Belt #A-1: .*late: expected 11\/15/);
    assert.match(html, />Ordered</);
    assert.match(html, />Late</);
    assert.match(html, />Out</);
  });
});
