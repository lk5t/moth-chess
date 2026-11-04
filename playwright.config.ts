import { defineConfig } from '@playwright/test';

// Browser integration tests load the compiled dist/ as an unpacked extension in Chromium.
// Run `npm run build` first (npm run test:e2e does both).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 45_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
