// dm.js: private messages between two members (#dm/<uid>), and the conversation list on the
// Crew tab. Only the two members can read a conversation, not even the sysop (firestore.rules,
// bbsDms). Kept until deleted: you can delete your own messages, and hide a conversation from
// your own list (it comes back when a new message arrives).
//
// End-to-end encrypted since Nov 24, 2026 (e2e.js, keys.js): words and photos are sealed on
// the sender's device and only opened on the two members' devices. Firestore keeps
//   messages/{id}  { uid, handle, text: '', enc: { v: 1, iv, ct, k: [lock id of each member] },
//                    photo?: { w, h }, createdAt }
//   blobs/{id}     { uid, iv, data (the sealed JPEG bytes), createdAt }  for a message's photo
// and the conversation's lastText is only ever 'Encrypted message' or 'Message deleted'.
// Older messages (plain text, photo in Storage at bbs/dm/…) still show, marked as such.
import {
  Bytes, collection, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { db } from '../lib/firebase.js';
import { shrinkPhoto } from '../lib/photo.js';
import { el, timeAgo } from '../lib/ui.js';
import { isHere } from '../lib/bbs.js';
import { fileUrl } from './data.js';
import { clock } from './chat.js';
import { openBytes, openText, safetyCode, sealBytes, sealText } from './e2e.js';
import { keyFor, lockPanel, myLock, pubOf } from './keys.js';

const PAGE = 100;
const SEND = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2-6z"/></svg>';
const CAMERA = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>';

const ms = (ts) => (ts?.toMillis ? ts.toMillis() : 0);
export const convIdOf = (a, b) => [a, b].sort().join('_');
const otherOf = (c, me) => c.members.find((u) => u !== me);

// ---------- data ----------------------------------------------------------------------------

/** My conversations, newest first. */
export const watchConvs = (uid, cb, onError) =>
  onSnapshot(query(collection(db, 'bbsDms'), where('members', 'array-contains', uid)),
    // 'estimate': a time still being saved counts as now (not blank), so a fresh read mark isn't "unread"
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).sort((a, b) => ms(b.lastAt) - ms(a.lastAt))), onError);

/** Unread: the last message is someone else's and newer than my read mark. */
export const isUnread = (c, uid) => c.lastBy !== uid && ms(c.lastAt) > ms(c.readAt?.[uid]);
/** Hidden from my list, unless a newer message arrived since I hid it. */
export const isHidden = (c, uid) => !!c.hidden?.[uid] && ms(c.lastAt) <= ms(c.hidden[uid]);

export const SEALED = 'Encrypted message';
const previewOf = (t) => (t === SEALED ? '🔒 Message' : t);
const PHOTO_MAX = 700 * 1024; // sealed photos live in a Firestore doc (1 MiB limit)

/** Shrink a photo until it fits in one doc. */
async function smallPhoto(file) {
  for (const [max, q] of [[1280, 0.8], [1024, 0.72], [800, 0.65], [640, 0.6]]) {
    const out = await shrinkPhoto(file, max, q);
    if (out.blob.size <= PHOTO_MAX) return out;
  }
  throw new Error('That photo is too big to send. Try a smaller one.');
}

/** Send a sealed message. `seal` = { key, kids } for this conversation. */
async function send({ me, handle, other, otherHandle, text, file, seal, onProgress }) {
  const id = convIdOf(me, other);
  const convRef = doc(db, 'bbsDms', id);
  const exists = (await getDoc(convRef).catch(() => null))?.exists();
  if (!exists) {
    await setDoc(convRef, {
      members: [me, other].sort(), handles: { [me]: handle, [other]: otherHandle },
      lastAt: serverTimestamp(), lastText: '', lastBy: me, lastId: '', readAt: { [me]: serverTimestamp() }, hidden: {},
    });
  }
  const msgRef = doc(collection(convRef, 'messages'));
  const b = writeBatch(db);
  let photo = null;
  if (file) {
    onProgress?.(0);
    const { blob, w, h } = await smallPhoto(file);
    const sealed = await sealBytes(seal.key, new Uint8Array(await blob.arrayBuffer()), id, me, 'photo');
    photo = { w, h };
    b.set(doc(convRef, 'blobs', msgRef.id), { uid: me, iv: sealed.iv, data: Bytes.fromUint8Array(sealed.ct), createdAt: serverTimestamp() });
    onProgress?.(0.5);
  }
  const enc = { v: 1, ...(await sealText(seal.key, text, id, me)), k: seal.kids };
  b.set(msgRef, { uid: me, handle, text: '', enc, createdAt: serverTimestamp(), ...(photo ? { photo } : {}) });
  b.update(convRef, { lastAt: serverTimestamp(), lastText: SEALED, lastBy: me, lastId: msgRef.id, [`readAt.${me}`]: serverTimestamp() });
  await b.commit();
  onProgress?.(1);
}

// ---------- the list (top of the Crew tab) ----------------------------------------------------

export function convList(ctx) {
  const mine = (ctx.convs || []).filter((c) => !isHidden(c, ctx.uid));
  if (!mine.length) return el('p', { class: 'muted small', style: 'margin:0' }, 'No private messages yet. Tap Message next to someone below.');
  return el('ul', { class: 'panel rows', style: 'list-style:none;margin:0;padding:0' }, ...mine.map((c) => {
    const other = otherOf(c, ctx.uid);
    const name = ctx.crew.find((m) => m.uid === other)?.handle || c.handles?.[other] || 'Former member';
    const unread = isUnread(c, ctx.uid);
    return el('li', { style: 'padding:0' }, el('a', { class: 'trow', href: `#dm/${other}` },
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, name.slice(0, 2)),
      el('span', { class: 'main' }, el('span', { class: 'ttitle' }, name),
        el('span', { class: 'small muted', style: 'overflow-wrap:anywhere' }, `${c.lastBy === ctx.uid ? 'You: ' : ''}${previewOf(c.lastText) || '…'} · ${timeAgo(c.lastAt)}`)),
      unread ? el('span', { class: 'newtag' }, 'NEW') : null));
  }));
}

// ---------- a conversation ------------------------------------------------------------------------

export async function renderDm(ctx, [otherUid]) {
  const other = ctx.crew.find((m) => m.uid === otherUid);
  const id = otherUid ? convIdOf(ctx.uid, otherUid) : '';
  const convRef = id ? doc(db, 'bbsDms', id) : null;
  let conv = null;
  try { conv = convRef ? (await getDoc(convRef)).data() ?? null : null; } catch { conv = null; }
  const name = other?.handle || conv?.handles?.[otherUid] || '';
  if (!otherUid || otherUid === ctx.uid || (!other && !conv)) {
    ctx.main.replaceChildren(el('p', { class: 'soon' }, 'There’s nobody here to message.'), el('a', { class: 'link', href: '#crew' }, '← Crew'));
    return;
  }

  // My lock first: set it up, or unlock it on this device.
  const lock = await myLock(ctx.uid);
  if (lock.state !== 'ready') {
    ctx.main.replaceChildren(el('a', { class: 'link', href: '#crew' }, '← Crew'),
      lockPanel(ctx, lock.state, () => renderDm(ctx, [otherUid])));
    return;
  }
  const otherPub = await pubOf(otherUid, true);
  const members = [ctx.uid, otherUid].sort();
  const kidOfUid = { [ctx.uid]: lock.kid, [otherUid]: otherPub?.kid };
  const kids = members.map((u) => kidOfUid[u]);
  const seal = otherPub ? { key: await keyFor(id, lock, otherPub, kids), kids } : null;

  document.body.classList.add('chatmode');
  const foot = document.getElementById('b-foot');
  foot.hidden = true;
  document.getElementById('b-title').textContent = name;
  document.getElementById('b-eyebrow').textContent = 'PRIVATE MESSAGE · ENCRYPTED';
  const here = document.getElementById('b-here');
  if (other && isHere(other)) { here.replaceChildren(el('span', { class: 'dot', 'aria-hidden': 'true' }, '●'), ' here'); here.hidden = false; }

  let messages = [], shown = PAGE, full = false, stick = true, first = true;
  const log = el('div', { class: 'chatlog', role: 'log', 'aria-label': `Messages with ${name}`, 'aria-live': 'polite' });
  const status = el('p', { class: 'small chatstatus', role: 'status' });
  const input = el('input', { id: 'dm-msg', type: 'text', class: 'input', autocomplete: 'off', placeholder: `Message ${name}…`, maxlength: '2000', enterkeyhint: 'send' });
  const pick = el('input', { type: 'file', accept: 'image/*', class: 'sr', id: 'dm-photo', tabindex: '-1' });
  const photoBtn = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Add a photo', onclick: () => pick.click() });
  photoBtn.innerHTML = CAMERA;
  const sendBtn = el('button', { class: 'sendbtn', type: 'submit', 'aria-label': 'Send' });
  sendBtn.innerHTML = SEND;
  const form = el('form', { class: 'chatform' }, el('label', { for: 'dm-msg', class: 'sr' }, `Message to ${name}`), photoBtn, pick, input, sendBtn);
  const gone = el('p', { class: 'mutedline', hidden: true });
  pick.addEventListener('change', () => { if (pick.files[0]) { status.textContent = `Photo ready: ${pick.files[0].name}. Add words or tap send.`; input.focus(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim(), file = pick.files[0] || null;
    if ((!text && !file) || !seal) return;
    // Clear the box straight away (see Shop Talk); only a photo holds the send button.
    input.value = ''; pick.value = ''; stick = true;
    if (file) sendBtn.disabled = true;
    try {
      await send({ me: ctx.uid, handle: ctx.handle, other: otherUid, otherHandle: name, text, file, seal,
        onProgress: (p) => { if (file) status.textContent = p < 1 ? 'Encrypting the photo…' : ''; } });
      if (file) status.textContent = '';
      if (!stop) listen();
    } catch (err) {
      console.error(err);
      if (!input.value) input.value = text;
      status.textContent = /permission/i.test(err.code || err.message) ? 'You can’t send this right now.' : (err.message || 'Couldn’t send. Try again.');
    } finally { if (file) sendBtn.disabled = false; input.focus(); }
  });

  const drawState = () => {
    const muted = !ctx.isSysop && ctx.me?.mutedUntil?.toMillis && ctx.me.mutedUntil.toMillis() > Date.now();
    const left = !ctx.crew.some((m) => m.uid === otherUid);
    const noLock = !seal;
    gone.hidden = !(muted || left || noLock);
    gone.textContent = left ? `${name} isn’t in the BBS any more, so you can’t send new messages.`
      : muted ? 'You’re muted, so you can’t send messages right now. You can still read.'
        : `${name} hasn’t turned on encrypted messages yet. They’ll be asked the next time they open Crew; then you can write to them here.`;
    form.hidden = muted || left || noLock;
  };

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.addEventListener('scroll', () => {
    stick = nearBottom();
    if (log.scrollTop < 40 && full) { full = false; shown += PAGE; listen(); }
  });

  // ---- opening sealed messages (kept per message, so a redraw doesn't redo the work) ----
  const opened = new Map(); // message id -> { text } | { error }
  const photos = new Map(); // message id -> Promise<object URL>
  const lockGone = (m) => {
    const k = m.enc?.k || [];
    if (!seal) return `${name} has no lock now, so this can’t be opened.`;
    const mineIdx = members.indexOf(ctx.uid), otherIdx = 1 - mineIdx;
    if (k[mineIdx] !== lock.kid) return 'Sent to an older lock of yours, so it can’t be opened here.';
    if (k[otherIdx] !== otherPub?.kid) return `Sent before ${name} changed their lock, so it can’t be opened.`;
    return '';
  };
  async function openMsg(m) {
    if (opened.has(m.id)) return opened.get(m.id);
    const why = lockGone(m);
    let r;
    if (why) r = { error: why };
    else {
      try { r = { text: await openText(seal.key, m.enc, id, m.uid) }; } catch { r = { error: 'This message couldn’t be opened. It may have been changed on the way.' }; }
    }
    opened.set(m.id, r);
    return r;
  }
  function photoUrl(m) {
    if (!photos.has(m.id)) {
      photos.set(m.id, (async () => {
        if (lockGone(m)) throw new Error('old lock');
        const s = await getDoc(doc(db, 'bbsDms', id, 'blobs', m.id));
        if (!s.exists()) throw new Error('missing');
        const { iv, data, uid } = s.data();
        if (uid !== m.uid) throw new Error('wrong sender');
        const bytes = await openBytes(seal.key, { iv, ct: data.toUint8Array() }, id, m.uid, 'photo');
        return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      })());
    }
    return photos.get(m.id);
  }

  function bubble(m) {
    const mine = m.uid === ctx.uid;
    const b = el(mine ? 'button' : 'div', { class: `bubble${mine ? ' mine' : ''}`, ...(mine ? { type: 'button', 'aria-label': `Your message at ${clock(m.createdAt)}. Delete` } : {}) });
    if (mine) {
      b.addEventListener('click', async () => {
        if (!confirm('Delete this message? It’s removed for both of you.')) return;
        try {
          const batch = writeBatch(db);
          batch.delete(doc(db, 'bbsDms', id, 'messages', m.id));
          if (m.enc && m.photo) batch.delete(doc(db, 'bbsDms', id, 'blobs', m.id));
          await batch.commit();
          if (conv?.lastId === m.id || messages[messages.length - 1]?.id === m.id) {
            await updateDoc(convRef, { lastText: 'Message deleted' }).catch(() => {});
          }
        } catch { alert('Couldn’t delete it.'); }
      });
    }
    const linkSlot = el('span');
    const showLink = (text) => {
      const link = (text?.match(/https?:\/\/[^\s<>"]+/i) || [])[0];
      linkSlot.replaceChildren(link ? el('a', { class: 'clink', href: link, target: '_blank', rel: 'nofollow ugc noopener noreferrer' }, link.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 48)) : '');
    };
    if (m.enc) {
      const t = el('span', { class: 'btext' }, '🔒 …');
      b.append(t);
      const done = opened.get(m.id);
      const fill = (r) => {
        if (r.error) { t.className = 'small dim'; t.textContent = `🔒 ${r.error}`; }
        else if (r.text) { t.textContent = r.text; showLink(r.text); } else t.remove();
      };
      if (done) fill(done); else openMsg(m).then(fill);
      if (m.photo) {
        const img = el('img', { class: 'cphoto', alt: `Photo from ${m.handle}`, width: m.photo.w, height: m.photo.h });
        photoUrl(m).then((u) => { img.src = u; }).catch(() => img.replaceWith(el('span', { class: 'small dim' }, '🔒 [photo can’t be opened]')));
        b.append(img);
      }
    } else {
      // From before encryption was turned on.
      if (m.text) b.append(el('span', { class: 'btext' }, m.text));
      if (m.photo?.path) {
        const img = el('img', { class: 'cphoto', alt: `Photo from ${m.handle}`, width: m.photo.w, height: m.photo.h, loading: 'lazy' });
        fileUrl(m.photo.path).then((u) => { img.src = u; }).catch(() => img.replaceWith(el('span', { class: 'small dim' }, '[photo unavailable]')));
        b.append(img);
      }
      b.append(el('span', { class: 'small dim', style: 'display:block;margin-top:4px' }, 'not encrypted (sent before Nov 24)'));
      showLink(m.text);
    }
    return el('div', { class: `crow${mine ? ' mine' : ''}` },
      el('div', { class: 'cmeta' }, el('span', { class: `chandle${mine ? ' mine' : ''}` }, m.handle), el('span', { class: 'ctime' }, clock(m.createdAt))),
      b, linkSlot);
  }

  function draw() {
    const at = stick || nearBottom(), fromBottom = log.scrollHeight - log.scrollTop;
    const out = [];
    if (full) out.push(el('p', { class: 'sys center' }, 'Scroll up for older messages'));
    out.push(...messages.map(bubble));
    if (!messages.length) out.push(el('p', { class: 'sys center' }, `No messages yet. Say hi to ${name}.`));
    log.replaceChildren(...out);
    log.scrollTop = at ? log.scrollHeight : log.scrollHeight - fromBottom;
  }

  let stop = null, stopConv = null, markedFor = null;
  function listen() {
    stop?.();
    stop = onSnapshot(query(collection(db, 'bbsDms', id, 'messages'), orderBy('createdAt', 'desc'), limit(shown)), (s) => {
      messages = s.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
      full = s.size >= shown;
      draw();
      if (first) { first = false; log.scrollTop = log.scrollHeight; }
    }, (err) => { console.warn('dm messages', err.code, err.message); stop = null; draw(); }); // no conversation yet: starts with the first message
    stopConv?.();
    stopConv = onSnapshot(convRef, (s) => {
      conv = s.data({ serverTimestamps: 'estimate' }) ?? null;
      // Reading it here counts as read: once per new message (lastId), never while a write is pending.
      if (conv && !s.metadata.hasPendingWrites && isUnread(conv, ctx.uid) && markedFor !== conv.lastId) {
        markedFor = conv.lastId;
        updateDoc(convRef, { [`readAt.${ctx.uid}`]: serverTimestamp() }).catch((err) => console.warn('dm read mark', err.code, err.message));
      }
    }, (err) => { console.warn('dm conv', err.code, err.message); stopConv = null; });
  }
  if (conv) listen(); else draw();

  const hideBtn = el('button', { class: 'link', type: 'button', onclick: async () => {
    if (!conv) { location.hash = 'crew'; return; }
    try { await updateDoc(convRef, { [`hidden.${ctx.uid}`]: serverTimestamp() }); location.hash = 'crew'; } catch { alert('Couldn’t hide it.'); }
  } }, 'Hide from my list');

  // ---- safety code, and a warning when their lock has changed since I last checked ----
  const extras = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  if (otherPub) {
    const myPub = await pubOf(ctx.uid);
    const code = await safetyCode(myPub, otherPub);
    const seenKey = `gt-dm-lock:${ctx.uid}:${otherUid}`;
    let seen = null;
    try { seen = localStorage.getItem(seenKey); } catch { /* private mode */ }
    const remember = () => { try { localStorage.setItem(seenKey, otherPub.kid); } catch { /* fine */ } };
    const codeBox = el('div', { class: 'panel form small', hidden: true },
      el('p', { style: 'margin:0 0 6px' }, `Safety code for you and ${name}:`),
      el('p', { style: 'margin:0 0 6px;font:22px var(--b-mono);letter-spacing:2px;color:var(--b-ink)' }, code),
      el('p', { class: 'muted', style: 'margin:0' }, `${name} sees a code on their phone too. Compare them in person or on a call. If they match, nobody (not even the server) is in the middle reading your messages.`));
    const codeBtn = el('button', { class: 'link', type: 'button', onclick: () => { codeBox.hidden = !codeBox.hidden; remember(); } }, 'Safety code');
    extras.append(el('div', {}, codeBtn), codeBox);
    if (!seen) remember();
    else if (seen !== otherPub.kid) {
      const warn = el('p', { class: 'mutedline', role: 'alert', style: 'padding:8px 0' },
        `⚠ ${name}’s lock changed. That's normal if they started over with a new passphrase. To be sure nobody's listening in, compare the safety code with them. `,
        el('button', { class: 'link', type: 'button', onclick: () => { remember(); warn.remove(); codeBox.hidden = false; } }, 'Show the code'));
      extras.prepend(warn);
    }
  }

  ctx.refresh = drawState;
  ctx.refreshKeepsInputs = true;
  ctx.cleanup = () => {
    stop?.(); stopConv?.(); document.body.classList.remove('chatmode'); foot.hidden = false;
    photos.forEach((p) => p.then((u) => URL.revokeObjectURL(u)).catch(() => {}));
  };
  ctx.main.replaceChildren(
    el('div', { class: 'chatinfo', style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap' },
      el('span', {}, el('a', { href: '#crew', class: 'link', style: 'min-height:32px;margin-right:10px' }, '← Crew'), '🔒 Encrypted. Only you and ', el('b', {}, name), ' can read this.'),
      hideBtn),
    extras, log, el('div', { class: 'chatbottom' }, gone, status, form));
  drawState();
  if (!form.hidden) input.focus({ preventScroll: true });
}

/** The Message button for a Crew row. */
export const messageButton = (m) => el('a', { class: 'btn sm', href: `#dm/${m.uid}`, 'aria-label': `Message ${m.handle}` }, 'Message');
