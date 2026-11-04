// Phase 14: graceful behaviour when engine files or models are unavailable (copy of dist with files removed).
import { test as base, expect, chromium, type BrowserContext } from '@playwright/test';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist');

const launch = async (mutate: (dir: string) => void): Promise<{ context: BrowserContext; ext: (p: string) => string; cleanup: () => Promise<void> }> => {
  const dir = mkdtempSync(resolve(tmpdir(), 'moth-dist-broken-'));
  cpSync(DIST, dir, { recursive: true });
  mutate(dir);
  const context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'moth-e2e-')), {
    ...(process.env.MOTH_BROWSER ? { executablePath: process.env.MOTH_BROWSER } : { channel: 'chromium' }), headless: true, viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  return { context, ext: (p) => `chrome-extension://${id}/${p}`, cleanup: async () => { await context.close(); rmSync(dir, { recursive: true, force: true }); } };
};

base('missing MOTH Engine binary: clear message, no restart loop, Stockfish still works', async () => {
  const { context, ext, cleanup } = await launch((d) => rmSync(resolve(d, 'moth-engine/moth.wasm')));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ext('board.html?tab=analysis'));
  await expect(page.getByText(/files are missing or damaged/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Restart engine' })).toBeVisible();
  await page.getByRole('button', { name: /Switch to Stockfish/ }).click();
  await expect(page.locator('.line .pv b').first()).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
  await cleanup();
});

base('missing network model: MOTH falls back to its classical evaluation and still analyses', async () => {
  const { context, ext, cleanup } = await launch((d) => {
    const reg = JSON.parse(readFileSync(resolve(d, 'moth-engine/models/registry.json'), 'utf8'));
    const act = reg.models.find((m: { id: string }) => m.id === reg.active);
    rmSync(resolve(d, `moth-engine/models/${act.file}`));
    writeFileSync(resolve(d, 'moth-engine/models/registry.json'), JSON.stringify(reg));
  });
  const page = await context.newPage();
  await page.goto(ext('board.html?tab=analysis'));
  await expect(page.locator('.line .pv b').first()).toBeVisible({ timeout: 30_000 });
  await cleanup();
});

base('corrupted settings are repaired on start-up without losing the extension', async () => {
  const { context, ext, cleanup } = await launch(() => {});
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ 'moth.settings.v1': 'garbage{' }));
  const page = await context.newPage();
  await page.goto(ext('board.html'));
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.goto(ext('options.html'));
  await expect(page.getByRole('heading', { name: /Settings/ })).toBeVisible();
  await cleanup();
});
