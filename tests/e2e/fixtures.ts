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
      channel: 'chromium', // new headless mode supports extensions
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
