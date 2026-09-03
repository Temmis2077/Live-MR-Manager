import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir } from 'node:fs/promises';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

const classicScripts = [
  ['src/js/libs/Sortable.min.js', 'dist/js/libs/Sortable.min.js'],
  ['src/js/overlay/shared.js', 'dist/js/overlay/shared.js'],
];

export default defineConfig({
  root: 'src',
  // Tauri serves bundled pages from its own scheme, so root-absolute /assets URLs
  // break only after installation even though the development server works.
  base: './',
  plugins: [{
    name: 'preserve-classic-scripts',
    async closeBundle() {
      for (const [source, target] of classicScripts) {
        const output = resolve(projectRoot, target);
        await mkdir(resolve(output, '..'), { recursive: true });
        await copyFile(resolve(projectRoot, source), output);
      }
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'src/index.html'),
        lyricsView: resolve(projectRoot, 'src/lyrics-view.html'),
        overlayLyrics: resolve(projectRoot, 'src/overlay-lyrics.html'),
        overlayInfo: resolve(projectRoot, 'src/overlay-info.html'),
        devOverlay: resolve(projectRoot, 'src/dev-overlay.html'),
        styleLab: resolve(projectRoot, 'src/style-lab.html'),
      },
    },
  },
});
