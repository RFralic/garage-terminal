# Garage Terminal Build Plan

Nov 9, 2026 · Ryan

## Firebase project (already set up)

- Project name: Garage-Terminal
- Project ID: `garage-terminal-15499`
- Plan: Blaze (Google Cloud free trial until Feb 8, 2027)
- Web app registered, with Firebase Hosting
- Authentication: Google sign-in enabled
- Firestore: `(default)` database, production mode, us-east1
- Storage bucket: `garage-terminal-15499.firebasestorage.app`, production mode, us-east1
- Separate from the Logbook project (`vehicle-logbook-c7e27`); don't touch that one

## How to use this plan

Claude Code builds the site from this plan in this GitHub repo, one phase at a time.

1. `PLAN.md` (this file) and the home page file `garage-terminal.html` are in the repo.
2. Open the repo in Claude Code and paste the prompt from the last section.
3. Check each phase on a phone before starting the next one.

**Ryan does these himself (Claude Code can't)**

- [x] Create the Firebase project, separate from the Logbook.
- [x] Switch it to the **Blaze** plan. File uploads need it: new Cloud Storage buckets require Blaze ([Firebase FAQ](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024)).
- [ ] Set a **budget alert** of $5/month in Google Cloud Billing.
- [x] Turn on **Google** as a sign-in method in Firebase Authentication.
- [x] Create Firestore and Storage in us-east1.
- [ ] Sign in to the finished site once, copy the user ID from Firebase Authentication, and give it to Claude Code so that account becomes the sysop.
- [ ] Add the Firebase deploy secret to the GitHub repo when Claude Code asks.

## What we're building

One Firebase-hosted site with a home page, an open forum, a wiki and library, and sysop moderation tools, all sharing one Google sign-in.

| Section | Who can see it | Who can change it |
| --- | --- | --- |
| Home page | Everyone | Sysop, through code changes |
| Forum | Everyone reads | Members with a handle post and reply; sysop moderates |
| Wiki & library | Everyone reads and downloads | Sysop only, from the upload page |
| Moderation | Sysop only | Sysop only |
| BBS (private) | Hidden for now | Built in a later round |

The apps (RepClock, Engine & Vehicle Logbook) stay where they are; the home page links out to them.

Note on `garage-terminal.html`: the BBS menu link, card and section, and the hero buttons, are switched off with the `hidden` attribute (plus a `[hidden]{display:none!important}` rule). Keep them hidden; they come back when the BBS is built.

## Stack, pages and look

Keep it simple and close to the Logbook: Vite with plain JavaScript (no framework), the Firebase web SDK, and GitHub Actions deploying to Firebase Hosting on every push to `main`.

- **Firebase services:** Hosting, Authentication (Google), Firestore, Storage, Cloud Functions (for counters and moderation actions).
- **Rendering user text:** forum posts and wiki pages are Markdown, rendered with `marked` and cleaned with `DOMPurify` so no one can inject code.
- **Deploys:** pushes to `main` go live; pull requests get a Firebase preview link.

**Pages**

| Address | Page | Access |
| --- | --- | --- |
| `/` | Home page (port of `garage-terminal.html`) | Everyone |
| `/forum` | Thread list, filter by message area | Everyone |
| `/forum/t/{id}` | Thread with replies | Everyone; reply box for members |
| `/forum/new` | New thread form | Members |
| `/join` | Sign in with Google, then pick a handle | Everyone |
| `/wiki` | Library: search and folder filters | Everyone |
| `/wiki/{slug}` | Document page with attachments | Everyone |
| `/wiki/add` | Add to library: upload a file or write a page | Sysop |
| `/mod` | Moderation dashboard | Sysop |

**Look and feel** (match the home page)

- Background `#0E1116`, bars `#0B0E12`, panels `#161B22`, lines `#262D38` / `#3A4352`
- Text `#E6EDF3`, muted `#9AA4B2`; accent green `#5BE49B`, amber `#F2B45A` (sysop), blue `#8EB8FF`, violet `#E58BFF` (forum)
- Fonts: JetBrains Mono for headings, labels and menus; Inter for body text
- Terminal touches: `GARAGE_TERMINAL/forum` header, `> ls /library` headings, `[1] General` area keys, `NO CARRIER` footer
- Works on a phone first: 44px+ tap targets, single column under 600px

## Data model

Everything lives in Firestore except uploaded files, which go to Storage; emails are never stored where other members can read them.

| Collection | Holds | Key fields |
| --- | --- | --- |
| `users/{uid}` | One member | `handle`, `createdAt`, `status` (active / muted / banned), `bannedReason`, `postCount` |
| `handles/{handle}` | Handle reservation, keeps handles unique | `uid` |
| `private/{uid}` | Private member info, sysop only | `email` |
| `admins/{uid}` | Sysop accounts | `addedAt` |
| `areas/{id}` | Message areas | `key` ([1]…[5]), `name`, `order` |
| `threads/{id}` | A forum thread | `areaId`, `title`, `authorUid`, `authorHandle`, `createdAt`, `lastReplyAt`, `replyCount`, `pinned`, `locked`, `hidden` |
| `threads/{id}/posts/{id}` | A post or reply | `authorUid`, `authorHandle`, `body`, `createdAt`, `editedAt`, `hidden`, `hiddenReason` |
| `reports/{id}` | A member's report of a post | `threadId`, `postId`, `reporterUid`, `reason`, `createdAt`, `status` (open / dismissed / actioned) |
| `library/{id}` | A wiki item | `slug`, `title`, `folder`, `kind` (file / page), `type` (PDF, EPUB, GUIDE…), `description`, `body`, `storagePath`, `size`, `status` (draft / published), `updatedAt` |
| `settings/site` | Site-wide settings | `sysopNotice`, `forumOpen`, `bannedWords` |
| `modlog/{id}` | Record of every moderation action | `action`, `targetPath`, `byUid`, `reason`, `createdAt` |

**Storage:** library files at `library/{itemId}/{fileName}`, up to 50 MB each.

**Starting areas:** [1] General, [2] App Support, [3] Releases, [4] Wiki Requests, [5] Off-Topic. Folders: /guides, /manuals, /ebooks, /files.

## Security rules

Firebase rules, not the page, decide who can do what, so nobody can get around them by editing the page in their browser.

| Who | Can | Can't |
| --- | --- | --- |
| Guest | Read visible threads, posts and published library items; download files | Write anything |
| Member (signed in, has a handle, status active) | Create threads and posts as themselves; edit their own post within 30 minutes; delete their own post; report a post | Post in a locked thread; change counters, pins, locks or anyone else's content; see emails |
| Muted member | Read, report | Post or reply until unmuted |
| Banned member | Read like a guest | Post, reply or report |
| Sysop (in `admins`) | Everything above, plus all moderation and library uploads | Nothing restricted |

Rules to enforce:

- A handle is 3–20 letters, numbers or underscores, claimed once in `handles`, and can't be one of: sysop, admin, moderator, garage, terminal.
- Thread titles 3–120 characters; post bodies 1–10,000 characters.
- One new post per member every 20 seconds (compare with the member's last post time).
- `hidden` items and `draft` library items are invisible to everyone but the sysop.
- Storage: anyone can read published files; only the sysop can upload or delete.
- Rules ship with tests (Firebase emulator) covering each row of the table above.

## Features

**Sign-in and handles**

- "Sign in with Google" (popup on desktop, redirect on phones), then a one-time "Pick your handle" step with a live availability check.
- Header shows `reading as guest · Sign in` or `logged in as {handle} · Log off`.
- Members only ever see handles, never emails.

**Forum**

- Thread list per area, pinned threads first, then by latest reply; shows author, reply count and time.
- Thread page shows posts oldest first, a SYSOP badge on sysop posts, "(edited)" when edited, and a reply box for members ("Join to reply" for guests).
- New thread form: area, title, message (Markdown).
- Guests see "Join to post" where the post buttons would be.
- Pinned sysop notice at the top of the forum, edited from the moderation dashboard.
- Cloud Function keeps `replyCount`, `lastReplyAt` and `postCount` up to date.

**Wiki & library**

- Library page: search box (title and description), folder chips with counts, list with name, type tag and date.
- Document page: rendered Markdown, attachments with download size, related items from the same folder, "Discuss in the forum" link.
- Add to library (sysop): upload a file or write a page, set title, folder and description, save as draft or publish; edit and delete existing items.

**Moderation tools** (sysop only, at `/mod`, plus inline buttons)

- **Inline on every post and thread:** hide / unhide (with a reason), delete, pin / unpin, lock / unlock, move to another area.
- **Reports:** members tap "Report" on a post and pick a reason (spam, rude, off-topic, other). The dashboard lists open reports with the post, so the sysop can hide it, dismiss the report, or act on the member.
- **Members:** search by handle; view a member's posts; mute (can read, can't post), ban (with reason) or restore; see their email if needed to contact them.
- **Bulk clean-up:** "hide all posts by this member" for spammers.
- **Word filter:** a list of banned words; posts containing one are held as hidden until approved.
- **Forum switch:** close the forum to new posts site-wide (read-only mode) with one toggle.
- **Mod log:** every moderation action recorded with who, what, when and why.
- **Dashboard counts:** open reports, new members this week, posts today.

## Build phases

Six phases, each ending in something to open and check on a phone before the next one starts.

1. **Foundation.** Vite project, Firebase config, GitHub Actions deploy, home page ported from `garage-terminal.html` with its Forum and Wiki links pointing at the new pages.
   - Done when: the home page is live on the Firebase address and a push to `main` redeploys it.
2. **Sign-in and handles.** Google sign-in, handle picker, header states, `users` / `handles` / `private` collections and their rules.
   - Done when: Ryan can sign in, claim a handle, and a second account can't take the same one.
3. **Forum.** Areas, thread list, thread page, new thread, replies, Markdown rendering, Cloud Function counters, rate limit.
   - Done when: a guest can read, a member can post and reply, and counts update.
4. **Moderation.** Admin check, inline mod buttons, reports, `/mod` dashboard, mute and ban, word filter, forum switch, sysop notice, mod log.
   - Done when: Ryan can hide, lock, pin, ban and clear a report from his phone, and each action shows in the mod log.
5. **Wiki and library.** Library page, document page, add-to-library page with file upload and page writing, drafts, Storage rules.
   - Done when: a PDF uploaded from a phone can be found and downloaded by a guest.
6. **Polish and launch.** Rules tests passing, phone layout check, empty states ("No threads yet. Start one."), 404 page, then point a custom domain at it when there is one.
   - Done when: the rules tests pass and every page works at phone width.

## Prompt for Claude Code

```
Read PLAN.md in this repo. It's the full spec for my website, Garage Terminal:
a home page, an open forum (anyone reads, members with a Google sign-in and a
handle post), a wiki/library that only I (the sysop) can add to, and
moderation tools. garage-terminal.html is the current home page; match its
look everywhere. The Firebase project is already set up (details at the top
of PLAN.md).

Work one phase at a time from "Build phases". Before writing code for a
phase, tell me in plain language what you'll build and anything you need
from me (Firebase settings, secrets, my user ID). At the end of each phase,
deploy, give me the link and a short list of things to check on my phone,
then stop and wait for my OK before starting the next phase.

Rules that matter most:
- Security is enforced in Firestore and Storage rules, never only in the page.
- Never show members' emails to other members.
- Sanitize all user text before rendering it.
- Keep the code simple and commented so future changes are easy.

Start with Phase 1.
```
