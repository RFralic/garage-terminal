// Torque Chart: "Add to a vehicle or engine".
//
// Adds a chart value to the torque table of one of your Logbook machines
// (logbook/{uid}/records/{id}, field `torque`). Every entry made here is saved with
//   src: 'chart'      so the Logbook shows it as "From chart", never as a manual spec
//   chart: '3/8-16 Grade 5, dry'   the bolt, grade and threads it came from
// Loaded only when someone taps the button, so the chart itself needs no sign-in.

import { collection, doc, getDoc, getDocs, updateDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.js';
import { finishRedirectSignIn, signInWithGoogle } from '../lib/session.js';
import { onAuthStateChanged } from 'firebase/auth';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const RESUME = 'gt-torque-add';
const MAX_ROWS = 100;

const kindOf = (e) => (e && e.kind === 'vehicle' ? 'vehicle' : e && e.kind === 'part' ? 'part' : 'engine');
function dname(e) {
  if ((e.name || '').trim()) return e.name.trim();
  const mm = (kindOf(e) === 'vehicle' ? [e.year, e.make, e.model] : [e.make, e.model]).map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  return mm || (e.equipment && kindOf(e) !== 'vehicle' ? e.equipment : '') || (kindOf(e) === 'vehicle' ? 'Unnamed vehicle' : 'Unnamed engine');
}

function waitForUser() {
  return new Promise((res) => { const stop = onAuthStateChanged(auth, (u) => { stop(); res(u); }); });
}

function show(dlg, html) {
  dlg.innerHTML = `<div class="dlg">${html}</div>`;
  for (const b of dlg.querySelectorAll('[data-close]')) b.onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
}

const chartBox = (spec) => `<div class="chartbox"><span><span class="tag chart">From chart</span> <b>${esc(spec.value)} ${esc(spec.unit)}</b> · ${esc(spec.label)}</span>
  <span>Saved with a <b style="font-family:inherit;color:inherit">From chart</b> mark, so it's never mistaken for your manual's spec.</span></div>`;

/** Called by the page: open the dialog for this chart value. */
export async function openAdd(spec, dlg) {
  show(dlg, '<h2>Add to a vehicle or engine</h2><p class="msg">Loading your machines…</p>');
  const user = auth.currentUser || (await waitForUser());
  if (!user) {
    show(dlg, `<h2>Add to a vehicle or engine</h2>${chartBox(spec)}
      <p class="msg">Sign in with the account you use for the Logbook to add this to one of your machines.</p>
      <div class="btns"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn" id="tqSignIn">Sign in with Google</button></div>`);
    dlg.querySelector('#tqSignIn').onclick = async () => {
      try { sessionStorage.setItem(RESUME, JSON.stringify(spec)); } catch { /* fine */ }
      try {
        await signInWithGoogle(); // a popup on computers; phones leave and come back (see resume)
        try { sessionStorage.removeItem(RESUME); } catch { /* fine */ }
        openAdd(spec, dlg);
      } catch (err) {
        if (err && err.code === 'auth/popup-closed-by-user') return;
        show(dlg, `<h2>Add to a vehicle or engine</h2><p class="msg err">Couldn't sign in: ${esc(err && (err.message || err.code))}</p><div class="btns"><button type="button" class="btn" data-close>OK</button></div>`);
      }
    };
    return;
  }

  let machines;
  try {
    const snap = await getDocs(collection(db, 'logbook', user.uid, 'records'));
    machines = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => kindOf(e) !== 'part');
  } catch (err) {
    show(dlg, `<h2>Add to a vehicle or engine</h2><p class="msg err">Couldn't load your Logbook: ${esc(err.message || err.code)}</p><div class="btns"><button type="button" class="btn" data-close>OK</button></div>`);
    return;
  }
  if (!machines.length) {
    show(dlg, `<h2>Add to a vehicle or engine</h2>${chartBox(spec)}<p class="msg">There are no engines or vehicles in your Logbook yet. Add one there first.</p>
      <div class="btns"><button type="button" class="btn ghost" data-close>Close</button><a class="btn" href="/apps/logbook" style="text-decoration:none">Open the Logbook</a></div>`);
    return;
  }
  const byName = (a, b) => dname(a).localeCompare(dname(b));
  const group = (k, label) => {
    const list = machines.filter((m) => kindOf(m) === k).sort(byName);
    return list.length ? `<optgroup label="${label}">${list.map((m) => `<option value="${esc(m.id)}">${esc(dname(m))}</option>`).join('')}</optgroup>` : '';
  };
  let last = '';
  try { last = localStorage.getItem('gt-torque-last') || ''; } catch { /* fine */ }
  show(dlg, `<h2>Add to a vehicle or engine</h2>${chartBox(spec)}
    <label>Machine<select id="tqM">${group('vehicle', 'Vehicles')}${group('engine', 'Engines')}</select></label>
    <label>What it's for<input id="tqItem" maxlength="120" placeholder="e.g. Blade bolt, valve cover, motor mount" autocomplete="off"></label>
    <div class="row2">
      <label>Socket / wrench<input id="tqSize" maxlength="40" value="${esc(spec.wrench)}" placeholder="9/16&quot;"></label>
      <label>Notes<input id="tqNotes" maxlength="200" placeholder="Optional" autocomplete="off"></label>
    </div>
    <p class="msg" id="tqMsg" aria-live="polite"></p>
    <div class="btns"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn" id="tqSave">Add it</button></div>`);
  const sel = dlg.querySelector('#tqM');
  if (last && machines.some((m) => m.id === last)) sel.value = last;
  const item = dlg.querySelector('#tqItem');
  item.focus();
  dlg.querySelector('#tqSave').onclick = async () => {
    const msg = dlg.querySelector('#tqMsg');
    const what = item.value.trim();
    if (!what) { msg.className = 'msg err'; msg.textContent = 'Say what the bolt is for, so you can find it later.'; item.focus(); return; }
    const save = dlg.querySelector('#tqSave');
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
    const id = sel.value;
    const entry = {
      item: what,
      size: dlg.querySelector('#tqSize').value.trim(),
      value: spec.value,
      unit: spec.unit,
      notes: dlg.querySelector('#tqNotes').value.trim(),
      src: 'chart',
      chart: spec.label,
    };
    try {
      const ref = doc(db, 'logbook', user.uid, 'records', id);
      const cur = await getDoc(ref);
      if (!cur.exists()) throw new Error('That machine is no longer in your Logbook.');
      const torque = Array.isArray(cur.data().torque) ? cur.data().torque : [];
      if (torque.length >= MAX_ROWS) throw new Error('That machine already has ' + MAX_ROWS + ' torque specs.');
      await updateDoc(ref, { torque: [...torque, entry] });
      try { localStorage.setItem('gt-torque-last', id); } catch { /* fine */ }
      const name = dname(machines.find((m) => m.id === id) || {});
      show(dlg, `<h2>Added</h2><p class="msg ok">${esc(what)}: ${esc(spec.value)} ${esc(spec.unit)} is on ${esc(name)}'s torque specs, marked <b>From chart</b>.</p>
        <div class="btns"><button type="button" class="btn ghost" data-close>Done</button><a class="btn" href="/apps/logbook" style="text-decoration:none">Open the Logbook</a></div>`);
    } catch (err) {
      save.disabled = false; msg.className = 'msg err'; msg.textContent = "Couldn't add it: " + (err.message || err.code);
    }
  };
}

/** After a phone sign-in redirect: reopen the dialog with the value they picked. */
export async function resume(dlg) {
  let spec = null;
  try { spec = JSON.parse(sessionStorage.getItem(RESUME) || 'null'); sessionStorage.removeItem(RESUME); } catch { /* fine */ }
  try { await finishRedirectSignIn(); } catch { /* shown below if still signed out */ }
  if (spec && spec.label && spec.value) openAdd(spec, dlg);
}
