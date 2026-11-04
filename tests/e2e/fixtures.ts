import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist');

export const test = base.extend<{ context: BrowserContext; sw: Worker; extId: string; ext: (path: string) => string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDir = mkdtempSync(resolve(tmpdir(), 'moth-e2e-'));
    const context = await chromium.launchPersistentContext(userDir, {
      ...(process.env.MOTH_BROWSER ? { executablePath: process.env.MOTH_BROWSER } : { channel: 'chromium' }), // new headless mode supports extensions; MOTH_BROWSER = Brave
      headless: true,
      viewport: { width: 1400, height: 950 },
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },
  extId: async ({ sw }, use) => { await use(new URL(sw.url()).host); },
  ext: async ({ extId }, use) => { await use((p: string) => `chrome-extension://${extId}/${p}`); },
});

export const expect = test.expect;

/** Merge a settings patch into stored settings, after the install-time migration has written them. */
export async function patchSettings(sw: Worker, patch: Record<string, Record<string, unknown>>) {
  await expect.poll(() => sw.evaluate(async () => !!(await chrome.storage.local.get('moth.settings.v1'))['moth.settings.v1']), { timeout: 10_000 }).toBe(true);
  await sw.evaluate(async (p) => {
    const k = 'moth.settings.v1';
    const cur = (await chrome.storage.local.get(k))[k] ?? {};
    const next: Record<string, unknown> = { ...cur };
    for (const [sec, v] of Object.entries(p)) next[sec] = { ...(cur[sec] ?? {}), ...v };
    await chrome.storage.local.set({ [k]: next });
  }, patch);
}
