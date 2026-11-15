// Vite build settings.
// Each page is its own HTML file. Add new pages to `input` below as phases add them
// (for example forum/thread.html, forum/new.html, join/index.html, mod/index.html).
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const page = (p) => resolve(import.meta.dirname, p);

// Firebase Hosting serves /forum from forum/index.html ("clean URLs").
// This makes the local dev server do the same, so links behave identically.
const cleanUrls = {
  name: 'clean-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [path, query = ''] = req.url.split('?');
      const q = query ? '?' + query : '';
      if (/^\/(forum|wiki|join|mod)$/.test(path)) req.url = `${path}/${q}`;
      else if (path === '/forum/new') req.url = `/forum/new.html${q}`;
      else if (path.startsWith('/forum/t/')) req.url = `/forum/thread.html${q}`; // same as firebase.json rewrite
      else if (['/apps/tap-drill-chart', '/apps/repclock', '/apps/home-projects', '/apps/logbook', '/apps/project-tracker', '/apps/morning-brief'].includes(path)) req.url = `${path}/${q}`;
      else if (path === '/wiki/add') req.url = `/wiki/add.html${q}`;
      else if (path.startsWith('/wiki/') && path !== '/wiki/' && !path.includes('.')) req.url = `/wiki/doc.html${q}`; // same as firebase.json rewrite
      next();
    });
  },
};

export default defineConfig({
  plugins: [cleanUrls],
  build: {
    // es2022: lets src/lib/firebase.js wait for the config at the top level.
    target: 'es2022',
    outDir: 'dist',
    // The Firebase SDK (auth + firestore) is ~170 KB gzipped; it's shared and cached across pages.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        home: page('index.html'),
        forum: page('forum/index.html'),
        forumThread: page('forum/thread.html'),
        forumNew: page('forum/new.html'),
        wiki: page('wiki/index.html'),
        wikiDoc: page('wiki/doc.html'),
        wikiAdd: page('wiki/add.html'),
        join: page('join/index.html'),
        mod: page('mod/index.html'),
        tapDrillChart: page('apps/tap-drill-chart/index.html'),
        repclock: page('apps/repclock/index.html'),
        homeProjects: page('apps/home-projects/index.html'),
        logbook: page('apps/logbook/index.html'),
        projectTracker: page('apps/project-tracker/index.html'),
        morningBrief: page('apps/morning-brief/index.html'),
        notFound: page('404.html'),
      },
    },
  },
});
