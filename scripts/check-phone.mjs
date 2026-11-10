// check-phone.mjs: loads every page at phone widths and reports layout problems.
//
// Run with:  npm run check:phone
// (starts the local emulators, fills them with sample data, opens each page as
//  a guest, a member and the sysop at 360px and 390px wide)
//
// Checks on every page:
//   - no sideways scrolling (page wider than the screen)
//   - nothing sticking out past the right edge
//   - buttons, links and fields are at least 44px tall (easy to tap); plain
//     links inside sentences and in posts are skipped, as is usual
//   - every form field has a label
// Screenshots go to check-phone-output/ so you can look through them.
// First time on a new computer:  npx playwright install chromium

import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const OUT = 'check-phone-output';
const WIDTHS = [360, 390];
const PORT = 5174;
const BASE = `http://localhost:${PORT}`;

initializeApp({ projectId: 'demo-garage-terminal' });
const db = getFirestore();

// ---------- sample data ------------------------------------------------------------

const ago = (min) => Timestamp.fromMillis(Date.now() - min * 60 * 1000);
const LONG_WORD = 'Supercalifragilisticexpialidocious_part_number_16100-ZH8-W61-carburetor-assembly';

async function seedData(uids) {
  const batch = db.batch();
  const set = (path, data) => batch.set(db.doc(path), data);
  [['general', '[1]', 'General', 1], ['app-support', '[2]', 'App Support', 2], ['releases', '[3]', 'Releases', 3],
    ['wiki-requests', '[4]', 'Wiki Requests', 4], ['off-topic', '[5]', 'Off-Topic', 5]]
    .forEach(([id, key, name, order]) => set(`areas/${id}`, { key, name, order }));
  set('settings/site', { sysopNotice: 'Welcome to the board. **Be nice**, stay on topic.', forumOpen: true, bannedWords: ['spammy'] });

  const people = { boss: ['Boss', 'sysop'], bob: ['Bob_The_Builder_99', 'member'], muted: ['QuietOne', 'member'] };
  for (const [key, [handle]] of Object.entries(people)) {
    set(`users/${uids[key]}`, { handle, createdAt: ago(60 * 24), status: key === 'muted' ? 'muted' : 'active', postCount: 3 });
    set(`handles/${handle.toLowerCase()}`, { uid: uids[key] });
    set(`private/${uids[key]}`, { email: `${key}@example.com` });
  }
  set(`admins/${uids.boss}`, { addedAt: ago(60) });

  const thread = (id, title, extra = {}) => set(`threads/${id}`, {
    areaId: 'general', title, authorUid: uids.bob, authorHandle: 'Bob_The_Builder_99', authorRole: 'member',
    createdAt: ago(120), lastReplyAt: ago(5), replyCount: 2, pinned: false, locked: false, hidden: false, ...extra,
  });
  const post = (tid, pid, body, extra = {}) => set(`threads/${tid}/posts/${pid}`, {
    authorUid: uids.bob, authorHandle: 'Bob_The_Builder_99', authorRole: 'member', body, createdAt: ago(100), hidden: false, ...extra,
  });
  thread('t1', `Carb rebuild on a GX160: idle hunts after cleaning ${LONG_WORD}`, { pinned: true });
  post('t1', 'op', `Rebuilt it, still hunts.\n\n\`\`\`\nidle screw: 1.5 turns out\npilot jet: 38 (stock)\n\`\`\`\n\n| Part | No. |\n|---|---|\n| Gasket kit | 16010-ZE1-812 |\n| Float | 16013-ZE1-811 |\n\nPart: ${LONG_WORD}`);
  post('t1', 'r1', 'Check the **pilot jet** with a strand of wire.\n\n> quote from the manual', { authorUid: uids.boss, authorHandle: 'Boss', authorRole: 'sysop', createdAt: ago(10), editedAt: ago(9) });
  post('t1', 'r2', 'Hidden spam reply', { hidden: true, hiddenReason: 'spam', createdAt: ago(5) });
  thread('t2', 'Locked thread', { locked: true, areaId: 'releases' });
  post('t2', 'op', 'Release notes.');
  thread('t3', 'Held for review: spammy title', { hidden: true, held: true });
  post('t3', 'op', 'spammy');
  set(`reports/t1__op__${uids.muted}`, { threadId: 't1', postId: 'op', reporterUid: uids.muted, reporterHandle: 'QuietOne', reason: 'off-topic', note: 'Not sure this belongs here', createdAt: ago(3), status: 'open' });
  set('modlog/m1', { action: 'thread.pin', targetPath: 'threads/t1', byUid: uids.boss, byHandle: 'Boss', reason: 'useful', details: { pinned: true }, createdAt: ago(2) });

  const lib = (slug, extra) => set(`library/${slug}`, {
    slug, title: 'Honda GX160 Service Manual', folder: 'manuals', kind: 'page', type: 'GUIDE',
    description: 'Factory service manual: carb, valves, governor and specs.', body: '', storagePath: '', fileName: '',
    size: 0, contentType: '', status: 'published', createdAt: ago(300), updatedAt: ago(30), updatedBy: uids.boss, ...extra,
  });
  lib('gx160-manual', { kind: 'file', type: 'PDF', storagePath: 'library/gx160-manual/GX160_shop_manual_rev3_final.pdf', fileName: 'GX160_shop_manual_rev3_final.pdf', size: 4404019 });
  lib('carb-guide', { title: `Carb rebuild guide ${LONG_WORD}`, body: `## Tools\n\n- 10mm socket\n\n| Step | Torque |\n|---|---|\n| Bowl | 5 Nm |\n\n\`\`\`\n${'long code line '.repeat(12)}\n\`\`\`` });
  lib('draft-notes', { title: 'Draft notes', status: 'draft', body: 'wip' });
  await batch.commit();
}

// ---------- signing in (auth emulator accepts a fake Google credential) -------------

async function signIn(page, email) {
  await page.goto(`${BASE}/join`);
  await page.waitForSelector('#session[data-state]:not([data-state="loading"])');
  return page.evaluate(async (email) => {
    const { auth } = await import('/src/lib/firebase.js');
    const a = await import('/node_modules/.vite/deps/firebase_auth.js'); // the copy the dev server serves
    const cred = a.GoogleAuthProvider.credential(JSON.stringify({ sub: email, email, email_verified: true }));
    return (await a.signInWithCredential(auth, cred)).user.uid;
  }, email);
}

// ---------- the checks, run inside the page ------------------------------------------

function inspect() {
  const problems = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) {
    problems.push(`page scrolls sideways (${document.documentElement.scrollWidth}px wide on a ${vw}px screen)`);
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('[hidden], dialog:not([open])');
  };
  const describe = (el) => `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}> "${(el.textContent || el.value || el.placeholder || '').trim().slice(0, 30)}"`;

  // Things sticking out past the right edge (ignoring content inside scroll boxes).
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('pre, table, .mod-excerpt, .md table')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && getComputedStyle(el).position !== 'fixed') {
      problems.push(`sticks out past the edge by ${Math.round(r.right - vw)}px: ${describe(el)}`);
      break; // one is enough to point at the problem
    }
  }

  // Tap targets.
  for (const el of document.querySelectorAll('a, button, input, select, textarea, summary, [role=button]')) {
    if (!visible(el)) continue;
    if (el.closest('.md')) continue; // links inside posts/pages are part of the text
    const s = getComputedStyle(el);
    if (el.tagName === 'A' && s.display === 'inline' && el.closest('p, li, dd, span')) continue; // link in a sentence
    if (el.type === 'checkbox' || el.type === 'radio') {
      const label = el.closest('label');
      if (label && label.getBoundingClientRect().height >= 44) continue;
    }
    if (el.classList.contains('logo')) continue;
    const h = el.getBoundingClientRect().height;
    if (h < 43.5) problems.push(`small tap target (${Math.round(h)}px tall): ${describe(el)}`);
  }

  // Labels for form fields.
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (!visible(el) || el.type === 'hidden') continue;
    const labelled = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label')
      || (el.id && document.querySelector(`label[for="${el.id}"]`));
    if (!labelled) problems.push(`form field without a label: ${describe(el)}`);
  }
  return problems;
}

// ---------- main ------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
let failures = 0;

try {
  // Create the accounts by signing in once each, then seed data for them.
  const uids = {};
  for (const who of ['boss', 'bob', 'muted']) {
    const ctx = await browser.newContext();
    uids[who] = await signIn(await ctx.newPage(), `${who}@example.com`);
    await ctx.close();
  }
  await seedData(uids);

  const PAGES = {
    guest: ['/', '/forum', '/forum?area=releases', '/forum/t/t1', '/forum/t/t2', '/forum/t/missing', '/forum/new', '/join',
      '/wiki', '/wiki?q=zzz', '/wiki/gx160-manual', '/wiki/carb-guide', '/wiki/missing', '/mod', '/404.html'],
    bob: ['/forum', '/forum/t/t1', '/forum/new', '/join', '/wiki/add'],
    muted: ['/forum', '/forum/t/t1'],
    boss: ['/', '/forum', '/forum/t/t1', '/forum/t/t3', '/forum/new', '/mod#overview', '/mod#reports', '/mod#held',
      '/mod#members', '/mod#settings', '/mod#log', '/wiki', '/wiki/draft-notes', '/wiki/add', '/wiki/add?edit=carb-guide'],
  };

  for (const [who, paths] of Object.entries(PAGES)) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      if (who !== 'guest') await signIn(page, `${who}@example.com`);
      for (const path of paths) {
        await page.goto(BASE + path);
        if (path.startsWith('/mod#')) await page.reload(); // hash-only change: load the tab fresh
        await page.waitForSelector('#session[data-state]:not([data-state="loading"])', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1200); // let lists and live data render
        const problems = await page.evaluate(inspect);
        const name = `${who}${path.replace(/[^a-z0-9]+/gi, '_')}-${width}`.replace(/_+$/, '');
        await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
        if (problems.length) {
          failures += problems.length;
          console.log(`✗ ${who} ${path} @${width}px`);
          for (const p of [...new Set(problems)]) console.log(`    - ${p}`);
        } else {
          console.log(`✓ ${who} ${path} @${width}px`);
        }
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} problem(s) found. Screenshots: ${OUT}/` : `\nAll pages look fine at ${WIDTHS.join(' and ')}px. Screenshots: ${OUT}/`);
process.exit(failures ? 1 : 0);
