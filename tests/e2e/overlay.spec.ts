// Overlay on a (mocked) third-party analysis board.
// Headless Chromium cannot click the optional-permission prompt, so these tests run against a copy of dist/
// whose manifest pre-grants the two supported origins. Everything else is the production build. The real
// lichess.org is never contacted: every request to it is answered by page.route with a local fixture page.
import { test as base, expect, chromium, type BrowserContext, type Page, type Frame } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist');
const FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

function lichessFixture(fen: string, extraBody = ''): string {
  const names: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const pieces: string[] = [];
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { c += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'white' : 'black';
      pieces.push(`<piece class="${color} ${names[ch.toLowerCase()]}" style="transform: translate(${c * 60}px, ${r * 60}px);"></piece>`);
      c++;
    }
  });
  return `<!doctype html><html><head><title>Analysis board • lichess.org</title>
<style>body{margin:0;background:#161512} .main-board{position:absolute;left:40px;top:40px} cg-container{display:block;width:480px;height:480px;position:relative;background:#b58863}
piece{position:absolute;width:60px;height:60px;left:0;top:0}</style></head>
<body><main class="analyse"><div class="main-board"><div class="cg-wrap orientation-white"><cg-container><cg-board>${pieces.join('')}</cg-board></cg-container></div></div></main>${extraBody}</body></html>`;
}

const test = base.extend<{ context: BrowserContext }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'moth-dist-granted-'));
    cpSync(DIST, dir, { recursive: true });
    const m = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
    m.host_permissions = m.optional_host_permissions; // test-only pre-grant
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(m));
    const context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'moth-e2e-')), {
      ...(process.env.MOTH_BROWSER ? { executablePath: process.env.MOTH_BROWSER } : { channel: 'chromium' }), headless: true, viewport: { width: 1400, height: 900 },
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    });
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    // wait until the service worker has registered the analysis-page content scripts
    await expect.poll(async () => (await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, { timeout: 15_000 }).toBe(2);
    await context.route('https://lichess.org/**', (route) => {
      const u = new URL(route.request().url());
      const live = u.searchParams.has('live');
      return route.fulfill({ contentType: 'text/html', body: lichessFixture(FEN, live ? '<div class="rclock rclock-white running">0:59</div>' : '') });
    });
    await use(context);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  },
});

const overlayFrame = async (page: Page): Promise<Frame> => {
  await expect.poll(() => page.frames().some((f) => f.url().includes('/overlay.html')), { timeout: 15_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes('/overlay.html'))!;
};

test('overlay appears on a supported analysis page, reads the board and shows local engine lines', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`https://lichess.org/analysis/standard/${FEN.replace(/ /g, '_')}`);
  await expect(page.locator('moth-chess-host')).toHaveCount(1);
  const frame = await overlayFrame(page);
  await expect(frame.getByText('Qxf7#').first()).toBeVisible({ timeout: 45_000 });
  await expect(frame.getByText('+M1').first()).toBeVisible();
  // tabs required by the spec exist in the overlay
  for (const name of ['Analysis', 'Intelligence', 'Neural Map', 'Coach', 'Memory', 'Dashboard']) await expect(frame.getByRole('tab', { name })).toBeVisible();
  await page.screenshot({ path: 'test-results/overlay-lichess.png' });
});

test('arrows layer never intercepts clicks on the site board', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`https://lichess.org/analysis/standard/${FEN.replace(/ /g, '_')}`);
  await overlayFrame(page);
  // the element under the centre of the board must still be the site's own board, not a MOTH layer
  const hit = await page.evaluate(() => {
    const r = document.querySelector('cg-container')!.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el?.tagName.toLowerCase();
  });
  expect(['piece', 'cg-board', 'cg-container']).toContain(hit);
});

test('fair play: overlay tears itself down as soon as a live clock appears', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`https://lichess.org/analysis/standard/${FEN.replace(/ /g, '_')}`);
  await overlayFrame(page);
  await page.evaluate(() => { const d = document.createElement('div'); d.className = 'rclock rclock-white running'; document.body.appendChild(d); });
  await expect(page.locator('moth-chess-host')).toHaveCount(0, { timeout: 5_000 });
  expect(page.frames().some((f) => f.url().includes('/overlay.html'))).toBe(false);
});

test('fair play: overlay never starts on an analysis URL that shows a running clock', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`https://lichess.org/analysis/standard/${FEN.replace(/ /g, '_')}?live=1`);
  await page.waitForTimeout(3000);
  await expect(page.locator('moth-chess-host')).toHaveCount(0);
});

test('no assistance on a game page that is still in progress, even with host access', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://lichess.org/AbCdEf12');
  await page.waitForTimeout(3000);
  await expect(page.locator('moth-chess-host')).toHaveCount(0);
});

test('3.0: a finished game becomes analysable; MOTH waits in standby until then and leaves when a clock runs', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://lichess.org/AbCdEf12');
  await page.waitForTimeout(2500);
  await expect(page.locator('moth-chess-host')).toHaveCount(0);
  await page.evaluate(() => { const d = document.createElement('div'); d.className = 'result-wrap'; d.textContent = '1-0'; document.body.appendChild(d); });
  await expect(page.locator('moth-chess-host')).toHaveCount(1, { timeout: 6_000 });
  const frame = await overlayFrame(page);
  await expect(frame.getByText('finished game').first()).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => { const d = document.createElement('div'); d.className = 'rclock rclock-white running'; document.body.appendChild(d); });
  await expect(page.locator('moth-chess-host')).toHaveCount(0, { timeout: 5_000 });
});
