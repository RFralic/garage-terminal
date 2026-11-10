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
| `404.html` | Not-found page |
| `src/styles/base.css` | Shared look: colors, fonts, header, footer, terminal boxes |
| `src/styles/home.css` | Home-page-only styles |
| `public/` | Files copied as-is (images, favicon) |
| `vite.config.js` | List of pages to build; add new pages here |
| `firebase.json` | Hosting settings (clean URLs, caching, security headers) |
| `.github/workflows/deploy.yml` | Auto-deploy: `main` goes live, pull requests get a preview link |

## Working on it

```bash
npm install
npm run dev      # local dev server
npm run build    # production build into dist/
```

Deploys happen automatically through GitHub Actions. Nothing is deployed by hand.
The workflow needs the repo secret `FIREBASE_SERVICE_ACCOUNT` (a service-account JSON key for project
`garage-terminal-15499`).
