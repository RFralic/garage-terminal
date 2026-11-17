// door.js: the hidden way into the BBS, on every page that has the site footer.
//
// A dim ">_" sits at the right end of the footer, its "_" blinking like an idle
// cursor. Tapping it opens a one-line prompt in the footer:
//   - the door word (bbsConfig/main.doorWord, set by the sysop) -> /bbs
//   - anything else -> "command not found: <word>"
//   - Esc or tapping away closes it
// On a computer, typing the door word anywhere on the page (not in a text box)
// works too. Members who are already let in and signed in skip the word: the
// >_ takes them straight to /bbs.
//
// The door word isn't a secret (the repo is public); it only hides the door.
// The BBS itself is protected by firestore.rules. Firebase is loaded only when
// the door is used, so pages stay quick.

const DEFAULT_WORD = 'backroom';
const footer = document.querySelector('footer .wrap');

if (footer && !footer.querySelector('.door')) setUp();

function setUp() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'door';
  btn.setAttribute('aria-label', 'Command prompt');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span aria-hidden="true">&gt;<span class="door-cur">_</span></span>';

  const form = document.createElement('form');
  form.className = 'door-prompt';
  form.hidden = true;
  form.setAttribute('autocomplete', 'off');
  form.innerHTML = '<label class="door-line"><span aria-hidden="true">&gt;&nbsp;</span>'
    + '<input type="text" aria-label="Command" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="40" enterkeyhint="go"></label>'
    + '<p class="door-out" aria-live="polite"></p>';
  const input = form.querySelector('input');
  const out = form.querySelector('.door-out');

  footer.append(btn, form);

  let word = null; // the door word, once loaded
  let loading = null;
  const loadWord = () => loading ??= import('./firebase.js')
    .then(async ({ db }) => {
      const { doc, getDoc } = await import('firebase/firestore');
      const snap = await getDoc(doc(db, 'bbsConfig', 'main'));
      word = String(snap.data()?.doorWord || DEFAULT_WORD).toLowerCase();
    })
    .catch(() => { word = DEFAULT_WORD; });

  /** Already let in and signed in? Then go straight through. */
  let checked = false;
  async function memberGoesStraightIn() {
    if (checked) return;
    checked = true;
    try {
      const [{ watchSession }, { db }, { doc, getDoc }] = await Promise.all([
        import('./session.js'), import('./firebase.js'), import('firebase/firestore'),
      ]);
      const s = await new Promise((resolve) => {
        const stop = watchSession((x) => { if (x.state !== 'loading') { queueMicrotask(() => stop()); resolve(x); } });
      });
      if (s.state !== 'member') return;
      if (s.isSysop || (await getDoc(doc(db, 'bbsMembers', s.user.uid))).exists()) enter();
    } catch { /* not a member, or offline: the prompt stays */ }
  }

  const enter = () => { location.href = '/bbs'; };
  const open = () => {
    form.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    out.textContent = '';
    input.value = '';
    input.focus();
    loadWord();
    memberGoesStraightIn();
  };
  const close = () => {
    form.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', () => (form.hidden ? open() : close()));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const typed = input.value.trim();
    if (!typed) return;
    await loadWord();
    if (typed.toLowerCase() === word) return enter();
    out.textContent = `command not found: ${typed.slice(0, 40)}`;
    input.value = '';
  });
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); } });
  // Tapping away closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!form.hidden && !form.contains(e.target) && !btn.contains(e.target)) close();
  });
  form.addEventListener('focusout', () => setTimeout(() => {
    if (!form.hidden && !form.contains(document.activeElement) && document.activeElement !== btn) close();
  }, 0));

  // Typing the word anywhere (not in a text box) on a computer.
  let typed = '';
  let lastKey = 0;
  document.addEventListener('keydown', async (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    const t = e.target;
    if (t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (!/[a-z0-9]/i.test(e.key)) { typed = ''; return; }
    const now = Date.now();
    if (now - lastKey > 2000) typed = '';
    lastKey = now;
    typed = (typed + e.key.toLowerCase()).slice(-24);
    if (!word) await loadWord();
    if (word && typed.endsWith(word)) enter();
  });
}
