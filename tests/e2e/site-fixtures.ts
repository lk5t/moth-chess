// Stand-in third-party pages for overlay tests (no real site is contacted; requests are fulfilled locally).
// The Lichess fixture mimics chessground's DOM: <cg-container><cg-board><piece class="white king"
// style="transform: translate(Xpx, Ypx)">, the orientation class on .cg-wrap, and the analysis move
// tree (.tview2 move san, .active on the current move).
import { test as base, expect, chromium, type BrowserContext } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist');

export interface FixtureOpts { fen: string; orientation?: 'white' | 'black'; size?: number; moves?: string[]; live?: boolean; tall?: boolean; fenField?: boolean }

export function lichessPage(o: FixtureOpts): string {
  const size = o.size ?? 480;
  return `<!doctype html><html><head><title>Analysis board • lichess.org</title>
<style>body{margin:0;background:#161512;${o.tall ? 'height:3000px;' : ''}} .main-board{position:absolute;left:60px;top:60px} cg-container{display:block;position:relative;background:#b58863}
piece{position:absolute;left:0;top:0}</style></head>
<body><main class="analyse"><div class="main-board"><div class="cg-wrap orientation-${o.orientation ?? 'white'}"><cg-container style="width:${size}px;height:${size}px"><cg-board></cg-board></cg-container></div></div>
${o.moves ? `<div class="analyse__moves"><div class="tview2">${o.moves.map((m, i) => `<move${i === o.moves!.length - 1 ? ' class="active"' : ''}><san>${m}</san></move>`).join('')}</div></div>` : ''}
${o.fenField ? `<div class="analyse__underboard"><div class="copyables"><input class="copyable" spellcheck="false" value="${o.fen}"></div></div>` : ''}
${o.live ? '<div class="rclock rclock-white running">0:59</div>' : ''}</main>
<script>
const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
window.layout = (fen, size, orientation) => {
  const c = document.querySelector('cg-container'); c.style.width = size + 'px'; c.style.height = size + 'px';
  document.querySelector('.cg-wrap').className = 'cg-wrap orientation-' + orientation;
  const b = document.querySelector('cg-board'); b.innerHTML = '';
  const sq = size / 8;
  fen.split(' ')[0].split('/').forEach((row, r) => { let f = 0; for (const ch of row) { if (/\\d/.test(ch)) { f += Number(ch); continue; }
    const el = document.createElement('piece'); el.className = (ch === ch.toUpperCase() ? 'white ' : 'black ') + NAMES[ch.toLowerCase()];
    const col = orientation === 'white' ? f : 7 - f, rr = orientation === 'white' ? r : 7 - r;
    el.style.width = sq + 'px'; el.style.height = sq + 'px'; el.style.transform = 'translate(' + col * sq + 'px, ' + rr * sq + 'px)'; b.appendChild(el); f++; } });
};
layout(${JSON.stringify(o.fen)}, ${size}, ${JSON.stringify(o.orientation ?? 'white')});
</script></body></html>`;
}

/** Context with a test copy of dist/ that pre-grants the supported origins (headless cannot click the prompt). */
export const test = base.extend<{ context: BrowserContext; serve: (path: string, o: FixtureOpts) => Promise<void> }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'moth-dist-granted-'));
    cpSync(DIST, dir, { recursive: true });
    const m = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
    m.host_permissions = m.optional_host_permissions;
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(m));
    const context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'moth-e2e-')), {
      ...(process.env.MOTH_BROWSER ? { executablePath: process.env.MOTH_BROWSER } : { channel: 'chromium' }), headless: true, viewport: { width: 1400, height: 900 },
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    });
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await expect.poll(async () => (await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, { timeout: 15_000 }).toBe(2);
    await use(context);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  },
  serve: async ({ context }, use) => {
    await use(async (path, o) => {
      await context.route(`https://lichess.org${path}`, (route) => route.fulfill({ contentType: 'text/html', body: lichessPage(o) }));
    });
  },
});
export { expect };
