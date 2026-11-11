# Garage Terminal

Home page, open forum, wiki/library and sysop moderation tools, on Firebase.
The full spec and build phases are in [PLAN.md](PLAN.md).

Live site: https://garage-terminal-15499.web.app

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | Home page (ported from the original `garage-terminal.html` in Phase 1) |
| `forum/index.html` | Forum thread list (`src/pages/forum-list.js`) |
| `forum/thread.html` | One thread, served at `/forum/t/{id}` (`src/pages/thread.js`) |
| `forum/new.html` | New thread form (`src/pages/new-thread.js`) |
| `wiki/index.html` | Library list: search, folders (`src/pages/library-list.js`) |
| `wiki/doc.html` | One library item, served at `/wiki/{slug}` (`src/pages/library-doc.js`) |
| `wiki/add.html` | Sysop: upload a file or write a page; `?edit={slug}` to edit (`src/pages/library-add.js`) |
| `join/index.html` | Sign in with Google + pick a handle (`src/pages/join.js`) |
| `mod/index.html` | Sysop dashboard: reports, held posts, members, settings, mod log (`src/pages/mod.js`) |
| `apps/repclock/index.html` | RepClock, built from its Claude artifact by `scripts/import-repclock.mjs` (don't edit by hand) |
| `src/apps/repclock-sync.js` | Saves RepClock workouts and settings to the signed-in member's account |
| `apps/tap-drill-chart/index.html` | Tap Drill Chart, copied from its Claude artifact (re-copy if the artifact changes) |
| `404.html` | Not-found page |
| `src/styles/base.css` | Shared look: colors, fonts, header, footer, terminal boxes |
| `src/styles/home.css` | Home-page-only styles |
| `src/pages/app-filter.js` | Home `/apps` category buttons (All · Garage · Gym …), built from each card's `data-category` |
| `src/styles/forms.css` | Inputs, buttons, status lines |
| `src/lib/firebase.js` | Starts Firebase (live config from Hosting; emulators locally) |
| `src/lib/session.js` | Sign-in, sign-out, handle rules, claiming a handle |
| `src/lib/header.js` | The "reading as guest · Sign in" line on every page |
| `src/pages/common.js` | Script every plain page loads |
| `src/lib/forum.js` | Every forum read/write (threads, posts, rate limit helpers) |
| `src/lib/markdown.js` | Markdown → sanitized HTML (marked + DOMPurify). All user formatting goes through it |
| `src/lib/ui.js` | Small DOM helpers, time formatting, the Markdown composer |
| `src/styles/forum.css` | Forum styles |
| `src/lib/library.js` | Every library read/write, uploads, downloads |
| `src/styles/library.css` | Library styles |
| `src/lib/mod.js` | Sysop helpers: calls the `moderate` function, loads dashboard data |
| `src/styles/mod.css` | Dashboard styles and sysop touches on forum pages |
| `functions/index.js` | Cloud Functions: reply counts, last reply time, post counts |
| `functions/moderate.js` | The `moderate` function: every sysop action, checked and written to the mod log |
| `scripts/seed.mjs` | Creates the forum areas and site settings if missing (runs on deploy) |
| `scripts/add-sysop.mjs` | Makes a member sysop (run via the "Add sysop" GitHub action) |
| `scripts/recount.mjs` | Rebuilds reply/post counts from the actual posts ("Recount forum" GitHub action) |
| `firestore.indexes.json` | Database indexes the thread and post lists need |
| `firestore.rules` | **The real security.** Who can read/write what |
| `storage.rules` | Who can download/upload library files (reads Firestore for draft/sysop checks) |
| `tests/` | Rules tests and Cloud Functions tests, run on the Firestore emulator |
| `public/` | Files copied as-is (images, favicon) |
| `vite.config.js` | List of pages to build; add new pages here |
| `firebase.json` | Hosting settings (clean URLs, caching, security headers) |
| `.github/workflows/deploy.yml` | Auto-deploy: `main` goes live, pull requests get a preview link |
| `.github/workflows/test.yml` | Tests only, for pushes to other branches |

## Working on it

```bash
npm install && npm install --prefix functions
npm run emulators   # terminal 1: local Firebase (auth, database, functions, storage; needs Java)
npm run seed:local  # once: create the forum areas in the local database
npm run dev         # terminal 2: local site at http://localhost:5173, talks to the emulators
npm test            # rules + functions tests
npm run check:phone # every page at 360/390px: sideways scroll, tap targets, labels (screenshots in check-phone-output/)
npm run build       # production build into dist/
```

`check:phone` uses Playwright; on a new computer run `npx playwright install chromium` once.

Locally the site uses a demo project (`demo-garage-terminal`) on the emulators, so it never touches real data.

Deploys happen automatically through GitHub Actions: tests first, then on `main` the Firestore rules,
starting data, the site, and Cloud Functions.
Nothing is deployed by hand.
The workflow needs the repo secret `FIREBASE_SERVICE_ACCOUNT` (a service-account JSON key for project
`garage-terminal-15499`).

## RepClock and member workouts

RepClock (`/apps/repclock`) keeps its data on the device, as it always has. When a member is signed in,
`src/apps/repclock-sync.js` also saves their workout history and settings to Firestore
(`repclock/{uid}`, one doc per workout under `workouts/`), so they appear on every device they sign in on.
Only the member can read or write their own (see the REPCLOCK section of `firestore.rules`); not other
members, not the sysop. Signing out removes the member's workouts from that device (they stay in the
account). A count or stopwatch in progress stays on the device.

The Builder tab (muscle group → fire station or home → reps or AMRAP → exercises, then a weight
rating) saves its workouts into the same `hiit.history` list, with `kind: "builder"`, so they sync the
same way. The artifact on claude.ai also has its own claude.ai account storage; the import script
switches that off here so the Google sign-in sync above is the only account storage on this site.

To update RepClock from a newer version of the Claude artifact, save the artifact's HTML and run
`node scripts/import-repclock.mjs path/to/file.html`; the script stops with an error if the artifact
changed in a way its edits no longer fit.

## Adding an app to the home page

In `index.html`, copy one `<article class="app" data-category="…">` card inside `#apps-list`, change the
name, description, icon (put it in `public/img/`) and link, and set `data-category`:

- `garage` or `gym` for the existing buttons, or
- any new word, e.g. `other`: an **Other** button appears automatically (labels and order for known
  categories are in `src/pages/app-filter.js`, `KNOWN`).

The counts on the buttons and the "N apps" label update by themselves.

## Security table → tests

Every row of the security table in `PLAN.md` has its own block in `tests/plan-table.rules.test.js`;
the other test files go into detail:

| PLAN row / rule | Tests |
| --- | --- |
| Guest: reads visible content, writes nothing | `plan-table` (Guest), `forum.rules` (reading), `library.rules` |
| Member: posts as themselves, edits within 30 min, deletes own, reports; no counters/pins/locks/emails | `plan-table` (Member), `forum.rules`, `moderation.rules` (reports), `members.rules` (emails) |
| Muted: reads and reports, can't post | `plan-table` (Muted), `forum.rules`, `moderation.rules` |
| Banned: reads like a guest; can't post, reply or report | `plan-table` (Banned), `forum.rules`, `moderation.rules` |
| Sysop: everything, moderation via the logged function, library uploads | `plan-table` (Sysop), `moderate.functions`, `library.rules` |
| Handles: 3–20 chars, unique, reserved words | `members.rules` |
| Titles 3–120, bodies 1–10,000 | `forum.rules` |
| One post per 20 seconds | `forum.rules` (rate limit) |
| Hidden items and drafts invisible except to the sysop | `forum.rules`, `library.rules`, `plan-table` |
| Storage: published files public, sysop-only uploads/deletes, 50 MB | `library.rules` (Storage) |

Note: the Storage tests need the Storage emulator to read Firestore; they pass on GitHub. In some
sandboxed environments with an HTTP proxy, the emulator can't reach Firestore and three of them fail.

## Moderation

Every sysop action (pin, lock, move, hide, delete, mute/ban, rename, settings) goes through one
Cloud Function, `moderate` (`functions/moderate.js`). It checks the caller is in `admins/`, makes the
change, and writes a `modlog/` entry. The Firestore rules block these changes from the page directly,
so nothing can be moderated without being logged.

The word filter is enforced by the rules too: a post containing a banned word can only be saved hidden
and "held"; the sysop approves or deletes it from `/mod#held`.

## Making someone sysop

Sysop status is a document at `admins/{uid}` in Firestore. The site itself can never create one
(the rules forbid it). Two ways to add one:

- GitHub → **Actions** → **Add sysop** → Run workflow → paste the User UID
  (from Firebase console → Authentication → Users). Script: `scripts/add-sysop.mjs`.
- Or by hand in the Firebase console: Firestore → `admins` → new document with the UID as its ID
  and a timestamp field `addedAt`.

## Bot protection (App Check)

`src/lib/firebase.js` starts App Check with a reCAPTCHA v3 site key (`APP_CHECK_SITE_KEY`). To turn
enforcement on: Firebase console → **App Check** → **APIs** → Cloud Firestore, Cloud Storage and
Authentication → check that most requests show as *verified*, then **Enforce**. Once enforced, PR preview
links stop working with the database (their addresses aren't registered with reCAPTCHA); the live site is
unaffected. To add a domain, add it in the reCAPTCHA admin console too.

## Adding a custom domain (later)

1. Firebase console → Hosting → **Add custom domain**; copy the DNS records it shows into your domain
   registrar and wait for it to say *Connected*.
2. Firebase console → Authentication → Settings → **Authorized domains** → add the domain.
3. Google Cloud console → APIs & Services → Credentials → the OAuth web client → **Authorized redirect
   URIs** → add `https://YOUR-DOMAIN/__/auth/handler` (phones finish sign-in there).
4. reCAPTCHA admin console → the Garage Terminal key → add the domain (App Check).
5. In the code, replace `https://garage-terminal-15499.web.app` in the link-preview tags (search the HTML
   files for `og:url`) with the new address.
