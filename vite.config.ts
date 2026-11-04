import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Pass 1 of the build: all extension pages (popup, options, full board, overlay frame).
 * Extension pages may use ES modules, so Rollup can share chunks between them.
 * Content script and service worker are built separately by scripts/build.mjs
 * because content scripts must be classic (non-module) single files.
 */
export default defineConfig({
  base: '',
  plugins: [react()],
  publicDir: 'public',
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        options: resolve(__dirname, 'options.html'),
        board: resolve(__dirname, 'board.html'),
        overlay: resolve(__dirname, 'overlay.html'),
        control: resolve(__dirname, 'control.html'),
        welcome: resolve(__dirname, 'welcome.html'),
      },
    },
  },
});
