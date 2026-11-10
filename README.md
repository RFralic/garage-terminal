# Garage Terminal

Home page, open forum, wiki/library and sysop moderation tools, on Firebase.
The full spec and build phases are in [PLAN.md](PLAN.md).

Live site: https://garage-terminal-15499.web.app

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | Home page (ported from `garage-terminal.html`, which is kept for reference) |
| `forum/index.html` | Forum thread list (`src/pages/forum-list.js`) |
| `forum/thread.html` | One thread, served at `/forum/t/{id}` (`src/pages/thread.js`) |
| `forum/new.html` | New thread form (`src/pages/new-thread.js`) |
| `wiki/index.html` | Library (placeholder until Phase 5) |
| `join/index.html` | Sign in with Google + pick a handle (`src/pages/join.js`) |
| `404.html` | Not-found page |
| `src/styles/base.css` | Shared look: colors, fonts, header, footer, terminal boxes |
| `src/styles/home.css` | Home-page-only styles |
| `src/styles/forms.css` | Inputs, buttons, status lines |
| `src/lib/firebase.js` | Starts Firebase (live config from Hosting; emulators locally) |
| `src/lib/session.js` | Sign-in, sign-out, handle rules, claiming a handle |
| `src/lib/header.js` | The "reading as guest · Sign in" line on every page |
| `src/pages/common.js` | Script every plain page loads |
| `src/lib/forum.js` | Every forum read/write (threads, posts, rate limit helpers) |
| `src/lib/markdown.js` | Markdown → sanitized HTML (marked + DOMPurify). All user formatting goes through it |
| `src/lib/ui.js` | Small DOM helpers, time formatting, the Markdown composer |
| `src/styles/forum.css` | Forum styles |
| `functions/index.js` | Cloud Functions: reply counts, last reply time, post counts |
| `scripts/seed.mjs` | Creates the forum areas and site settings if missing (runs on deploy) |
| `scripts/add-sysop.mjs` | Makes a member sysop (run via the "Add sysop" GitHub action) |
| `scripts/recount.mjs` | Rebuilds reply/post counts from the actual posts ("Recount forum" GitHub action) |
| `firestore.indexes.json` | Database indexes the thread and post lists need |
| `firestore.rules` | **The real security.** Who can read/write what |
| `tests/` | Rules tests and Cloud Functions tests, run on the Firestore emulator |
| `public/` | Files copied as-is (images, favicon) |
| `vite.config.js` | List of pages to build; add new pages here |
| `firebase.json` | Hosting settings (clean URLs, caching, security headers) |
| `.github/workflows/deploy.yml` | Auto-deploy: `main` goes live, pull requests get a preview link |

## Working on it

```bash
npm install && npm install --prefix functions
npm run emulators   # terminal 1: local Firebase (fake auth + database + functions, needs Java)
npm run seed:local  # once: create the forum areas in the local database
npm run dev         # terminal 2: local site at http://localhost:5173, talks to the emulators
npm test            # rules + functions tests
npm run build       # production build into dist/
```

Locally the site uses a demo project (`demo-garage-terminal`) on the emulators, so it never touches real data.

Deploys happen automatically through GitHub Actions: tests first, then on `main` the Firestore rules,
starting data, the site, and Cloud Functions.
Nothing is deployed by hand.
The workflow needs the repo secret `FIREBASE_SERVICE_ACCOUNT` (a service-account JSON key for project
`garage-terminal-15499`).

## Making someone sysop

Sysop status is a document at `admins/{uid}` in Firestore. The site itself can never create one
(the rules forbid it). Two ways to add one:

- GitHub → **Actions** → **Add sysop** → Run workflow → paste the User UID
  (from Firebase console → Authentication → Users). Script: `scripts/add-sysop.mjs`.
- Or by hand in the Firebase console: Firestore → `admins` → new document with the UID as its ID
  and a timestamp field `addedAt`.
