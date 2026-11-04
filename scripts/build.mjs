// MOTH Chess production build.
//   Pass 1: extension pages (vite.config.ts)          -> dist/*.html + dist/assets
//   Pass 2: content script as a single classic IIFE   -> dist/content.js
//   Pass 3: background service worker (single ES file) -> dist/background.js
//   Pass 4: MOTH Engine workers (classic scripts)       -> dist/moth-worker.js, dist/moth-train-worker.js (assets: public/moth-engine/)
// Then verifies the output (manifest, engine assets, entry files).
import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const alias = { '@': resolve(root, 'src') };

if (!existsSync(resolve(root, 'public/engines/stockfish.js')) || !existsSync(resolve(root, 'public/engines/stockfish.wasm'))) {
  console.log('[build] engine not in public/engines yet, running copy-engine…');
  execFileSync(process.execPath, [resolve(root, 'scripts/copy-engine.mjs')], { stdio: 'inherit' });
}

console.log('[build] pass 1/4: extension pages');
await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'warn' });

console.log('[build] pass 2/4: content script');
await build({
  configFile: false,
  logLevel: 'warn',
  resolve: { alias },
  publicDir: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome110',
    lib: { entry: resolve(root, 'src/content/index.ts'), formats: ['iife'], name: 'MothChessContent', fileName: () => 'content.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

console.log('[build] pass 3/4: background service worker');
await build({
  configFile: false,
  logLevel: 'warn',
  resolve: { alias },
  publicDir: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome110',
    lib: { entry: resolve(root, 'src/background/index.ts'), formats: ['es'], fileName: () => 'background.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

console.log('[build] pass 4/4: MOTH Engine worker');
await build({
  configFile: false,
  logLevel: 'warn',
  resolve: { alias },
  publicDir: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome110',
    lib: { entry: resolve(root, 'src/moth-engine/worker.ts'), formats: ['iife'], name: 'MothEngineWorker', fileName: () => 'moth-worker.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

await build({
  configFile: false,
  logLevel: 'warn',
  resolve: { alias },
  publicDir: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome110',
    lib: { entry: resolve(root, 'src/moth-engine/train-worker.ts'), formats: ['iife'], name: 'MothTrainWorker', fileName: () => 'moth-train-worker.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

await build({
  configFile: false,
  logLevel: 'warn',
  resolve: { alias },
  publicDir: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome110',
    lib: { entry: resolve(root, 'src/moth-engine/lab-worker.ts'), formats: ['iife'], name: 'MothLabWorker', fileName: () => 'moth-lab-worker.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

execFileSync(process.execPath, [resolve(root, 'scripts/verify-dist.mjs')], { stdio: 'inherit' });
console.log('[build] done → dist/ is ready for brave://extensions → Load unpacked');
