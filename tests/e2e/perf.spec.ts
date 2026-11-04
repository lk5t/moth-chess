// Phase 22 performance and stability measurements (real numbers written to test-results/perf.json).
// Assertions are generous ceilings for slow CI runners; the measured values are the point.
import { test, expect, patchSettings } from './fixtures';
import { writeFileSync, mkdirSync } from 'node:fs';

const results: Record<string, unknown> = {};
test.afterAll(() => { mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/perf.json', JSON.stringify(results, null, 1)); });

const MID = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 8';

test('startup and first analysis result for both engines', async ({ context, ext }) => {
  const page = await context.newPage();
  let t0 = Date.now();
  await page.goto(ext('board.html'));
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  results.homeVisibleMs = Date.now() - t0;
  for (const kind of ['moth', 'stockfish'] as const) {
    await page.goto(ext('options.html'));
    await page.getByLabel('Analysis engine').selectOption(kind);
    t0 = Date.now();
    await page.goto(ext(`board.html?tab=analysis&fen=${encodeURIComponent(MID)}`));
    await expect(page.locator('.line .pv b').first()).toBeVisible({ timeout: 30_000 });
    results[`${kind}FirstLineMs`] = Date.now() - t0;
    await expect(page.getByText(/depth (1[0-9]|[2-9][0-9])/).first()).toBeVisible({ timeout: 60_000 });
    results[`${kind}Depth10Ms`] = Date.now() - t0;
  }
  expect(results.mothFirstLineMs as number).toBeLessThan(15_000);
});

test('revisiting a position is answered from the cache; switching positions cancels the old search', async ({ context, ext, sw }) => {
  await patchSettings(sw, { engine: { depth: 10 } });
  const page = await context.newPage();
  await page.goto(ext('board.html?tab=analysis'));
  await page.getByText('Load a FEN or PGN').click();
  await page.locator('#moth-fen').fill('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.getByText(/depth 10(?!…)/).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Previous move' }).click();
  await expect(page.getByText(/depth 10(?!…)/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.line').first()).toBeVisible({ timeout: 30_000 });
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Next move' }).click();
  await expect(page.getByText(/· cached/)).toBeVisible({ timeout: 10_000 });
  results.cachedRevisitMs = Date.now() - t0;
  expect(results.cachedRevisitMs as number).toBeLessThan(3000);
});

test('memory stays bounded over repeated navigation and reloads', async ({ context, ext }) => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    const m = await cdp.send('Performance.getMetrics');
    return (m.metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576;
  };
  await page.goto(ext('board.html?tab=analysis'));
  await page.waitForTimeout(3000);
  const first = await heap();
  const nav = page.getByRole('navigation', { name: 'MOTH workspaces' });
  for (let i = 0; i < 5; i++) {
    for (const ws of ['Home', 'Analyze', 'Train', 'Library']) { await nav.getByRole('button', { name: ws, exact: true }).click(); await page.waitForTimeout(250); }
  }
  const afterNav = await heap();
  for (let i = 0; i < 5; i++) { await page.reload(); await page.waitForTimeout(800); }
  const afterReload = await heap();
  results.heapMb = { first: +first.toFixed(1), afterNavigation: +afterNav.toFixed(1), afterReloads: +afterReload.toFixed(1) };
  expect(errors).toEqual([]);
  expect(afterNav).toBeLessThan(first * 3 + 30);
});

test('idle engine workers are shut down; Home starts no engine', async ({ context, ext, sw }) => {
  await patchSettings(sw, { performance: { idleSec: 10, profile: 'custom' } });
  const page = await context.newPage();
  await page.goto(ext('board.html?tab=analysis'));
  await expect(page.locator('.line').first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Stop/ }).click();
  const t0 = Date.now();
  await expect(page.getByText('Engine asleep').first()).toBeVisible({ timeout: 25_000 });
  results.idleShutdownMs = Date.now() - t0;
  // Home: no analysis is started
  const home = await context.newPage();
  await home.goto(ext('board.html?tab=home'));
  await home.waitForTimeout(2500);
  await expect(home.getByText('Analysing')).toHaveCount(0);
});

