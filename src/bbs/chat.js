// chat.js: Shop Talk (#chat), one live room for all members. Design: reference/bbs-design/Chat.dc.html
//
//   - "● N here" in the header; "Messages clear after 7 days. Tap a message to save it to a board."
//   - messages with handle and time, yours on the right with an orange outline; system lines
//     ("9:05p · Mia walked into the shop"); "[handle] is typing█"; photo button, "Talk shop…", send
//   - the latest 100 messages, more when you scroll to the top
//   - tap a message: Save to a board (Shop Notes first), Quote in a new post, Reply; for the sysop
//     and co-sysops also Delete message and Mute for 1 hour / 1 day / until unmuted
// Messages are deleted after 7 days by a Cloud Function (bbsChatCleanup). Muted members can read
// but not send (firestore.rules).

import { el } from '../lib/ui.js';
import { bbsAction, isHere } from '../lib/bbs.js';
import { deleteChat, fileUrl, sayJoined, sendChat, setTyping, watchChat, watchTyping } from './data.js';

const PAGE = 100;
const CAMERA = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>';
const SEND = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2-6z"/></svg>';
const BOOKMARK = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';

const toDate = (ts) => (ts?.toDate ? ts.toDate() : new Date());
/** "9:05p" */
export function clock(ts) {
  const d = toDate(ts);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'a' : 'p'}`;
}
function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const n = Math.round((today - that) / 86400000);
  if (n === 0) return new Date().getHours() >= 17 && d.getHours() >= 17 ? 'Tonight' : 'Today';
  if (n === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
const shortLink = (u) => u.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 48) + (u.replace(/^https?:\/\/(www\.)?/i, '').length > 48 ? '…' : '');
const mutedUntil = (m) => (m?.mutedUntil?.toMillis && m.mutedUntil.toMillis() > Date.now() ? m.mutedUntil.toDate() : null);

export async function renderChat(ctx) {
  // ---- chat screen chrome: the header says Shop Talk with "● N here"; no footer ----
  document.body.classList.add('chatmode');
  const title = document.getElementById('b-title'), here = document.getElementById('b-here'), foot = document.getElementById('b-foot');
  title.textContent = 'Shop Talk';
  document.getElementById('b-eyebrow').textContent = 'THE GARAGE_TERMINAL BBS';
  foot.hidden = true;
  const drawHere = () => {
    const n = ctx.crew.filter((m) => isHere(m)).length;
    here.replaceChildren(el('span', { class: 'dot', 'aria-hidden': 'true' }, '●'), ` ${n} here`);
    here.hidden = false;
  };
  drawHere();

  let messages = [], shown = PAGE, full = false, replyTo = null, joined = false, firstLoad = true;
  const typingUntil = new Map();

  const log = el('div', { class: 'chatlog', role: 'log', 'aria-label': 'Chat messages', 'aria-live': 'polite' });
  const typingLine = el('div', { class: 'sys typing', 'aria-live': 'off' });
  const toast = el('div', { class: 'ctoast', role: 'status', hidden: true });
  const replyBar = el('div', { class: 'replybar', hidden: true });
  const mutedLine = el('p', { class: 'mutedline', hidden: true });

  // ---- composer ----
  const input = el('input', { id: 'msg', type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Talk shop…', maxlength: '2000', enterkeyhint: 'send' });
  const pick = el('input', { type: 'file', accept: 'image/*', class: 'sr', id: 'chat-photo', tabindex: '-1' });
  const photoBtn = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Add a photo', onclick: () => pick.click() });
  photoBtn.innerHTML = CAMERA;
  const sendBtn = el('button', { class: 'sendbtn', type: 'submit', 'aria-label': 'Send' });
  sendBtn.innerHTML = SEND;
  const status = el('p', { class: 'small chatstatus', role: 'status' });
  const form = el('form', { class: 'chatform' }, el('label', { for: 'msg', class: 'sr' }, 'Message'), photoBtn, pick, input, sendBtn);
  pick.addEventListener('change', () => {
    if (pick.files[0]) { status.textContent = `Photo ready: ${pick.files[0].name}. Add words or tap send.`; input.focus(); }
  });
  let lastTyping = 0;
  input.addEventListener('input', () => {
    if (Date.now() - lastTyping > 3000 && input.value.trim()) { lastTyping = Date.now(); setTyping(ctx.uid, ctx.handle); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const photoFile = pick.files[0] || null;
    if (!text && !photoFile) return;
    sendBtn.disabled = true;
    try {
      await sendChat({ uid: ctx.uid, handle: ctx.handle, text, photoFile,
        reply: replyTo ? { who: replyTo.handle, text: (replyTo.text || '[photo]').slice(0, 140) } : null,
        onProgress: (p) => { status.textContent = `Sending the photo… ${Math.round(p * 100)}%`; } });
      input.value = ''; pick.value = ''; status.textContent = '';
      setReply(null);
      stickToBottom = true;
    } catch (err) {
      status.textContent = /permission/i.test(err.code || err.message) ? 'You can’t send right now (muted?).' : (err.message || 'Couldn’t send. Try again.');
    } finally { sendBtn.disabled = false; input.focus(); }
  });

  function setReply(m) {
    replyTo = m;
    replyBar.hidden = !m;
    if (m) {
      replyBar.replaceChildren(el('span', { class: 'small' }, el('b', { class: 'mono' }, `↩ ${m.handle}: `), (m.text || '[photo]').slice(0, 80)),
        el('button', { class: 'link', type: 'button', 'aria-label': 'Cancel reply', onclick: () => setReply(null) }, '✕'));
      input.focus();
    }
  }

  // ---- muted? ----
  const drawMuted = () => {
    const until = !ctx.isSysop && mutedUntil(ctx.me);
    mutedLine.hidden = !until;
    form.hidden = !!until;
    if (until) mutedLine.textContent = until.getFullYear() >= 2100 ? 'You’re muted in Shop Talk until the sysop unmutes you. You can still read.'
      : `You’re muted in Shop Talk until ${until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. You can still read.`;
  };

  // ---- messages ----
  let stickToBottom = true;
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.addEventListener('scroll', () => {
    stickToBottom = nearBottom();
    if (log.scrollTop < 40 && full) { full = false; shown += PAGE; subscribe(true); }
  });

  function bubble(m) {
    const mine = m.uid === ctx.uid;
    const btn = el('button', { class: `bubble${mine ? ' mine' : ''}`, type: 'button', 'aria-label': `Message from ${m.handle} at ${clock(m.createdAt)}. Options`, onclick: () => openSheet(m) });
    if (m.reply) btn.append(el('span', { class: 'rq' }, `↩ ${m.reply.who}: ${m.reply.text}`));
    if (m.text) btn.append(el('span', { class: 'btext' }, m.text));
    if (m.photo?.path) {
      const img = el('img', { class: 'cphoto', alt: `Photo from ${m.handle}`, width: m.photo.w, height: m.photo.h, loading: 'lazy' });
      fileUrl(m.photo.path).then((u) => { img.src = u; }).catch(() => img.replaceWith(el('span', { class: 'small dim' }, '[photo unavailable]')));
      btn.append(img);
    }
    return el('div', { class: `crow${mine ? ' mine' : ''}`, id: `m-${m.id}` },
      el('div', { class: 'cmeta' }, el('span', { class: `chandle${mine ? ' mine' : ''}` }, m.handle), el('span', { class: 'ctime' }, clock(m.createdAt)),
        m.savedTo ? el('span', { class: 'savedtag' }, '★ saved') : null),
      btn,
      m.link ? el('a', { class: 'clink', href: m.link, target: '_blank', rel: 'nofollow ugc noopener noreferrer' }, shortLink(m.link)) : null);
  }

  function draw() {
    const atBottom = stickToBottom || nearBottom();
    const fromBottom = log.scrollHeight - log.scrollTop;
    const out = [];
    if (full) out.push(el('p', { class: 'sys center' }, 'Scroll up for older messages'));
    let day = '';
    for (const m of messages) {
      const d = toDate(m.createdAt);
      const label = dayLabel(d);
      if (label !== day) { day = label; out.push(el('div', { class: 'sys center' }, `— ${label} —`)); }
      out.push(m.kind === 'join' ? el('div', { class: 'sys' }, `${clock(m.createdAt)} · ${m.handle} walked into the shop`) : bubble(m));
    }
    if (!messages.length) out.push(el('p', { class: 'sys center' }, 'Quiet in here. Say something.'));
    log.replaceChildren(...out);
    if (atBottom) log.scrollTop = log.scrollHeight;
    else log.scrollTop = log.scrollHeight - fromBottom;
  }

  let stopChat = null;
  function subscribe(keepPlace) {
    stopChat?.();
    stopChat = watchChat(shown, (list, size) => {
      messages = list;
      full = size >= shown;
      if (!keepPlace) stickToBottom = stickToBottom || firstLoad;
      draw();
      if (firstLoad) {
        firstLoad = false;
        log.scrollTop = log.scrollHeight;
        // "[handle] walked into the shop", at most once every 30 minutes
        const recent = messages.some((m) => m.kind === 'join' && m.uid === ctx.uid && Date.now() - toDate(m.createdAt).getTime() < 30 * 60000);
        if (!recent && !joined && !mutedUntil(ctx.me)) { joined = true; sayJoined(ctx.uid, ctx.handle).catch(() => {}); }
      }
    }, () => log.replaceChildren(el('p', { class: 'err' }, 'Couldn’t load Shop Talk.')));
  }

  // ---- typing ----
  const stopTyping = watchTyping((snap) => {
    snap.docChanges().forEach((c) => {
      const t = c.doc.data();
      if (c.doc.id === ctx.uid || c.type === 'removed') return;
      const at = t.at?.toMillis ? t.at.toMillis() : Date.now();
      if (Date.now() - at < 8000) typingUntil.set(t.handle, Date.now() + 5000);
    });
    drawTyping();
  }, () => {});
  function drawTyping() {
    const now = Date.now();
    const who = [...typingUntil].filter(([, until]) => until > now).map(([h]) => h);
    typingLine.replaceChildren(...(who.length ? [`${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing`, el('span', { class: 'cur-blink', 'aria-hidden': 'true' }, '█')] : []));
  }
  const tick = setInterval(drawTyping, 1000);

  // ---- the message sheet ----
  let sheetEl = null, toastTimer = 0;
  function closeSheet() { sheetEl?.remove(); sheetEl = null; }
  function showToast(text, href) {
    toast.replaceChildren(el('span', {}, text), href ? el('a', { href }, 'View') : null);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }
  function openSheet(m, mode = 'menu') {
    closeSheet();
    const quote = el('div', { class: 'squote' }, el('span', { class: 'mono small', style: 'font-weight:700;color:var(--b-amber)' }, `${m.handle} · ${clock(m.createdAt)}`),
      el('span', { style: 'font-size:14px;overflow-wrap:anywhere' }, m.text || '[photo]'));
    const box = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Message options' }, quote);
    const bigBtn = (label, onclick, cls = 'btn') => el('button', { class: cls, type: 'button', onclick, style: 'min-height:48px' }, label);
    if (mode === 'pick') {
      const open = ctx.boards.filter((b) => !b.archived);
      const ordered = [...open.filter((b) => b.id === 'shop-notes'), ...open.filter((b) => b.id !== 'shop-notes')];
      let chosen = ordered[0]?.id;
      const grid = el('div', { class: 'boardpick' });
      const drawGrid = () => grid.replaceChildren(...ordered.map((b) => el('button', { type: 'button', class: `bpick${b.id === chosen ? ' on' : ''}`, 'aria-pressed': String(b.id === chosen), onclick: () => { chosen = b.id; drawGrid(); } }, b.name)));
      drawGrid();
      const note = el('input', { class: 'input', id: 'save-note', maxlength: '500', placeholder: 'Why it’s worth keeping', autocomplete: 'off' });
      const err = el('p', { class: 'err', role: 'alert', hidden: true });
      const save = bigBtn('Save', async () => {
        if (!chosen) return;
        save.disabled = true;
        try {
          const r = await bbsAction('chat.save', { chatId: m.id, boardId: chosen, note: note.value.trim() });
          closeSheet();
          showToast(`Saved to ${r.boardName}`, `#t/${r.threadId}`);
        } catch (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; }
      }, 'btn primary');
      box.append(el('h2', { class: 'sh', style: 'font-size:20px' }, 'Save to which board?'), grid,
        el('label', { for: 'save-note', class: 'muted', style: 'display:flex;flex-direction:column;gap:4px;font-size:14px' }, 'Add a note (optional)', note),
        el('span', { class: 'small dim' }, 'It becomes a post on that board, with the photo and link, credited to the person who said it. It stays after the chat clears.'),
        err, el('div', { class: 'two' }, bigBtn('Cancel', closeSheet), save));
    } else {
      const saveBtn = bigBtn('', () => openSheet(m, 'pick'), 'btn primary big');
      saveBtn.innerHTML = BOOKMARK;
      saveBtn.append(m.savedTo ? 'Save to a board (again)' : 'Save to a board');
      box.append(saveBtn,
        bigBtn('Quote in a new post', () => {
          closeSheet();
          ctx.draft = { body: `> **${m.handle}** · ${clock(m.createdAt)}\n> ${(m.text || '[photo]').replace(/\n/g, '\n> ')}\n\n` };
          location.hash = 'new/shop-notes';
        }, 'btn outline'),
        bigBtn('Reply', () => { closeSheet(); setReply(m); }));
      if (ctx.isMod) {
        const target = ctx.crew.find((c) => c.uid === m.uid);
        const canMute = target && target.role !== 'sysop' && m.uid !== ctx.uid && (ctx.isSysop || target.role !== 'cosysop');
        box.append(el('div', { class: 'modtools' },
          el('span', { class: 'mono small', style: 'color:var(--b-amber)' }, 'SYSOP TOOLS'),
          bigBtn('Delete message', async () => {
            if (!confirm('Delete this message for everyone?')) return;
            try { await deleteChat(m.id); closeSheet(); } catch { alert('Couldn’t delete it.'); }
          }, 'btn danger'),
          canMute ? (mutedUntil(target)
            ? bigBtn(`Unmute ${m.handle}`, () => mute(m, target, 0))
            : el('div', { class: 'mutes' }, el('span', { class: 'small muted' }, `Mute ${m.handle}:`),
              bigBtn('1 hour', () => mute(m, target, 60)), bigBtn('1 day', () => mute(m, target, 1440)), bigBtn('Until unmuted', () => mute(m, target, null)))) : null));
      }
      box.append(el('button', { class: 'link', type: 'button', style: 'align-self:center;color:var(--b-dim)', onclick: closeSheet }, 'Close'));
    }
    sheetEl = el('div', { class: 'sheetwrap', onclick: (e) => { if (e.target === sheetEl) closeSheet(); } }, box);
    sheetEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    document.body.append(sheetEl);
    box.querySelector('button')?.focus();
  }
  async function mute(m, target, minutes) {
    try {
      await bbsAction('member.mute', { uid: target.uid, minutes });
      closeSheet();
      showToast(minutes === 0 ? `${m.handle} can talk again` : `${m.handle} is muted`);
    } catch (e) { alert(e.message); }
  }

  ctx.refresh = () => { drawHere(); drawMuted(); };
  ctx.refreshKeepsInputs = true; // only the header count and the muted line change
  ctx.cleanup = () => {
    stopChat?.(); stopTyping(); clearInterval(tick); closeSheet();
    document.body.classList.remove('chatmode');
    foot.hidden = false;
  };
  ctx.main.replaceChildren(
    el('div', { class: 'chatinfo' }, 'Messages clear after ', el('b', {}, '7 days'), '. Tap a message to save it to a board.'),
    log, typingLine, toast, el('div', { class: 'chatbottom' }, mutedLine, replyBar, status, form));
  drawMuted();
  subscribe(false);
  if (!form.hidden) input.focus({ preventScroll: true });
}
