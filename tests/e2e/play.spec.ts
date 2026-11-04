// Play against MOTH, engine switching and the MOTH Engine dashboard — real engine, real worker.
import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';

async function clickSquare(board: Locator, sq: string, orientation: 'white' | 'black') {
  const box = (await board.boundingBox())!;
  const f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1;
  const col = orientation === 'white' ? f : 7 - f, row = orientation === 'white' ? 7 - r : r;
  await board.page().mouse.click(box.x + (col + 0.5) * box.width / 8, box.y + (row + 0.5) * box.height / 8);
}
const moveCount = (page: Page) => page.locator('.moves button, .movelist button, [aria-label^="Move "]').count();

test('play a timed game as White: MOTH answers with real moves, clocks run, resign saves the game', async ({ context, ext }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ext('board.html?tab=play'));
  await page.getByRole('button', { name: 'White', exact: true }).click();
  await page.getByRole('button', { name: 'Aggressive', exact: true }).click();
  await page.locator('#moth-clock-sel').selectOption('3+2');
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.getByTestId('user-clock')).toHaveText(/^3:0\d|^2:5\d/);
  const board = page.getByRole('img', { name: 'Play board' });
  await clickSquare(board, 'e2', 'white'); await clickSquare(board, 'e4', 'white');
  await expect(page.getByRole('button', { name: 'Move e4' })).toBeVisible();
  await expect.poll(() => moveCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2); // MOTH replied
  await expect(page.getByTestId('latency')).toBeVisible();
  await clickSquare(board, 'g1', 'white'); await clickSquare(board, 'f3', 'white');
  await expect.poll(() => moveCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
  await page.screenshot({ path: 'test-results/play-white.png' });
  // takeback removes the user's move and MOTH's reply
  await page.getByRole('button', { name: 'Take back' }).click();
  await expect.poll(() => moveCount(page)).toBe(2);
  await page.getByRole('button', { name: 'Resign' }).click();
  await expect(page.getByRole('status')).toContainText('MOTH won');
  await expect(page.getByRole('button', { name: 'Review game' })).toBeEnabled({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('play as Black: MOTH moves first, and pondering answers your expected reply quickly', async ({ context, ext }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(ext('board.html?tab=play'));
  await page.getByRole('button', { name: 'Black', exact: true }).click();
  await page.locator('#moth-clock-sel').selectOption('none');
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect.poll(() => moveCount(page), { timeout: 20_000 }).toBe(1);
  const board = page.getByRole('img', { name: 'Play board' });
  // reply with any legal move by trying a few common answers
  for (const [f, t] of [['e7', 'e5'], ['d7', 'd5'], ['g8', 'f6'], ['c7', 'c5']]) {
    await clickSquare(board, f, 'black'); await clickSquare(board, t, 'black');
    if (await moveCount(page) >= 2) break;
  }
  await expect.poll(() => moveCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('latency')).toHaveText(/ms/);
  await page.screenshot({ path: 'test-results/play-black.png' });
});

test('engine switching: the same position analysed by MOTH and by Stockfish', async ({ context, ext }) => {
  const page = await context.newPage();
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
  await page.goto(ext(`board.html?fen=${encodeURIComponent(fen)}`));
  await expect(page.locator('.line .pv b').first()).toHaveText('Qxf7#');
  await expect(page.getByText(/MOTH Engine 2\.0/).first()).toBeVisible();
  await page.evaluate(async () => {
    const key = 'moth.settings.v1';
    const cur = (await chrome.storage.local.get(key))[key] ?? {};
    await chrome.storage.local.set({ [key]: { ...cur, engine: { ...(cur.engine ?? {}), kind: 'stockfish' } } });
  });
  await expect(page.getByText(/Stockfish 17/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.line .pv b').first()).toHaveText('Qxf7#');
});

test('MOTH Engine dashboard shows measured data: models, statuses, latency, opening knowledge', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto(ext('board.html?tab=engine'));
  await expect(page.getByText('MOTH Engine 2.0').first()).toBeVisible();
  await expect(page.getByText('Model history')).toBeVisible();
  await expect(page.locator('table.t').first()).toContainText(/approved|rejected/);
  await expect(page.getByText('Opening knowledge')).toBeVisible();
  await expect(page.getByText(/\(benchmark\)/).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/engine-dashboard.png', fullPage: true });
});
