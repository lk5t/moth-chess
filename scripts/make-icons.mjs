// Renders public/icons/moth.svg to the PNG sizes used by the manifest, with the Chromium bundled
// with Playwright (no native image libraries needed). The PNGs are committed; re-run after editing the SVG.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const svg = readFileSync(resolve(root, 'public/icons/moth.svg'), 'utf8');
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  writeFileSync(resolve(root, `public/icons/icon${size}.png`), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  console.log(`icon${size}.png`);
  await page.close();
}
await browser.close();
