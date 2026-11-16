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
//   - maintenance: each machine's tracked services (its Schedule & log tab).
//     Due = the last log entry with that service + its interval (miles or
//     engine hours, and/or months, whichever comes first); "soon" within the
//     service's warning distance. The rules are an exact copy of the Logbook's
//     "due rules" block (below); tests/brief.maintenance.test.js checks that
//     the two copies match. Services that are snoozed, never logged, or have
//     "Include in the Morning Brief email" unticked are left out.
//
// Home Projects upkeep reminders (homeprojects/{uid}/projects, kind "upkeep")
// follow Home Projects' own rules (apps/home-projects/index.html):
//   - next due = last done + every × unit (days, weeks, months, years)
//   - "soon" within 20% of the interval (at least 3, at most 14 days),
//     "overdue" past the due date; never-logged reminders aren't included

import { dateKey, daysBetween, fmtLongDate, fmtShortDate, fmtTime } from './time.js';

export const SECTIONS = {
  today: 'Calendar: today (weekly: this week)',
  upcoming: 'Calendar: coming up',
  lowStock: 'Garage: running low',
  maintenance: 'Maintenance',
  projects: 'Open projects and jobs',
};
export const DEFAULT_SECTIONS = Object.fromEntries(Object.keys(SECTIONS).map((k) => [k, true]));
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Section headings in the email, which depend on daily or weekly. */
function heading(brief, key) {
  if (key === 'today') return brief.weekly ? 'This week' : "Today's schedule";
  if (key === 'upcoming') return brief.weekly ? 'Coming up (the week after)' : 'Coming up (next 14 days)';
  return SECTIONS[key];
}

/** "YYYY-MM-DD" plus n days. */
function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

// ---------- the Logbook's own rules ---------------------------------------------------

const kindOf = (e) => (e && e.kind === 'vehicle' ? 'vehicle' : e && e.kind === 'part' ? 'part' : 'engine');
const milesN = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isNaN(n) ? null : n; };
const fmtMi = (n) => `${Math.round(n).toLocaleString('en-US')} mi`;
const qtyN = (p) => { const n = parseInt(p.qty, 10); return Number.isNaN(n) ? 0 : n; };
const isLow = (p) => p.reorderAt !== '' && p.reorderAt != null && !Number.isNaN(parseInt(p.reorderAt, 10)) && qtyN(p) <= parseInt(p.reorderAt, 10);
const sortedLog = (e) => [...(Array.isArray(e.log) ? e.log : [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

// Copied word for word from the Logbook (vehicle_logbook/public/index.html).
// Don't edit here: change the Logbook, re-run scripts/import-logbook.mjs, then
// paste the new block (tests/brief.maintenance.test.js fails until they match).
/* ---- due rules: start ----
   Maintenance due. Garage Terminal's Morning Brief (garage-terminal/src/brief/brief.js) keeps an
   exact copy of this block so the email and the app always agree: change both together (a test
   there checks they match). Uses milesN, sortedLog and fmtMi from the page.
   A machine's schedule is e.schedule = [{id, task, every, months, warnMeter, warnDays, part, brief, snooze}]:
     every: miles (vehicles) or engine hours (small engines) · months: calendar months · either may be blank
     warnMeter / warnDays: "due soon" this close · brief: false leaves it out of the Morning Brief
     snooze: "YYYY-MM-DD", hidden from Overdue / Due soon until that day
   No saved schedule -> DUE_DEFAULTS. A vehicle's "Oil & filter" mileage is its oilInterval spec (default 5,000).
   Due = the last log entry with that task + the interval, whichever of meter or months comes first.
   Never logged -> state "none" (not tracked yet). */
const DUE_DEFAULTS={
  engine:[["Oil change",50,12],["Spark plug",100,12],["Air filter",25,12],["Fuel filter",100,12]],
  vehicle:[["Oil & filter",5000,12],["Tire rotation",7500,12],["Air filter",15000,12],["Brakes",10000,12]]};
const DUE_WARN={engine:[[5,14],[10,30],[2,7]],vehicle:[[500,14],[1000,30],[250,7]]}; // [meter, days]; the first is the default
const DUE_MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const dueKind=e=>e&&e.kind==="vehicle"?"vehicle":"engine";
const dueSlug=t=>String(t||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"service";
const dueYmd=k=>String(k||"").slice(0,10).split("-").map(Number);
const dueDays=(a,b)=>{const [y1,m1,d1]=dueYmd(a),[y2,m2,d2]=dueYmd(b);return Math.round((Date.UTC(y2,m2-1,d2)-Date.UTC(y1,m1-1,d1))/864e5)};
const dueAddDays=(k,n)=>{const [y,m,d]=dueYmd(k);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10)};
function dueAddMonths(k,n){const [y,m,d]=dueYmd(k);const f=new Date(Date.UTC(y,m-1+n,1));
  const last=new Date(Date.UTC(f.getUTCFullYear(),f.getUTCMonth()+1,0)).getUTCDate();
  return new Date(Date.UTC(f.getUTCFullYear(),f.getUTCMonth(),Math.min(d,last))).toISOString().slice(0,10)}
const dueDay=k=>{const [y,m,d]=dueYmd(k);return `${DUE_MON[m-1]} ${d}, ${y}`};
const dueMonth=k=>{const [y,m]=dueYmd(k);return `${DUE_MON[m-1]} ${y}`};
const dueSpan=n=>n<14?`${n} day${n===1?"":"s"}`:n<60?`${Math.round(n/7)} weeks`:`${Math.round(n/30.4)} months`;
const dueMeter=(kd,n)=>kd==="vehicle"?fmtMi(n):`${(Math.round(n*10)/10).toLocaleString("en-US")} h`;
/** The services tracked on a machine (its saved schedule, or the defaults). */
function schedOf(e){const kd=dueKind(e),w=DUE_WARN[kd][0];
  const list=Array.isArray(e&&e.schedule)?e.schedule:DUE_DEFAULTS[kd].map(([task,every,months])=>
    ({id:dueSlug(task),task,every:String(every),months:String(months),warnMeter:String(w[0]),warnDays:String(w[1]),part:"",brief:true}));
  return list.filter(s=>s&&String(s.task||"").trim())}
/** One service's status on `today` ("YYYY-MM-DD"). */
function dueOf(e,s,today){const kd=dueKind(e),w=DUE_WARN[kd][0];
  const every=kd==="vehicle"&&s.task==="Oil & filter"?(milesN(e.oilInterval)||5000):milesN(s.every);
  const months=milesN(s.months);
  const warnM=milesN(s.warnMeter)??w[0],warnD=milesN(s.warnDays)??w[1];
  const log=sortedLog(e).filter(l=>(l.tasks||[]).includes(s.task)&&/^\d{4}-\d{2}-\d{2}/.test(String(l.date||"")));
  const r={s,task:s.task,kd,every:every||null,months:months||null,last:log[0]||null,lastMeter:null,m:null,t:null,
    state:"none",by:null,pct:0,upcoming:false,snoozed:!!(s.snooze&&String(s.snooze)>=today),brief:s.brief!==false,text:"",short:""};
  if(!r.last)return r;
  const lm=log.find(l=>milesN(l.hours)!=null),cur=milesN(e.hours);
  if(lm)r.lastMeter=milesN(lm.hours);
  if(every&&lm){const at=r.lastMeter+every,left=cur==null?null:at-cur;
    r.m={at,left,used:cur==null?null:cur-r.lastMeter,state:left==null?"ok":left<0?"over":left<=warnM?"soon":"ok",pct:left==null?0:(every-left)/every}}
  if(months){const from=String(r.last.date).slice(0,10),due=dueAddMonths(from,months),left=dueDays(today,due),total=Math.max(1,dueDays(from,due));
    r.t={due,left,used:total-left,total,state:left<0?"over":left<=warnD?"soon":"ok",pct:(total-left)/total}}
  const rank={over:0,soon:1,ok:2},sides=[r.m,r.t].filter(Boolean);
  if(!sides.length)return r;
  const d=[...sides].sort((a,b)=>rank[a.state]-rank[b.state]||b.pct-a.pct)[0]; // the worse side decides
  r.state=d.state;r.by=d===r.m?"meter":"time";r.pct=Math.max(0,Math.min(1,d.pct));
  r.upcoming=r.state==="ok"&&(!!(r.t&&r.t.left<=92)||!!(r.m&&r.m.pct>=2/3)); // "Coming up": within 3 months, or 2/3 of the miles / hours used
  const M=n=>dueMeter(kd,n);
  if(r.by==="meter"){const m=r.m;
    if(m.left==null){r.text=`Due at ${M(m.at)} · update the ${kd==="vehicle"?"mileage":"engine hours"} to check`;r.short=`at ${M(m.at)}`}
    else if(m.state==="over"){r.text=`${M(-m.left)} overdue · was due at ${M(m.at)}`;r.short=`${M(-m.left)} overdue`}
    else if(m.state==="soon"){r.text=`Due in ${M(m.left)} · at ${M(m.at)}`;r.short=`in ${M(m.left)}`}
    else{r.text=`Due at ${M(m.at)} · in ${M(m.left)}`;r.short=`at ${M(m.at)}`}}
  else{const t=r.t;
    if(t.state==="over"){r.text=`${dueSpan(-t.left)} overdue · was due ${dueDay(t.due)}`;r.short=`${dueSpan(-t.left)} overdue`}
    else if(t.state==="soon"){r.text=t.left===0?"Due today":`Due ${dueDay(t.due)} · in ${dueSpan(t.left)}`;r.short=t.left===0?"today":`in ${dueSpan(t.left)}`}
    else{r.text=`Due ${dueMonth(t.due)} · in ${dueSpan(t.left)}`;r.short=dueMonth(t.due)}}
  return r}
/** Every tracked service on a machine, with its status. */
const dueList=(e,today)=>schedOf(e).map(s=>dueOf(e,s,today));
/* ---- due rules: end ---- */
export { dueList, schedOf };

function machineName(e) {
  if (String(e.name || '').trim()) return e.name.trim();
  const mm = (kindOf(e) === 'vehicle' ? [e.year, e.make, e.model] : [e.make, e.model])
    .map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  return mm || (kindOf(e) !== 'vehicle' && e.equipment) || `Unnamed ${kindOf(e)}`;
}

// ---------- Home Projects' own rules -----------------------------------------------

const UNITS = ['days', 'weeks', 'months', 'years'];
const UDAYS = { days: 1, weeks: 7, months: 30.4, years: 365 };
const ymdUTC = (d) => d.toISOString().slice(0, 10);

/** "YYYY-MM-DD" plus n units, the same way the app counts (end-of-month safe). */
function addInterval(key, n, unit) {
  const [y, m, d] = key.split('-').map(Number);
  if (unit === 'days' || unit === 'weeks') return ymdUTC(new Date(Date.UTC(y, m - 1, d + n * (unit === 'weeks' ? 7 : 1))));
  const months = n * (unit === 'years' ? 12 : 1);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return ymdUTC(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))));
}

/** A reminder's next due date and state on `today`, or null when never logged. */
export function upkeepStatus(r, today) {
  const hist = (Array.isArray(r.history) ? r.history : []).map((h) => String((h && h.date) || '').slice(0, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
  const lastKey = hist.sort().pop() || (/^\d{4}-\d{2}-\d{2}/.test(String(r.last || '')) ? String(r.last).slice(0, 10) : '');
  if (!lastKey) return null;
  const every = Math.max(1, Math.min(999, Math.round(Number(r.every) || 1)));
  const unit = UNITS.includes(r.unit) ? r.unit : 'months';
  const due = addInterval(lastKey, every, unit);
  const left = daysBetween(today, due);
  const window = Math.min(14, Math.max(3, Math.round(every * UDAYS[unit] * 0.2)));
  return { last: lastKey, due, left, state: left < 0 ? 'over' : left <= window ? 'soon' : 'ok' };
}

// ---------- building -----------------------------------------------------------------

/**
 * records: Logbook records (engines, vehicles, parts), each {id, ...data}
 * projects: Project Tracker projects, each {id, ...data}
 * upkeep: Home Projects docs, each {id, ...data}; only kind "upkeep" is used
 * events: calendar events from eventsInWindow (or null when no calendar)
 * calendar: 'none' | 'ok' | 'error'
 * frequency: 'daily' (today, then the next 14 days) or 'weekly' (the 7 days
 *   from today, then the week after)
 */
export function buildBrief({ records = [], projects = [], upkeep = [], events = null, nowMs = Date.now(), tz = 'UTC', sections = DEFAULT_SECTIONS, calendar = 'none', frequency = 'daily' }) {
  const on = { ...DEFAULT_SECTIONS, ...(sections || {}) };
  const today = dateKey(nowMs, tz);
  const weekly = frequency === 'weekly';
  const lastDay = addDaysKey(today, weekly ? 6 : 0); // end of "today" / "this week"
  const upTo = addDaysKey(today, weekly ? 13 : 14); // end of "coming up"
  const brief = { today, dateLabel: weekly ? `Week of ${fmtLongDate(today)}` : fmtLongDate(today), tz, on, calendar, weekly, title: weekly ? 'Weekly Brief' : 'Morning Brief', sections: {} };
  const endKey = (e) => (e.allDay ? dateKey(e.endMs - 1, tz) : dateKey(Math.max(e.endMs - 1, e.startMs), tz));

  if (on.today || on.upcoming) {
    const evs = events || [];
    if (on.today) {
      brief.sections.today = evs
        .filter((e) => dateKey(e.startMs, tz) <= lastDay && endKey(e) >= today)
        .map((e) => {
          const started = dateKey(e.startMs, tz) < today;
          if (!weekly) {
            return { when: e.allDay ? 'All day' : started ? 'Continues' : fmtTime(e.startMs, tz), title: e.title, detail: e.location };
          }
          const day = fmtShortDate(started ? today : dateKey(e.startMs, tz)).split(',')[0];
          return {
            when: started ? 'Ongoing' : e.allDay ? day : `${day} ${fmtTime(e.startMs, tz)}`,
            title: e.title,
            detail: [weekly && !started ? fmtShortDate(dateKey(e.startMs, tz)).split(', ')[1] : '', e.location].filter(Boolean).join(' · '),
          };
        });
    }
    if (on.upcoming) {
      brief.sections.upcoming = evs
        .filter((e) => dateKey(e.startMs, tz) > lastDay && dateKey(e.startMs, tz) <= upTo)
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
      for (const d of dueList(e, today)) {
        if ((d.state !== 'over' && d.state !== 'soon') || d.snoozed || !d.brief) continue;
        items.push({ machine: machineName(e), item: d.task, detail: d.text, state: d.state, rank: d.state === 'over' ? 0 : 1 });
      }
    }
    for (const r of upkeep.filter((x) => x && x.kind === 'upkeep')) {
      const st = upkeepStatus(r, today);
      if (!st || st.state === 'ok') continue;
      const n = Math.abs(st.left);
      const when = st.left < 0 ? `${n} day${n === 1 ? '' : 's'} overdue` : st.left === 0 ? 'due today' : `due in ${n} day${n === 1 ? '' : 's'}`;
      items.push({
        machine: String(r.location || '').trim() || 'Home',
        item: String(r.name || '').trim() || 'Upkeep reminder',
        detail: [when, st.left !== 0 ? fmtShortDate(st.due) : '', String(r.part || '').trim()].filter(Boolean).join(' · '),
        state: st.state,
        rank: st.state === 'over' ? 0 : 1,
        home: true,
      });
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
  if (s.today) bits.push(`${s.today.length} event${s.today.length === 1 ? '' : 's'} ${weekly ? 'this week' : 'today'}`);
  if (s.lowStock && s.lowStock.length) bits.push(`${s.lowStock.length} running low`);
  if (s.maintenance && s.maintenance.length) bits.push(`${s.maintenance.length} service${s.maintenance.length === 1 ? '' : 's'} due`);
  if (s.projects && s.projects.length) bits.push(`${s.projects.length} open project${s.projects.length === 1 ? '' : 's'}`);
  brief.summary = bits.join(' · ');
  return brief;
}

// ---------- maintenance alerts ------------------------------------------------------

/**
 * "Only maintenance alerts": the same maintenance list as the brief, on its
 * own. The sender emails it when the list changes (alertKey) or once a week
 * while something is still due.
 */
export function buildAlert({ records = [], upkeep = [], nowMs = Date.now(), tz = 'UTC' }) {
  const brief = buildBrief({ records, upkeep, nowMs, tz, sections: { today: false, upcoming: false, lowStock: false, maintenance: true, projects: false } });
  const items = brief.sections.maintenance;
  brief.alert = true;
  brief.title = 'Maintenance Alert';
  brief.summary = items.length
    ? `${items.length} item${items.length === 1 ? '' : 's'}: ${items.slice(0, 2).map((m) => `${m.machine} ${m.item.toLowerCase()}`).join(', ')}${items.length > 2 ? ` and ${items.length - 2} more` : ''}`
    : 'Nothing due right now';
  return brief;
}

/** What's due, as one string: a change means something new or worse came due. */
export function alertKey(brief) {
  return (brief.sections.maintenance || []).map((m) => `${m.machine}|${m.item}|${m.state}`).sort().join('\n');
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

export function renderBrief(brief, { siteUrl = 'https://garageterminal.com' } = {}) {
  const s = brief.sections;
  const parts = [];
  const calNote = brief.calendar === 'none'
    ? 'No calendar connected. Add one in your Morning Brief settings.'
    : brief.calendar === 'error' ? "Your calendar couldn't be read this morning." : null;

  if (s.today) {
    parts.push(section(heading(brief, 'today'), s.today.length ? rows(s.today, (e) => row(e.when, e.title, e.detail)) : '', calNote || (brief.weekly ? 'Nothing on the calendar this week.' : 'Nothing on the calendar today.')));
  }
  if (s.upcoming) {
    parts.push(section(heading(brief, 'upcoming'), s.upcoming.length ? rows(s.upcoming, (e) => row('', e.title, `${e.when} · ${e.detail}`)) : '', calNote || (brief.weekly ? 'Nothing the week after.' : 'Nothing in the next two weeks.')));
  }
  if (s.lowStock) {
    parts.push(section(SECTIONS.lowStock, s.lowStock.length ? rows(s.lowStock, (p) => row('', p.name,
      [p.number && `#${p.number}`, `${p.qty} on hand · reorder at ${p.reorderAt}`, p.location].filter(Boolean).join(' · '),
      pill(p.out ? 'Out' : 'Low', p.out ? 'over' : 'soon'))) : '', 'Nothing below its reorder level.'));
  }
  if (s.maintenance) {
    parts.push(section(brief.alert ? 'Coming due' : SECTIONS.maintenance, s.maintenance.length ? rows(s.maintenance, (m) => row('', `${m.machine}: ${m.item}`, m.detail,
      pill(m.state === 'over' ? 'Overdue' : 'Due soon', m.state === 'over' ? 'over' : 'soon'))) : '', 'Everything is on schedule.'));
  }
  if (s.projects) {
    parts.push(section(SECTIONS.projects, s.projects.length ? rows(s.projects, (p) => row('', p.title, p.detail, p.urgent ? pill('Due', 'over') : '')) : '', 'No open projects.'));
  }

  const subject = brief.alert
    ? `Maintenance due · ${brief.summary}`
    : `${brief.title || 'Morning Brief'} · ${brief.weekly ? 'week of ' : ''}${fmtShortDate(brief.today)}${brief.summary ? ` · ${brief.summary}` : ''}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border-radius:12px;overflow:hidden">
<tr><td style="background:${C.head};padding:28px 28px 24px;${FONT}">
<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#b9c3d1">${esc(brief.dateLabel)}</div>
<div style="margin-top:6px;font-size:30px;font-weight:700;color:#ffffff">${esc(brief.title || 'Morning Brief')}</div>
${brief.summary ? `<div style="margin-top:8px;font-size:15px;color:#d6dce5">${esc(brief.summary)}</div>` : ''}
</td></tr>
${parts.join('\n')}
<tr><td style="padding:24px 28px 28px;${FONT}font-size:12px;color:${C.muted};line-height:1.6">
${brief.alert ? 'From your Garage Terminal Logbook and Home Projects. You get this when maintenance comes due, and once a week while it stays due.' : 'From your Garage Terminal Logbook, Project Tracker, Home Projects and calendar.'}<br>
<a href="${esc(siteUrl)}/apps/logbook" style="color:${C.accent}">Open the Logbook</a> · ${(s.maintenance || []).some((m) => m.home) ? `<a href="${esc(siteUrl)}/apps/home-projects" style="color:${C.accent}">Open Home Projects</a> · ` : ''}<a href="${esc(siteUrl)}/apps/morning-brief" style="color:${C.accent}">Change or stop this email</a>
</td></tr>
</table></td></tr></table></body></html>`;

  const lines = [`${(brief.title || 'Morning Brief').toUpperCase()} · ${brief.dateLabel}`, brief.summary, ''];
  const add = (title, items, fmt, empty) => {
    lines.push(title.toUpperCase());
    if (items.length) items.forEach((x) => lines.push(`- ${fmt(x)}`)); else lines.push(empty);
    lines.push('');
  };
  if (s.today) add(heading(brief, 'today'), s.today, (e) => `${e.when}  ${e.title}${e.detail ? ` (${e.detail})` : ''}`, calNote || (brief.weekly ? 'Nothing on the calendar this week.' : 'Nothing on the calendar today.'));
  if (s.upcoming) add(heading(brief, 'upcoming'), s.upcoming, (e) => `${e.title}: ${e.when}, ${e.detail}`, calNote || (brief.weekly ? 'Nothing the week after.' : 'Nothing in the next two weeks.'));
  if (s.lowStock) add(SECTIONS.lowStock, s.lowStock, (p) => `${p.name}${p.number ? ` #${p.number}` : ''}: ${p.qty} on hand (reorder at ${p.reorderAt})`, 'Nothing below its reorder level.');
  if (s.maintenance) add(SECTIONS.maintenance, s.maintenance, (m) => `${m.machine}: ${m.item}, ${m.detail}`, 'Everything is on schedule.');
  if (s.projects) add(SECTIONS.projects, s.projects, (p) => `${p.title}: ${p.detail}`, 'No open projects.');
  lines.push(`Change or stop this email: ${siteUrl}/apps/morning-brief`);
  return { subject, html, text: lines.join('\n') };
}
