# Garage Terminal

Home page, open forum, wiki/library and sysop moderation tools, on Firebase.
The full spec and build phases are in [PLAN.md](PLAN.md).

Live site: https://garageterminal.com (also https://garage-terminal-15499.web.app)

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
| `apps/home-projects/index.html` | Home Projects, built from its Claude artifact by `scripts/import-home-projects.mjs` (don't edit by hand) |
| `src/apps/homeprojects-backend.js` | Home Projects storage on this site: sign-in, projects (Firestore) and photos (Storage) |
| `apps/logbook/index.html`, `apps/job-board/index.html` | Engine & Vehicle Logbook and Job_Board (renamed from Project Tracker, Nov 2026; moved from `/apps/project-tracker`, which now redirects), built from the Logbook repo by `scripts/import-logbook.mjs` (don't edit by hand) |
| `src/apps/logbook-backend.js` | Logbook and Job_Board sign-in and storage on this site (Firestore) |
| `public/apps/sw.js` | Keeps the Logbook and Job_Board pages for offline use |
| `apps/morning-brief/index.html`, `src/pages/morning-brief.js` | Morning Brief settings and preview |
| `src/brief/` | Builds the Morning Brief (shared by the page and the sender): `brief.js`, `ics.js` (calendar feeds), `time.js` |
| `scripts/send-briefs.mjs`, `scripts/lib/resend.mjs` | Sends the Morning Brief emails (GitHub action "Morning Brief", every 30 minutes) |
| `apps/pantry/index.html`, `src/pages/pantry.js`, `src/styles/pantry.css` | Pantry: a household's food and supplies, scanned in and out |
| `src/pantry/` | Pantry parts: `logic.js` (counts, dates, barcodes, batch codes), `store.js` (Firestore), `code128.js`, `label.js` (label images), `off.js` (Open Food Facts lookup) |
| `apps/tap-drill-chart/index.html` | Tap Drill Chart, copied from its Claude artifact (re-copy if the artifact changes) |
| `apps/torque-chart/index.html`, `src/pages/torque.js` | Torque Chart: typical bolt torque (SAE and metric, dry and oiled) and a unit converter |
| `src/torque/` | Torque Chart parts: `calc.js` (the formula, standards and bolt sizes; tested in `tests/torque.calc.test.js`), `machines.js` (Add to a vehicle or engine: writes a `From chart` row to a Logbook machine's torque specs) |
| `apps/fuel-mix/index.html`, `src/pages/fuelmix.js`, `src/fuelmix/calc.js` | Fuel Mix: 2-stroke oil for any gas amount and ratio, a chart, "I have a bottle" and "Fix a mix" (math tested in `tests/fuelmix.calc.test.js`). `?ratio=50` opens with a ratio picked (the Logbook's Mix fuel link) |
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

To update RepClock from a newer version of the Claude artifact, save the artifact's HTML and run
`node scripts/import-repclock.mjs path/to/file.html`; the script stops with an error if the artifact
changed in a way its edits no longer fit.

## Home Projects

Home Projects (`/apps/home-projects`) was built on claude.ai, where it stores data through
`window.claude.use("db" | "user" | "assets")`. On this site the page provides those with the site's
Google sign-in (`src/apps/homeprojects-backend.js`): projects in Firestore at
`homeprojects/{uid}/projects/{id}`, photos in Storage at `homeprojects/{uid}/photos/{id}`, both private
to the member (see the HOME PROJECTS sections of `firestore.rules` and `storage.rules`). Signed out, it
keeps projects in the browser; the first sign-in adds them to the account. To update from a newer
artifact: `node scripts/import-home-projects.mjs path/to/file.html`.

## Engine & Vehicle Logbook and Job_Board

The Logbook (`/apps/logbook`) and Job_Board (`/apps/job-board`; called the Project Tracker at `/apps/project-tracker` until Nov 2026, and that address redirects) were first built in their own
Firebase project (`vehicle-logbook-c7e27`, code in github.com/RFralic/vehicle_logbook). Here they use this
site's Google sign-in (`src/apps/logbook-backend.js`), with data in Firestore at
`logbook/{uid}/records/{id}` (engines, vehicles, parts), `logbook/{uid}/projects/{id}` and
`logbook/{uid}/trackerSettings/{id}`, private to the member (see the LOGBOOK section of `firestore.rules`).
No forum handle is needed. Both pages keep working offline: Firestore's offline cache holds the records and
`public/apps/sw.js` holds the pages. The Logbook has its own home-screen manifest (`public/logbook.webmanifest`).

To update them from newer Logbook files: `node scripts/import-logbook.mjs path/to/vehicle_logbook/public`.

Moving records over from the old project is a one-time GitHub action, "Copy Logbook data"
(`scripts/copy-logbook-data.mjs`). It needs a second secret, `LOGBOOK_SERVICE_ACCOUNT`: the old project's
service account key. Run it as a dry run first; it never changes the old project.

### Receipts (photos and PDFs on parts)

Each receipt is one Firestore doc, `logbook/{uid}/receipts/{id}`:
`{ partId, name, type: 'image' | 'pdf', data, size, createdAt }`, where `data` is the file as a data: URL.
Photos are shrunk to JPEG in the browser; PDFs must be under 680 KB, because a Firestore doc holds at
most 1 MiB (the rules cap `data` at 1,000,000 characters). Parts and log entries never hold the file,
only a short list `receipts: [{ id, name, type, at }]`, so the files can move without touching them.
The page reads a file only when it's opened or printed (`receipts(uid).get(id)` in
`src/apps/logbook-backend.js`). Storage cost: the first 1 GiB of Firestore is free (roughly
3,000–5,000 receipts across all members), then billed per GiB per month.

#### Moving receipt files to Firebase Storage later

Do this if receipts get large or numerous (bigger PDFs, email forwarding). Keep every receipt's **id**:
parts and log entries point at receipts by id, so nothing else changes. Members shouldn't notice.

1. **Read from both places first.** Ship a Logbook update where `receipts(uid).get(id)` returns the
   file from Storage when the doc has a `path`, and otherwise the `data` field as today. Add Storage rules
   so only the member can read and write `logbook/{uid}/receipts/*`, plus a rules test. Deploy this
   before moving anything, so a half-finished move never breaks a receipt.
2. **Send new receipts to Storage.** Uploads go to `logbook/{uid}/receipts/{id}.jpg` or `.pdf`; the doc
   keeps `partId, name, type, size, createdAt` and gets `path` instead of `data`.
3. **Back up.** Export Firestore (`gcloud firestore export`) before the copy.
4. **Copy the old ones** with a one-time admin script (a GitHub action like "Copy Logbook data", dry run
   first): for each doc that has `data` and no `path`, upload the decoded file to Storage, then set
   `path` on the doc. Leave `data` in place for now. Re-running it must skip docs already done.
5. **Check every copy:** the Storage file's size matches the decoded `data`, and a few open in the Logbook.
6. **Wait about a week**, so phones still running the old page (which only reads `data`) have reloaded.
   A receipt someone viewed offline before the move needs a connection once afterward.
7. **Remove the old copies:** a second run of the script deletes the `data` field from docs that have
   a verified `path`. Then tighten the Firestore rule so new receipt docs can't carry `data`.

The standalone Logbook site (`vehicle-logbook-c7e27`, `users/{uid}/receipts`) is a separate Firebase
project and needs its own run of these steps. While both copies exist the cost is doubled briefly
(pennies).

## Morning Brief

A daily or weekly email for any signed-in member, set up at `/apps/morning-brief`. Daily: today's
calendar and the next 14 days; weekly (on the member's chosen day): the 7 days ahead and the week after. Plus parts at or below their reorder level, maintenance coming due (the Logbook's own rules, plus Home Projects upkeep reminders that are overdue or due soon by that app's rules) and open
Job_Board jobs. Members in a pantry also get **Pantry: expiring soon** (within 7 days, or expired) and
**Pantry: shopping list** (below "keep at least", plus things added by hand), by the Pantry's own rules
(`src/pantry/logic.js`; left out for anyone not in a pantry). Members can instead choose "Only maintenance alerts" (`mode: 'maintenance'`): checked
daily at their time and emailed only when something new or worse comes due, or weekly while it stays due
(`briefStatus.lastAlertKey`). Settings are in `briefs/{uid}` (private; the address can only be the member's own
verified Google email), the last send in `briefStatus/{uid}`.

The GitHub action "Morning Brief" runs `scripts/send-briefs.mjs` every 30 minutes and sends each brief on
the first run after the member's chosen hour. It sends from `brief@garageterminal.com` through Resend
(domain verified in Resend, DNS on Cloudflare), with replies going to `support@garageterminal.com`
(Cloudflare Email Routing forwards it). It needs one secret: `RESEND_API_KEY`. Calendars come from the member's secret iCal address
(`src/brief/ics.js`), so no Google Calendar permission is needed. GitHub pauses scheduled actions after 60
days without a commit to the repo; re-enable it under Actions if that happens.

## Pantry

`/apps/pantry`: food and household supplies, **shared by a household**, logged in and out with the Logbook's
barcode scanner (`public/apps/scanner.js`: phone camera or a Bluetooth scanner in keyboard mode).
Places: Pantry, Fridge, Freezer, Supplies and Basement (`LOCATIONS` in `src/pantry/logic.js`), plus any typed in.

- **Bulk scan in:** pick a place, scan a load of things one after another (the scanner stays open), check the
  list (counts, optional dates, names for new codes, looked up in Open Food Facts) and save it all at once.
  Something kept elsewhere gets an entry in the new place too (`planBulk`).
- **Move:** an item, or some of it, to another place. The soonest-expiring go first and keep their dates;
  if the same thing (shared barcode, or same name, brand and size) is already there, they join up (`planMove`).

- **Shared, with roles.** Unlike the other apps, a pantry belongs to several people: `pantries/{pid}` lists
  them in `members: {uid: role}` (+ `memberIds`, `memberNames`). Owner: invites, roles, settings. Member:
  scans, adds, edits. Viewer: looks, and can use the shopping list. Items, activity and the hand-added
  shopping list are subcollections. See the PANTRY section of `firestore.rules` and `tests/pantry.rules.test.js`.
- **Invites.** The owner makes an 8-character code (`pantryInvites/{code}`, works 7 days) and shares a link,
  `/apps/pantry?join=CODE`. The person signs in and adds only themselves, as a member; the rules check the
  code matches the pantry's current one and hasn't expired. Codes can be looked up but not listed.
- **Counts by expiration date.** Each item keeps "lots" (`[{qty, expires}]`); "Used 1" takes from the one
  that expires first. "Keep at least" puts an item on the shopping list when it runs low.
- **New store barcodes** are looked up in Open Food Facts (free, no key; only the barcode is sent).
- **Homemade batches** take the pantry's next batch number in a transaction; batch 42's barcode is
  `20000042` (8 digits starting with 2, a range kept for in-store use, so it never clashes with a real
  UPC), printed as Code 128 set C. `src/pantry/label.js` draws labels at the exact size of a 203 dpi
  thermal label printer (30×20, 40×30, 50×80 mm), pure black and white, with the dpi stored in the PNG.
  They're saved as images to print from the printer's app (made for the Katasymbol / Supvan T50M, which
  has no open protocol to print to directly). The 30×20 label was printed and scanned on Nov 16, 2026.

## Adding an app to the home page

In `index.html`, copy one `<article class="app" data-category="…">` card inside `#apps-list`, change the
name, description, icon (put it in `public/img/`) and link, and set `data-category`:

- `garage` or `gym` for the existing buttons, or
- any new word, e.g. `other`: an **Other** button appears automatically (labels and order for known
  categories are in `src/pages/app-filter.js`, `KNOWN`).

The counts on the buttons and the "N apps" label update by themselves.

## The BBS (private, members only)

The Garage_Terminal BBS lives at `/bbs` (`bbs/index.html`, `src/pages/bbs.js`, `src/bbs/`, `src/styles/bbs.css`;
designs in `reference/bbs-design/`, not deployed). It isn't linked from any menu and is `noindex`.

- **The door:** a dim, blinking `>_` at the end of every site footer (`src/lib/door.js`). Tap it and type the
  **door word** (default `backroom`; the sysop changes it in `/mod#bbs` → Settings). On a computer, typing the
  word anywhere on a page works too. Members who are signed in and let in skip the word. The word isn't a
  secret (this repo is public); it only hides the door.
- **Getting in:** sign in with Google (and pick a handle) → a join request (`bbsRequests/{uid}`) → the sysop or a
  co-sysop approves it in `/mod#bbs`. Denied people can't ask again for 30 days (`bbsDenied/{uid}`) unless
  that's cleared. Optional **passcode** (off by default): 6 digits, checked by the `bbsKnock` Cloud Function,
  5 tries then a 15-minute lockout.
- **Who decides:** every change to the member list and BBS settings goes through the `bbs` Cloud Function
  (`functions/bbs.js`), which checks powers and writes the mod log. Co-sysops can approve, deny, add and remove
  members (`/mod` shows them only the BBS tab); only the sysop can make co-sysops and change settings.
  `firestore.rules` (BBS section) lets nobody outside the member list read anything, checked on every read,
  so removing someone cuts them off at once. Tests: `tests/bbs.rules.test.js`, `tests/bbs.functions.test.js`.
- **Boards and files:** boards (`bbsBoards`, starting with #01 General, #02 Shop Notes, #03 Builds from
  `scripts/seed.mjs`) are added, renamed, reordered and archived by the sysop in `/mod#bbs` → Boards; no code
  change needed. Threads and posts (`bbsThreads/{id}/posts`) take Markdown (the forum's safe renderer) and a
  photo shrunk in the browser (`src/lib/photo.js`). "N NEW" counts threads with activity since your last visit
  to that board (`bbsReads/{uid}`). The file cabinet (`bbsFiles`, Storage `bbs/files/`) takes PDF, photos,
  ZIP, text and office documents up to 25 MB. Reply counts and clean-up of deleted threads, photos and files
  are done by Cloud Functions (`functions/bbs-content.js`). Tests: `tests/bbs.boards.rules.test.js`.
- **Shop Talk** (`#chat`, `src/bbs/chat.js`): one live room (`bbsChat`, photos in Storage `bbs/chat/`).
  Messages are deleted after 7 days by `bbsChatCleanup`, a Cloud Function that runs every night at 3:30 a.m.
  Eastern (it uses Cloud Scheduler, which the functions deploy turns on). Tapping a message offers Save to a
  board (the `bbs` function copies it, and its photo, into a new thread credited to whoever said it, so it
  outlives the clean-up), Quote in a new post and Reply; the sysop and co-sysops can also delete it and mute
  the person (1 hour, 1 day or until unmuted; `bbsMembers.mutedUntil`). Muted members can read but not send.
  The Chat tab shows how many messages others sent since you last had Shop Talk open (`bbsReads.chat`;
  never opened: the last 24 hours; 99+ at most). Tests: `tests/bbs.chat.rules.test.js`.
- **Private messages** (`#dm/<uid>`, `src/bbs/dm.js`): one-to-one conversations, started from the **Message**
  button on the Crew tab (which also lists your conversations and shows an unread count). Stored in
  `bbsDms/{uidA_uidB}/messages`; photos in Storage `bbs/dm/`. **Only the two members can read a conversation,
  not even the sysop.** Kept until deleted: you can delete your own messages and hide a conversation from your
  own list (a new message brings it back). Removed members lose access and can't be messaged; muted members
  can't send. No emails. Tests: `tests/bbs.dm.rules.test.js`.
  - **End-to-end encrypted (since Nov 24, 2026; `src/bbs/e2e.js`, `src/bbs/keys.js`).** Each member makes a
    **message lock** (ECDH P-256 key pair) on their device the first time they open Crew, protected by a
    **message passphrase** (10+ characters). The public half is at `bbsKeys/{uid}` (members read it); the
    private half, scrambled with the passphrase (PBKDF2-SHA256 600,000 rounds → AES-GCM), is at
    `bbsKeyBackups/{uid}` (only its owner reads it), so a new phone or computer unlocks with the same
    passphrase. The unlocked key stays on the device in IndexedDB (not exportable); **Message lock settings**
    on Crew change the passphrase or lock the device. Words and photos are sealed with AES-256-GCM using a key
    both members derive (ECDH → HKDF, bound to the conversation and both lock ids); the sender's uid is
    authenticated, so a message can't be moved or passed off as the other person's. Messages store
    `text: ''` + `enc: { v, iv, ct, k }`; photos are sealed bytes at `bbsDms/{conv}/blobs/{msgId}` (≤ 700 KB,
    shrunk to fit; no Storage, no CORS). The list preview is only ever "Encrypted message" / "Message
    deleted". The rules refuse plain messages. **Safety code** in a conversation: 12 digits both members
    compare in person; a "lock changed" warning shows if the other person's lock changes. **Forgotten
    passphrase = start over with a new lock; old messages can't be read by anyone.** Messages from before Nov 24
    stay as they were, marked "not encrypted". Tests: `tests/dm.crypto.test.js` (runs without the emulator).
- **Emails** go out from Cloud Functions the moment something happens, from `brief@garageterminal.com`
  through Resend: "New BBS request" to the sysop, "You're in" to people who are approved or added. Nothing is
  sent to people who are denied or removed.

### Secrets for the BBS (Google Cloud Secret Manager)

The BBS functions read two secrets from Secret Manager, never from the repo, the page or Firestore. **Both
must exist before the BBS reaches `main`,** or the "Deploy Cloud Functions" step fails (the site and rules
still deploy).

1. Open the project in the Google Cloud console: https://console.cloud.google.com/security/secret-manager?project=garage-terminal-15499
   If asked, click **Enable** for the Secret Manager API.
2. **+ Create secret** → Name `RESEND_API_KEY` → Secret value: the same Resend API key as the
   `RESEND_API_KEY` GitHub secret (Resend → API Keys; create a new one if you don't have it saved) → **Create secret**.
3. **+ Create secret** → Name `BBS_PASSCODE` → Secret value: any 6 digits, e.g. `482916` (it's only used when
   you switch "Require a passcode" on, but it has to exist) → **Create secret**.
4. Let the deploy account manage the secrets' access: **IAM & Admin → IAM** → find the service account
   GitHub deploys with (the `client_email` in the `FIREBASE_SERVICE_ACCOUNT` GitHub secret) → pencil icon →
   **+ Add another role** → **Secret Manager Admin** → **Save**. On the next deploy, the Firebase tools give
   the functions read access to these two secrets.
5. Merge the BBS pull request (or re-run the newest **Deploy** run on `main`: Actions → Deploy → the run →
   **Re-run all jobs**).

**Changing the passcode:** Secret Manager → `BBS_PASSCODE` → **+ New version** → the new 6 digits → **Add new
version**, then re-run the newest Deploy run on `main` (functions use the version that was current when they
were deployed). Tell members the new code yourself; it's never shown anywhere on the site.

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
| BBS: members only (checked on every read), own request only, sysop vs co-sysop powers, passcode lockout | `bbs.rules`, `bbs.functions` |

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

## Custom domain

The site is at **garageterminal.com** (registered with Cloudflare, DNS on Cloudflare); `www.` redirects to
it, and `garage-terminal-15499.web.app` keeps working. To add another domain:

1. Firebase console → Hosting → **Add custom domain**; add the DNS records it shows in Cloudflare with the
   proxy **off** (grey cloud, "DNS only") and wait for it to say *Connected*.
2. Firebase console → Authentication → Settings → **Authorized domains** → add the domain.
3. Google Cloud console → APIs & Services → Credentials → the OAuth web client → **Authorized JavaScript
   origins** → add `https://YOUR-DOMAIN`, and **Authorized redirect URIs** → add
   `https://YOUR-DOMAIN/__/auth/handler` (phones finish sign-in there).
4. reCAPTCHA admin console → the Garage Terminal key → add the domain (App Check).
5. The link-preview tags (search the HTML files for `og:url`) use `https://garageterminal.com`.
