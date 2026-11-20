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
