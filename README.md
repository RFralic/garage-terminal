# Garage Terminal

Home page, open forum, wiki/library and sysop moderation tools, on Firebase.
The full spec and build phases are in [PLAN.md](PLAN.md).

Live site: https://garage-terminal-15499.web.app

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | Home page (ported from `garage-terminal.html`, which is kept for reference) |
| `forum/index.html` | Forum (placeholder until Phase 3) |
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
| `firestore.rules` | **The real security.** Who can read/write what |
| `tests/firestore.rules.test.js` | Rules tests, run on the Firestore emulator |
| `public/` | Files copied as-is (images, favicon) |
| `vite.config.js` | List of pages to build; add new pages here |
| `firebase.json` | Hosting settings (clean URLs, caching, security headers) |
| `.github/workflows/deploy.yml` | Auto-deploy: `main` goes live, pull requests get a preview link |

## Working on it

```bash
npm install
npm run emulators   # terminal 1: local Firebase (fake auth + database, needs Java)
npm run dev         # terminal 2: local site at http://localhost:5173, talks to the emulators
npm run test:rules  # Firestore rules tests
npm run build       # production build into dist/
```

Locally the site uses a demo project (`demo-garage-terminal`) on the emulators, so it never touches real data.

Deploys happen automatically through GitHub Actions: rules tests first, then on `main` the Firestore rules and the site.
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
