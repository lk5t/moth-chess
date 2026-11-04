// Renders the MOTH moth icon (public/icons/moth.svg) to PNG sizes using sharp.
// The PNGs are committed, so this only needs re-running if the SVG changes.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); } catch { console.error('Install sharp (npm i -D sharp) to regenerate icons.'); process.exit(1); }
const svg = readFileSync(resolve(root, 'public/icons/moth.svg'));
for (const size of [16, 32, 48, 128]) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(resolve(root, `public/icons/icon${size}.png`));
  console.log(`icon${size}.png`);
}
