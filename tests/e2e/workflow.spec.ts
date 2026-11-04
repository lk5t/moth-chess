// Full local training loop with the real engine: import PGN → review → Coach exercise on the practice board
// → result saved → Dashboard metrics → Memory persistence across a reload.
import { test, expect } from './fixtures';
import type { Page, Locator } from '@playwright/test';

// Black ("me") blunders with 3...Nf6?? allowing Qxf7#.
const PGN = `[Event "Casual"]
[White "opponent"]
[Black "me"]
[Result "1-0"]
[Date "2026.11.01"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

async function clickSquare(board: Locator, sq: string, orientation: 'white' | 'black') {
  const box = (await board.boundingBox())!;
  const f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1;
  const col = orientation === 'white' ? f : 7 - f;
  const row = orientation === 'white' ? 7 - r : r;
  await board.page().mouse.click(box.x + (col + 0.5) * box.width / 8, box.y + (row + 0.5) * box.height / 8);
}

async function setReviewDepth(page: Page, depth: number) {
  await page.evaluate(async (d) => {
    const key = 'moth.settings.v1';
    const cur = (await chrome.storage.local.get(key))[key] ?? {};
    await chrome.storage.local.set({ [key]: { ...cur, review: { ...(cur.review ?? {}), depth: d } } });
  }, depth);
}

test('import → review → coach exercise → dashboard, all local and persistent', async ({ context, ext }) => {
  test.setTimeout(180_000);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ext('board.html?tab=review'));
  await setReviewDepth(page, 10);

  // import
  await page.locator('#moth-user').fill('me');
  await page.getByLabel('PGN text').fill(PGN);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Imported 1 game/)).toBeVisible();

  // duplicate detection
  await page.getByLabel('PGN text').fill(PGN);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/1 duplicate skipped/)).toBeVisible();

  // review with the real engine
  await page.getByRole('button', { name: /Review game/ }).click();
  await expect(page.getByText('Review complete')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Export annotated PGN' })).toBeVisible();
  await expect(page.getByText(/Turning point: 3\.\.\.Nf6 \(blunder\)/)).toBeVisible();
  await page.screenshot({ path: 'test-results/workflow-review.png' });

  // coach: an exercise was generated from the user's own blunder
  await page.getByRole('button', { name: 'Train', exact: true }).click();
  await page.getByRole('tab', { name: 'Coach', exact: true }).click();
  await expect(page.locator('.stat').filter({ hasText: 'Exercises' }).locator('.v')).not.toHaveText('0');
  await page.getByRole('button', { name: 'Custom session' }).click();
  await expect(page.getByText(/Exercise 1\/1/)).toBeVisible();
  await expect(page.getByText('Black to move.')).toBeVisible();
  const practice = page.getByRole('img', { name: 'Practice board' });
  await clickSquare(practice, 'g7', 'black');
  await clickSquare(practice, 'g6', 'black');
  // g6 defends f7 against mate — engine-validated as correct or an equal alternative
  await expect(page.locator('.banner').filter({ hasText: /Correct!|Good alternative\./ })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: 'test-results/workflow-coach.png' });
  await page.getByRole('button', { name: 'Finish' }).click();

  // dashboard reflects the review and the training attempt
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('tab', { name: 'Progress', exact: true }).click();
  await expect(page.getByText('Games reviewed').locator('..')).toContainText('1');
  await page.screenshot({ path: 'test-results/workflow-dashboard.png' });

  // persistence: the game is still in Memory after a reload
  await page.reload();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('tab', { name: 'Games', exact: true }).click();
  await expect(page.getByText(/opponent.*me|me.*opponent/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('What-If simulator explores a variation without modifying the source game', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto(ext('board.html'));
  await page.locator('#moth-fen').fill('1. e4 e5 2. Nf3 Nc6');
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move Nc6' })).toBeVisible();
  const fenBefore = await page.locator('#moth-fen').getAttribute('placeholder');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await page.getByRole('button', { name: /More tools/ }).click();
  await page.getByRole('menuitem', { name: /What-if/ }).click();
  await page.getByRole('button', { name: /Clone current position/ }).click();
  const sandbox = page.getByRole('img', { name: 'Sandbox board' });
  await clickSquare(sandbox, 'f1', 'white');
  await clickSquare(sandbox, 'b5', 'white');
  await expect(page.getByText('Bb5', { exact: true })).toBeVisible();
  await clickSquare(sandbox, 'a7', 'white');
  await clickSquare(sandbox, 'a6', 'white');
  await expect(page.getByText('Bb5 a6', { exact: true })).toBeVisible();
  // the engine compares before/after
  await expect(page.locator('.badge').filter({ hasText: /^Δ / })).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Simulation saved')).toBeVisible();
  await page.screenshot({ path: 'test-results/workflow-whatif.png' });
  // the main board / source game is untouched
  expect(await page.locator('#moth-fen').getAttribute('placeholder')).toBe(fenBefore);
  await expect(page.getByRole('button', { name: 'Move Nc6' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Bb5' })).toHaveCount(0);
  // transfer to Neural Map
  await page.getByRole('button', { name: '→ Neural Map' }).click();
  await expect(page.locator('.page-head .badge')).toHaveText('Neural Map');
  await expect(page.getByRole('tree', { name: 'Variation graph' })).toBeVisible();
  await page.screenshot({ path: 'test-results/workflow-neural.png' });
});
