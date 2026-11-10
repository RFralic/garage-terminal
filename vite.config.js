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
      if (/^\/(forum|wiki|join)$/.test(path)) req.url = `${path}/${query ? '?' + query : ''}`;
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
        wiki: page('wiki/index.html'),
        join: page('join/index.html'),
        notFound: page('404.html'),
      },
    },
  },
});
