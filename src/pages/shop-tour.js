// The shop app's guided tour: dims the screen, cuts a lit hole around one thing (a tab, a button,
// a card) and shows a note next to it with Back / Next / Skip. shop.js builds the steps for who is
// signed in (owner or employee) and starts it the first time, and from Settings → Take the tour.
// A step: { tab?, target?: CSS selector or () => element, title, text (HTML), link? {href, label} }.
// A step whose target isn't on screen shows its note in the middle instead.

let box = null;
let state = null;

const $el = (t) => (typeof t === 'function' ? t() : t ? document.querySelector(t) : null);
const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

function close(done) {
  if (!box) return;
  box.remove(); box = null;
  window.removeEventListener('resize', place);
  document.removeEventListener('keydown', onKey, true);
  const s = state; state = null;
  if (s && s.onEnd) s.onEnd(done);
}

function onKey(e) {
  if (!state) return;
  if (e.key === 'Escape') { e.preventDefault(); close(false); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(state.i + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(state.i - 1); }
}

function place() {
  if (!box || !state) return;
  const step = state.steps[state.i];
  const hole = box.querySelector('.tour-hole'), note = box.querySelector('.tour-note');
  const el = $el(step.target);
  const W = window.innerWidth, H = window.innerHeight, pad = 6, gap = 14;
  note.style.left = note.style.top = note.style.bottom = '';
  note.classList.remove('up', 'down', 'mid');
  if (!visible(el)) {
    hole.style.cssText = `left:${W / 2}px;top:${H / 2}px;width:0;height:0;`;
    note.classList.add('mid');
    return;
  }
  const r = el.getBoundingClientRect();
  const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
  const w = Math.min(W - 8, r.width + pad * 2), h = Math.min(H - 8, r.height + pad * 2);
  hole.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
  const nw = Math.min(W - 24, 360);
  const left = Math.min(Math.max(12, r.left + r.width / 2 - nw / 2), W - nw - 12);
  note.style.left = left + 'px';
  note.style.setProperty('--arrow', Math.min(Math.max(18, r.left + r.width / 2 - left), nw - 18) + 'px');
  // below the target when there's room (most of the screen), otherwise above it
  if (y + h + gap + 180 < H) { note.style.top = (y + h + gap) + 'px'; note.classList.add('down'); }
  else { note.style.bottom = (H - y + gap) + 'px'; note.classList.add('up'); }
}

function go(i) {
  if (!state) return;
  if (i < 0) return;
  if (i >= state.steps.length) { close(true); return; }
  state.i = i;
  const step = state.steps[i], n = state.steps.length;
  if (step.tab && state.show) state.show(step.tab);
  const note = box.querySelector('.tour-note');
  note.innerHTML = `<span class="tour-count">${i + 1} of ${n}</span>
    <h2 class="tour-title" id="tourTitle">${step.title}</h2>
    <div class="tour-text">${step.text}</div>
    ${step.link ? `<a class="tour-link" href="${step.link.href}" target="_blank" rel="noopener">${step.link.label}</a>` : ''}
    <div class="tour-btns">
      ${i < n - 1 ? '<button type="button" class="tour-skip" data-tour="skip">Skip tour</button>' : '<span></span>'}
      <span class="tour-nav">${i > 0 ? '<button type="button" class="sh-btn ghost" data-tour="back">Back</button>' : ''}<button type="button" class="sh-btn" data-tour="next">${i < n - 1 ? 'Next' : 'Done'}</button></span>
    </div>`;
  // let the tab draw first, then light up its target
  requestAnimationFrame(() => requestAnimationFrame(() => { place(); const b = note.querySelector('[data-tour=next]'); if (b) b.focus({ preventScroll: true }); }));
}

export function startTour({ steps, show, onEnd }) {
  if (!steps || !steps.length) return;
  close(false);
  state = { steps, show, onEnd, i: 0 };
  box = document.createElement('div');
  box.className = 'tour';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'tourTitle');
  box.innerHTML = '<div class="tour-hole" aria-hidden="true"></div><div class="tour-note" aria-live="polite"></div>';
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tour]');
    if (!b) return;
    if (b.dataset.tour === 'next') go(state.i + 1);
    else if (b.dataset.tour === 'back') go(state.i - 1);
    else if (b.dataset.tour === 'skip') close(false);
  });
  document.body.appendChild(box);
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey, true);
  go(0);
}

export const tourOpen = () => !!box;
