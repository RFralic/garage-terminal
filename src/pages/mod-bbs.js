// mod-bbs.js: the BBS tab in /mod (sysop and co-sysops).
//
//   Requests   who's waiting: Approve / Deny (newest first)
//   Members    everyone let in: Remove, Make co-sysop / Remove co-sysop (sysop only)
//   Add        search site accounts by handle -> Add (in immediately)
//   Denied     denied in the last 30 days: Let them in / Clear the wait
//   Removed    removed members: Let them back in
//   Settings   door word, require a passcode, "From the sysop" notice (sysop only)
//
// Every change goes through the `bbs` Cloud Function (functions/bbs.js), which
// re-checks powers and writes the mod log. Emails go out from Cloud Functions.

import { el, timeEl } from '../lib/ui.js';
import {
  bbsAction, getConfig, loadRequests, watchRequests, loadMembers, loadDenied, loadRemoved, byRank, roleLabel,
} from '../lib/bbs.js';

let sub = 'requests';
let stopLive = null; // the live Requests list, stopped when another sub-tab opens
let countChip = null;

/** mod.js calls this when the number of waiting requests changes. */
export function setRequestCount(n) {
  if (countChip) countChip.textContent = `Requests${n ? ` (${n})` : ''}`;
}

const btn = (label, onclick, cls = 'link-btn') => el('button', { class: cls, type: 'button', onclick }, label);
const line = (text, cls = 'mutedt') => el('p', { class: cls }, text);
const when = (ts) => (ts ? timeEl(ts) : el('span', {}, '—'));
const date = (ts) => (ts?.toDate ? ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

/**
 * Draw the BBS tab into `body`. `who` = { isSysop }, `requestCount` = live count for the
 * sub-tab label. `refresh()` re-draws after an action.
 */
export async function renderBbs(body, who, requestCount = 0) {
  const subs = [
    ['requests', `Requests${requestCount ? ` (${requestCount})` : ''}`],
    ['members', 'Members'],
    ['add', '+ Add a member'],
    ['denied', 'Denied'],
    ['removed', 'Removed'],
    ...(who.isSysop ? [['settings', 'Settings']] : []),
  ];
  if (!subs.some(([id]) => id === sub)) sub = 'requests';
  if (stopLive) { stopLive(); stopLive = null; }
  const box = el('div', { class: 'bbs-sub' }, line('loading…'));
  const nav = el('nav', { class: 'chips bbs-subs', 'aria-label': 'BBS sections' }, ...subs.map(([id, label]) =>
    el('button', { class: 'chip', type: 'button', 'aria-current': id === sub ? 'true' : false, onclick: () => { sub = id; renderBbs(body, who, requestCount); } }, label)));
  countChip = nav.firstElementChild;
  body.replaceChildren(nav, box);

  const refresh = () => renderBbs(body, who, requestCount);
  const act = async (action, params, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await bbsAction(action, params);
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  };
  const item = (...children) => el('li', { class: 'mod-item member-row' }, ...children);
  const list = (items, empty) => (items.length ? el('ol', { class: 'mod-list' }, ...items) : line(empty));

  if (sub === 'requests') {
    // Live: a new request shows up without reloading.
    const draw = (reqs) => box.replaceChildren(list(reqs.map((r) => item(
      el('strong', {}, r.handle), el('span', { class: 'mutedt small' }, 'asked ', when(r.createdAt)),
      el('span', { class: 'post-actions' },
        btn('Approve', () => act('request.approve', { uid: r.uid }), 'link-btn mod'),
        btn('Deny', () => act('request.deny', { uid: r.uid }, `Deny ${r.handle}? They can't ask again for 30 days. No email is sent.`), 'link-btn danger')))),
    '> No requests waiting.'));
    draw(await loadRequests());
    stopLive = watchRequests(draw, () => {});
  } else if (sub === 'members') {
    const members = (await loadMembers()).sort(byRank);
    box.replaceChildren(list(members.map((m) => item(
      el('strong', {}, m.handle), roleLabel(m.role) ? el('span', { class: 'tag tag-sysop' }, roleLabel(m.role).toUpperCase()) : null,
      el('span', { class: 'mutedt small' }, `joined ${date(m.since)} · last seen `, when(m.lastSeen)),
      m.role === 'sysop' ? null : el('span', { class: 'post-actions' },
        who.isSysop ? (m.role === 'cosysop'
          ? btn('Remove co-sysop', () => act('member.role', { uid: m.uid, role: 'member' }))
          : btn('Make co-sysop', () => act('member.role', { uid: m.uid, role: 'cosysop' }, `Make ${m.handle} a co-sysop? They can let people in, remove members and moderate posts and chat.`))) : null,
        (who.isSysop || m.role !== 'cosysop')
          ? btn('Remove', () => act('member.remove', { uid: m.uid }, `Remove ${m.handle} from the BBS? Their access ends right away. No email is sent.`), 'link-btn danger') : null))),
    '> Nobody yet.'));
  } else if (sub === 'add') {
    const input = el('input', { class: 'field', type: 'search', placeholder: 'Search site accounts by handle…', 'aria-label': 'Search site accounts by handle', autocomplete: 'off' });
    const results = el('div', {}, line('Type the start of a handle. Only people who have signed in and picked a handle are listed.', 'mutedt small'));
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const text = input.value.trim();
        if (!text) return results.replaceChildren();
        try {
          const { accounts } = await bbsAction('accounts.search', { text });
          results.replaceChildren(list(accounts.map((a) => item(
            el('strong', {}, a.handle),
            a.member ? el('span', { class: 'mutedt small' }, 'already in') : btn('Add', async (e) => {
              e.target.disabled = true;
              try { await bbsAction('member.add', { uid: a.uid }); e.target.replaceWith(el('span', { class: 'mutedt small' }, 'added ✓')); } catch (err) { alert(err.message); e.target.disabled = false; }
            }, 'link-btn mod'))), '> No accounts start with that.'));
        } catch (err) {
          results.replaceChildren(line(err.message, 'field-status'));
        }
      }, 300);
    });
    box.replaceChildren(input, results);
    input.focus();
  } else if (sub === 'denied') {
    const denied = await loadDenied();
    box.replaceChildren(list(denied.map((d) => item(
      el('strong', {}, d.handle), el('span', { class: 'mutedt small' }, `denied ${date(d.at)} · can ask again ${date(d.until)}`),
      el('span', { class: 'post-actions' },
        btn('Let them in', () => act('denied.letIn', { uid: d.uid }), 'link-btn mod'),
        btn('Clear the wait', () => act('denied.clear', { uid: d.uid }))))),
    '> Nobody denied in the last 30 days.'));
  } else if (sub === 'removed') {
    const removed = await loadRemoved();
    box.replaceChildren(list(removed.map((r) => item(
      el('strong', {}, r.handle), el('span', { class: 'mutedt small' }, `removed ${date(r.at)}${r.by ? ` by ${r.by}` : ''}`),
      el('span', { class: 'post-actions' }, btn('Let them back in', () => act('removed.restore', { uid: r.uid }), 'link-btn mod')))),
    '> Nobody removed.'));
  } else if (sub === 'settings') {
    const c = await getConfig();
    const word = el('input', { class: 'field', id: 'bbs-word', value: c.doorWord, maxlength: '24', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const pass = el('input', { type: 'checkbox', id: 'bbs-pass' });
    pass.checked = !!c.requirePasscode;
    const notice = el('textarea', { class: 'field area-field', id: 'bbs-notice', rows: 3, maxlength: '1000' });
    notice.value = c.notice || '';
    const status = el('p', { class: 'field-status', role: 'status' });
    const save = async (patch, msg) => {
      status.textContent = 'saving…';
      try { await bbsAction('settings.update', patch); status.textContent = msg; } catch (err) { status.textContent = err.message; }
    };
    box.replaceChildren(
      el('div', { class: 'setting' },
        el('label', { class: 'field-label', for: 'bbs-word' }, 'Door word'), word,
        line('Typed at the >_ in the footer (or anywhere on a page, on a computer) to reach the BBS log-in. 3–24 letters or numbers. It isn’t a secret: it only hides the door.', 'mutedt small'),
        btn('Save door word', () => save({ doorWord: word.value }, 'Door word saved.'), 'btn')),
      el('div', { class: 'setting' },
        el('p', { class: 'field-label' }, 'Passcode'),
        el('label', { class: 'switch', for: 'bbs-pass' }, pass, el('span', {}, 'Require a passcode')),
        line('When on, people type a 6-digit passcode before their request is sent (5 tries, then a 15-minute lockout). The passcode lives in Google Cloud Secret Manager as BBS_PASSCODE; see README.md.', 'mutedt small'),
        btn('Save passcode switch', () => save({ requirePasscode: pass.checked }, pass.checked ? 'Passcode required.' : 'Passcode switched off.'), 'btn')),
      el('div', { class: 'setting' },
        el('label', { class: 'field-label', for: 'bbs-notice' }, '“From the sysop” notice (on the BBS home; empty hides it)'), notice,
        btn('Save notice', () => save({ notice: notice.value }, 'Notice saved.'), 'btn primary')),
      status);
  }
}
