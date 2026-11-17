// dm.js: private messages between two members (#dm/<uid>), and the conversation list on the
// Crew tab. Only the two members can read a conversation, not even the sysop (firestore.rules,
// bbsDms). Kept until deleted: you can delete your own messages, and hide a conversation from
// your own list (it comes back when a new message arrives).
import {
  collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { ref as sref, uploadBytesResumable } from 'firebase/storage';
import { db, storage } from '../lib/firebase.js';
import { shrinkPhoto } from '../lib/photo.js';
import { el, timeAgo } from '../lib/ui.js';
import { isHere } from '../lib/bbs.js';
import { fileUrl } from './data.js';
import { clock } from './chat.js';

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

const preview = (text, photo) => (text ? text.replace(/\s+/g, ' ').slice(0, 100) : photo ? '[photo]' : '');

async function send({ me, handle, other, otherHandle, text, file, onProgress }) {
  const id = convIdOf(me, other);
  const convRef = doc(db, 'bbsDms', id);
  const exists = (await getDoc(convRef).catch(() => null))?.exists();
  if (!exists) {
    // The conversation has to exist before a photo can be stored under it (storage.rules).
    await setDoc(convRef, {
      members: [me, other].sort(), handles: { [me]: handle, [other]: otherHandle },
      lastAt: serverTimestamp(), lastText: '', lastBy: me, lastId: '', readAt: { [me]: serverTimestamp() }, hidden: {},
    });
  }
  const msgRef = doc(collection(convRef, 'messages'));
  let photo = null;
  if (file) {
    const { blob, w, h } = await shrinkPhoto(file, 1280);
    photo = { path: `bbs/dm/${me}/${id}/${msgRef.id}.jpg`, w, h };
    await new Promise((resolve, reject) => {
      const task = uploadBytesResumable(sref(storage, photo.path), blob, { contentType: 'image/jpeg' });
      task.on('state_changed', (s) => onProgress?.(s.bytesTransferred / s.totalBytes), reject, resolve);
    });
  }
  const b = writeBatch(db);
  b.set(msgRef, { uid: me, handle, text, createdAt: serverTimestamp(), ...(photo ? { photo } : {}) });
  b.update(convRef, { lastAt: serverTimestamp(), lastText: preview(text, photo), lastBy: me, lastId: msgRef.id, [`readAt.${me}`]: serverTimestamp() });
  await b.commit();
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
        el('span', { class: 'small muted', style: 'overflow-wrap:anywhere' }, `${c.lastBy === ctx.uid ? 'You: ' : ''}${c.lastText || '…'} · ${timeAgo(c.lastAt)}`)),
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

  document.body.classList.add('chatmode');
  const foot = document.getElementById('b-foot');
  foot.hidden = true;
  document.getElementById('b-title').textContent = name;
  document.getElementById('b-eyebrow').textContent = 'PRIVATE MESSAGE';
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
    if (!text && !file) return;
    sendBtn.disabled = true;
    try {
      await send({ me: ctx.uid, handle: ctx.handle, other: otherUid, otherHandle: name, text, file,
        onProgress: (p) => { status.textContent = `Sending the photo… ${Math.round(p * 100)}%`; } });
      input.value = ''; pick.value = ''; status.textContent = ''; stick = true;
      if (!stop) listen();
    } catch (err) {
      console.error(err);
      status.textContent = /permission/i.test(err.code || err.message) ? 'You can’t send this right now.' : (err.message || 'Couldn’t send. Try again.');
    } finally { sendBtn.disabled = false; input.focus(); }
  });

  const drawState = () => {
    const muted = !ctx.isSysop && ctx.me?.mutedUntil?.toMillis && ctx.me.mutedUntil.toMillis() > Date.now();
    const left = !ctx.crew.some((m) => m.uid === otherUid);
    gone.hidden = !(muted || left);
    gone.textContent = left ? `${name} isn’t in the BBS any more, so you can’t send new messages.` : 'You’re muted, so you can’t send messages right now. You can still read.';
    form.hidden = muted || left;
  };

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.addEventListener('scroll', () => {
    stick = nearBottom();
    if (log.scrollTop < 40 && full) { full = false; shown += PAGE; listen(); }
  });

  function bubble(m) {
    const mine = m.uid === ctx.uid;
    const b = el(mine ? 'button' : 'div', { class: `bubble${mine ? ' mine' : ''}`, ...(mine ? { type: 'button', 'aria-label': `Your message at ${clock(m.createdAt)}. Delete` } : {}) });
    if (mine) {
      b.addEventListener('click', async () => {
        if (!confirm('Delete this message? It’s removed for both of you.')) return;
        try {
          await deleteDoc(doc(db, 'bbsDms', id, 'messages', m.id));
          if (conv?.lastId === m.id || messages[messages.length - 1]?.id === m.id) {
            await updateDoc(convRef, { lastText: 'Message deleted' }).catch(() => {});
          }
        } catch { alert('Couldn’t delete it.'); }
      });
    }
    if (m.text) b.append(el('span', { class: 'btext' }, m.text));
    if (m.photo?.path) {
      const img = el('img', { class: 'cphoto', alt: `Photo from ${m.handle}`, width: m.photo.w, height: m.photo.h, loading: 'lazy' });
      fileUrl(m.photo.path).then((u) => { img.src = u; }).catch(() => img.replaceWith(el('span', { class: 'small dim' }, '[photo unavailable]')));
      b.append(img);
    }
    const link = (m.text?.match(/https?:\/\/[^\s<>"]+/i) || [])[0];
    return el('div', { class: `crow${mine ? ' mine' : ''}` },
      el('div', { class: 'cmeta' }, el('span', { class: `chandle${mine ? ' mine' : ''}` }, m.handle), el('span', { class: 'ctime' }, clock(m.createdAt))),
      b,
      link ? el('a', { class: 'clink', href: link, target: '_blank', rel: 'nofollow ugc noopener noreferrer' }, link.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 48)) : null);
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

  ctx.refresh = drawState;
  ctx.refreshKeepsInputs = true;
  ctx.cleanup = () => { stop?.(); stopConv?.(); document.body.classList.remove('chatmode'); foot.hidden = false; };
  ctx.main.replaceChildren(
    el('div', { class: 'chatinfo', style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap' },
      el('span', {}, el('a', { href: '#crew', class: 'link', style: 'min-height:32px;margin-right:10px' }, '← Crew'), 'Only you and ', el('b', {}, name), ' can read this.'),
      hideBtn),
    log, el('div', { class: 'chatbottom' }, gone, status, form));
  drawState();
  if (!form.hidden) input.focus({ preventScroll: true });
}

/** The Message button for a Crew row. */
export const messageButton = (m) => el('a', { class: 'btn sm', href: `#dm/${m.uid}`, 'aria-label': `Message ${m.handle}` }, 'Message');
