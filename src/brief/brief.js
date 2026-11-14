// brief.js: builds the Morning Brief email from a member's own data. No
// libraries; used by the settings page (preview) and by the sender
// (scripts/send-briefs.mjs), so both show exactly the same thing.
//
//   buildBrief({ records, projects, events, nowMs, tz, sections, calendar })
//     -> a plain object with each section's lines
//   renderBrief(brief) -> { subject, html, text }
//
// The maintenance and low-stock rules are the Logbook's own
// (apps/logbook/index.html), so the brief agrees with the app:
//   - parts: low when a reorder level is set and on hand <= it
//   - vehicles: next oil change = last "Oil & filter" mileage + interval
//     (default 5,000); "soon" within 500 miles, "overdue" past it
//   - the watched services (oil, plugs, filters, tires, brakes): flagged when
//     last logged more than 12 months ago

import { dateKey, daysBetween, fmtLongDate, fmtShortDate, fmtTime } from './time.js';

export const SECTIONS = {
  today: "Today's schedule",
  upcoming: 'Coming up (next 14 days)',
  lowStock: 'Garage: running low',
  maintenance: 'Maintenance',
  projects: 'Open projects and jobs',
};
export const DEFAULT_SECTIONS = Object.fromEntries(Object.keys(SECTIONS).map((k) => [k, true]));

// ---------- the Logbook's own rules ---------------------------------------------------

const WATCH = {
  engine: ['Oil change', 'Spark plug', 'Air filter', 'Fuel filter'],
  vehicle: ['Oil & filter', 'Tire rotation', 'Air filter', 'Brakes'],
};
const kindOf = (e) => (e && e.kind === 'vehicle' ? 'vehicle' : e && e.kind === 'part' ? 'part' : 'engine');
const milesN = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isNaN(n) ? null : n; };
const fmtMi = (n) => `${Math.round(n).toLocaleString('en-US')} mi`;
const qtyN = (p) => { const n = parseInt(p.qty, 10); return Number.isNaN(n) ? 0 : n; };
const isLow = (p) => p.reorderAt !== '' && p.reorderAt != null && !Number.isNaN(parseInt(p.reorderAt, 10)) && qtyN(p) <= parseInt(p.reorderAt, 10);
const sortedLog = (e) => [...(Array.isArray(e.log) ? e.log : [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
const lastFor = (e, task) => sortedLog(e).find((l) => (l.tasks || []).includes(task));

function machineName(e) {
  if (String(e.name || '').trim()) return e.name.trim();
  const mm = (kindOf(e) === 'vehicle' ? [e.year, e.make, e.model] : [e.make, e.model])
    .map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  return mm || (kindOf(e) !== 'vehicle' && e.equipment) || `Unnamed ${kindOf(e)}`;
}

function nextOil(e) {
  if (kindOf(e) !== 'vehicle') return null;
  const oil = sortedLog(e).find((l) => (l.tasks || []).includes('Oil & filter') && milesN(l.hours) != null);
  if (!oil) return null;
  const every = milesN(e.oilInterval) || 5000;
  const at = milesN(oil.hours) + every;
  const cur = milesN(e.hours);
  const left = cur == null ? null : at - cur;
  return { at, cur, left, every, state: left == null ? 'ok' : left < 0 ? 'over' : left <= 500 ? 'soon' : 'ok' };
}

// ---------- building -----------------------------------------------------------------

/**
 * records: Logbook records (engines, vehicles, parts), each {id, ...data}
 * projects: Project Tracker projects, each {id, ...data}
 * events: calendar events from eventsInWindow (or null when no calendar)
 * calendar: 'none' | 'ok' | 'error'
 */
export function buildBrief({ records = [], projects = [], events = null, nowMs = Date.now(), tz = 'UTC', sections = DEFAULT_SECTIONS, calendar = 'none' }) {
  const on = { ...DEFAULT_SECTIONS, ...(sections || {}) };
  const today = dateKey(nowMs, tz);
  const brief = { today, dateLabel: fmtLongDate(today), tz, on, calendar, sections: {} };

  if (on.today || on.upcoming) {
    const evs = events || [];
    if (on.today) {
      brief.sections.today = evs
        .filter((e) => dateKey(e.startMs, tz) <= today && (e.allDay ? dateKey(e.endMs - 1, tz) : dateKey(Math.max(e.endMs - 1, e.startMs), tz)) >= today)
        .map((e) => ({
          when: e.allDay ? 'All day' : dateKey(e.startMs, tz) < today ? 'Continues' : fmtTime(e.startMs, tz),
          title: e.title,
          detail: e.location,
        }));
    }
    if (on.upcoming) {
      brief.sections.upcoming = evs
        .filter((e) => dateKey(e.startMs, tz) > today)
        .slice(0, 10)
        .map((e) => {
          const key = dateKey(e.startMs, tz);
          const n = daysBetween(today, key);
          return {
            title: e.title,
            when: `${fmtShortDate(key)}${e.allDay ? '' : ` · ${fmtTime(e.startMs, tz)}`}`,
            detail: n === 1 ? 'tomorrow' : `in ${n} days`,
          };
        });
    }
  }

  if (on.lowStock) {
    brief.sections.lowStock = records
      .filter((r) => kindOf(r) === 'part' && isLow(r))
      .sort((a, b) => qtyN(a) - qtyN(b) || String(a.name || '').localeCompare(String(b.name || '')))
      .map((p) => ({
        name: [p.brand, p.name].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || 'Unnamed part',
        number: String(p.number || '').trim(),
        qty: qtyN(p),
        reorderAt: parseInt(p.reorderAt, 10),
        out: qtyN(p) <= 0,
        location: String(p.location || '').trim(),
      }));
  }

  if (on.maintenance) {
    const items = [];
    for (const e of records.filter((r) => kindOf(r) !== 'part')) {
      const name = machineName(e);
      const oil = nextOil(e);
      if (oil && oil.state !== 'ok') {
        items.push({
          machine: name,
          item: 'Oil & filter change',
          detail: oil.left < 0
            ? `${fmtMi(-oil.left)} overdue · due at ${fmtMi(oil.at)}`
            : `${fmtMi(oil.left)} to go · due at ${fmtMi(oil.at)}`,
          state: oil.state,
          rank: oil.state === 'over' ? 0 : 1,
        });
      }
      for (const task of WATCH[kindOf(e)]) {
        if (task === 'Oil & filter' && oil) continue; // covered by the mileage check
        const last = lastFor(e, task);
        if (!last || !last.date) continue;
        const ago = daysBetween(String(last.date).slice(0, 10), today);
        if (ago > 365) {
          items.push({ machine: name, item: task, detail: `last logged ${Math.floor(ago / 30.4)} months ago`, state: 'old', rank: 2 });
        }
      }
    }
    brief.sections.maintenance = items.sort((a, b) => a.rank - b.rank || a.machine.localeCompare(b.machine));
  }

  if (on.projects) {
    brief.sections.projects = projects
      .filter((p) => p && p.status !== 'Done')
      .map((p) => {
        const tasks = Array.isArray(p.tasks) ? p.tasks : [];
        const toOrder = tasks.flatMap((t) => (Array.isArray(t.parts) ? t.parts : [])).filter((x) => x && x.status === 'To order').length;
        const done = tasks.filter((t) => t && t.done).length;
        const promised = p.kind === 'customer' && p.customer && p.customer.promised ? String(p.customer.promised).slice(0, 10) : '';
        const bits = [p.status || 'Not started'];
        if (tasks.length) bits.push(`${done}/${tasks.length} tasks`);
        if (toOrder) bits.push(`${toOrder} part${toOrder === 1 ? '' : 's'} to order`);
        if (promised) bits.push(`promised ${fmtShortDate(promised)}`);
        return {
          title: String(p.title || '').trim() || 'Untitled project',
          detail: bits.join(' · '),
          urgent: !!promised && promised <= today,
          promised,
        };
      })
      .sort((a, b) => (b.urgent - a.urgent) || (a.promised || '9').localeCompare(b.promised || '9') || a.title.localeCompare(b.title));
  }

  const s = brief.sections;
  const bits = [];
  if (s.today) bits.push(`${s.today.length} event${s.today.length === 1 ? '' : 's'} today`);
  if (s.lowStock && s.lowStock.length) bits.push(`${s.lowStock.length} running low`);
  if (s.maintenance && s.maintenance.length) bits.push(`${s.maintenance.length} service${s.maintenance.length === 1 ? '' : 's'} due`);
  if (s.projects && s.projects.length) bits.push(`${s.projects.length} open project${s.projects.length === 1 ? '' : 's'}`);
  brief.summary = bits.join(' · ');
  return brief;
}

// ---------- the email --------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const C = { bg: '#eef0f3', card: '#ffffff', ink: '#1a1d23', muted: '#5b6472', line: '#e3e6ea', head: '#16202e', accent: '#1d4ed8', soon: '#92400e', soonBg: '#fef3c7', over: '#991b1b', overBg: '#fee2e2', okBg: '#f5f7fa' };
const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;";

function pill(text, kind) {
  const [fg, bg] = kind === 'over' ? [C.over, C.overBg] : [C.soon, C.soonBg];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:600">${esc(text)}</span>`;
}

function section(title, rowsHtml, empty) {
  return `<tr><td style="padding:24px 28px 4px">
<h2 style="margin:0 0 10px;${FONT}font-size:18px;color:${C.ink}">${esc(title)}</h2>
${rowsHtml || `<p style="margin:0;${FONT}font-size:14px;color:${C.muted}">${esc(empty)}</p>`}
</td></tr>`;
}

function rows(items, render) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${items.map(render).join('')}</table>`;
}

const row = (left, main, sub, right = '') => `<tr><td style="padding:10px 0;border-top:1px solid ${C.line};${FONT}vertical-align:top">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${left ? `<td width="86" style="${FONT}font-size:14px;font-weight:600;color:${C.accent};vertical-align:top">${esc(left)}</td>` : ''}
<td style="${FONT}vertical-align:top"><div style="font-size:15px;font-weight:600;color:${C.ink}">${esc(main)}</div>${sub ? `<div style="font-size:13px;color:${C.muted};margin-top:2px">${esc(sub)}</div>` : ''}</td>
${right ? `<td align="right" style="${FONT}vertical-align:top;white-space:nowrap">${right}</td>` : ''}
</tr></table></td></tr>`;

export function renderBrief(brief, { siteUrl = 'https://garage-terminal-15499.web.app' } = {}) {
  const s = brief.sections;
  const parts = [];
  const calNote = brief.calendar === 'none'
    ? 'No calendar connected. Add one in your Morning Brief settings.'
    : brief.calendar === 'error' ? "Your calendar couldn't be read this morning." : null;

  if (s.today) {
    parts.push(section(SECTIONS.today, s.today.length ? rows(s.today, (e) => row(e.when, e.title, e.detail)) : '', calNote || 'Nothing on the calendar today.'));
  }
  if (s.upcoming) {
    parts.push(section(SECTIONS.upcoming, s.upcoming.length ? rows(s.upcoming, (e) => row('', e.title, `${e.when} · ${e.detail}`)) : '', calNote || 'Nothing in the next two weeks.'));
  }
  if (s.lowStock) {
    parts.push(section(SECTIONS.lowStock, s.lowStock.length ? rows(s.lowStock, (p) => row('', p.name,
      [p.number && `#${p.number}`, `${p.qty} on hand · reorder at ${p.reorderAt}`, p.location].filter(Boolean).join(' · '),
      pill(p.out ? 'Out' : 'Low', p.out ? 'over' : 'soon'))) : '', 'Nothing below its reorder level.'));
  }
  if (s.maintenance) {
    parts.push(section(SECTIONS.maintenance, s.maintenance.length ? rows(s.maintenance, (m) => row('', `${m.machine}: ${m.item}`, m.detail,
      pill(m.state === 'over' ? 'Overdue' : m.state === 'soon' ? 'Due soon' : 'Check', m.state === 'over' ? 'over' : 'soon'))) : '', 'Everything is on schedule.'));
  }
  if (s.projects) {
    parts.push(section(SECTIONS.projects, s.projects.length ? rows(s.projects, (p) => row('', p.title, p.detail, p.urgent ? pill('Due', 'over') : '')) : '', 'No open projects.'));
  }

  const subject = `Morning Brief · ${fmtShortDate(brief.today)}${brief.summary ? ` · ${brief.summary}` : ''}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border-radius:12px;overflow:hidden">
<tr><td style="background:${C.head};padding:28px 28px 24px;${FONT}">
<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#b9c3d1">${esc(brief.dateLabel)}</div>
<div style="margin-top:6px;font-size:30px;font-weight:700;color:#ffffff">Morning Brief</div>
${brief.summary ? `<div style="margin-top:8px;font-size:15px;color:#d6dce5">${esc(brief.summary)}</div>` : ''}
</td></tr>
${parts.join('\n')}
<tr><td style="padding:24px 28px 28px;${FONT}font-size:12px;color:${C.muted};line-height:1.6">
From your Garage Terminal Logbook, Project Tracker and calendar.<br>
<a href="${esc(siteUrl)}/apps/logbook" style="color:${C.accent}">Open the Logbook</a> · <a href="${esc(siteUrl)}/apps/morning-brief" style="color:${C.accent}">Change or stop this email</a>
</td></tr>
</table></td></tr></table></body></html>`;

  const lines = [`MORNING BRIEF · ${brief.dateLabel}`, brief.summary, ''];
  const add = (title, items, fmt, empty) => {
    lines.push(title.toUpperCase());
    if (items.length) items.forEach((x) => lines.push(`- ${fmt(x)}`)); else lines.push(empty);
    lines.push('');
  };
  if (s.today) add(SECTIONS.today, s.today, (e) => `${e.when}  ${e.title}${e.detail ? ` (${e.detail})` : ''}`, calNote || 'Nothing on the calendar today.');
  if (s.upcoming) add(SECTIONS.upcoming, s.upcoming, (e) => `${e.title}: ${e.when}, ${e.detail}`, calNote || 'Nothing in the next two weeks.');
  if (s.lowStock) add(SECTIONS.lowStock, s.lowStock, (p) => `${p.name}${p.number ? ` #${p.number}` : ''}: ${p.qty} on hand (reorder at ${p.reorderAt})`, 'Nothing below its reorder level.');
  if (s.maintenance) add(SECTIONS.maintenance, s.maintenance, (m) => `${m.machine}: ${m.item}, ${m.detail}`, 'Everything is on schedule.');
  if (s.projects) add(SECTIONS.projects, s.projects, (p) => `${p.title}: ${p.detail}`, 'No open projects.');
  lines.push(`Change or stop this email: ${siteUrl}/apps/morning-brief`);
  return { subject, html, text: lines.join('\n') };
}
