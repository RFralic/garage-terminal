// Vite build settings.
// Each page is its own HTML file. Add new pages to `input` below as phases add them
// (for example forum/thread.html, forum/new.html, join/index.html, mod/index.html).
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const page = (p) => resolve(import.meta.dirname, p);

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        home: page('index.html'),
        forum: page('forum/index.html'),
        wiki: page('wiki/index.html'),
        notFound: page('404.html'),
      },
    },
  },
});
