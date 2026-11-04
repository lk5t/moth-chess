// On-board suggestions on (stand-in) supported analysis boards: automatic recognition, verified
// positions from the page's move list, arrow alignment in both orientations, resize, scroll,
// evaluation bar, unverified boards, fair-play removal.
import { test, expect } from './site-fixtures';
import type { Page } from '@playwright/test';

const MATE_FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
const MATE_MOVES = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6'];

interface Layer { board: { x: number; y: number; size: number; orientation: string }; layer: { x: number; y: number }; arrows: { from: string; to: string; rank: number; x1: number; y1: number; x2: number; y2: number }[]; evalBar: string | null }
const layer = async (page: Page): Promise<Layer | null> => {
  const raw = await page.locator('moth-chess-host').getAttribute('data-moth-layer');
  return raw ? (JSON.parse(raw) as Layer) : null;
};
const overlayFrame = async (page: Page) => {
  await expect.poll(() => page.frames().some((f) => f.url().includes('/overlay.html')), { timeout: 15_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes('/overlay.html'))!;
};
/** viewport centre of a square, computed from the page's own board element */
const centre = async (page: Page, sq: string, orientation: 'white' | 'black') => page.evaluate(([s, o]) => {
  const r = document.querySelector('cg-container')!.getBoundingClientRect();
  const f = s.charCodeAt(0) - 97, rank = Number(s[1]) - 1, q = r.width / 8;
  const col = o === 'white' ? f : 7 - f, row = o === 'white' ? 7 - rank : rank;
  return { x: r.left + (col + 0.5) * q, y: r.top + (row + 0.5) * q };
}, [sq, orientation] as const);

async function expectArrowOn(page: Page, from: string, to: string, orientation: 'white' | 'black') {
  await expect.poll(async () => (await layer(page))?.arrows.find((a) => a.rank === 0)?.from, { timeout: 45_000 }).toBe(from);
  const l = (await layer(page))!;
  const a = l.arrows.find((x) => x.rank === 0)!;
  expect(a.to).toBe(to);
  const f = await centre(page, from, orientation), t = await centre(page, to, orientation);
  expect(Math.abs(a.x1 - f.x)).toBeLessThan(1.5); expect(Math.abs(a.y1 - f.y)).toBeLessThan(1.5);
  expect(Math.abs(a.x2 - t.x)).toBeLessThan(1.5); expect(Math.abs(a.y2 - t.y)).toBeLessThan(1.5);
}

test('recognises the board automatically, verifies it from the move list and draws MOTH\'s move on it', async ({ context, serve }) => {
  await serve('/analysis', { fen: MATE_FEN, moves: MATE_MOVES });
  const page = await context.newPage();
  await page.goto('https://lichess.org/analysis');
  const frame = await overlayFrame(page);
  await expect(frame.getByText(/Verified position · move list/)).toBeVisible();
  await expect(frame.getByRole('combobox', { name: 'Engine', exact: true })).toHaveValue('moth');
  await expectArrowOn(page, 'h5', 'f7', 'white');
  await expect.poll(async () => (await layer(page))?.evalBar).toBe('+M1');
  await page.screenshot({ path: 'test-results/onboard-white.png' });
});

test('arrows align with a flipped board (Black at the bottom)', async ({ context, serve }) => {
  await serve('/analysis', { fen: MATE_FEN, moves: MATE_MOVES, orientation: 'black' });
  const page = await context.newPage();
  await page.goto('https://lichess.org/analysis');
  await overlayFrame(page);
  await expectArrowOn(page, 'h5', 'f7', 'black');
  await page.screenshot({ path: 'test-results/onboard-black.png' });
});

test('overlay follows board resizing and page scrolling', async ({ context, serve }) => {
  await serve('/analysis', { fen: MATE_FEN, moves: MATE_MOVES, tall: true });
  const page = await context.newPage();
  await page.goto('https://lichess.org/analysis');
  await overlayFrame(page);
  await expectArrowOn(page, 'h5', 'f7', 'white');
  // responsive layout: the site shrinks the board
  await page.evaluate((fen) => (window as unknown as { layout: (f: string, s: number, o: string) => void }).layout(fen, 360, 'white'), MATE_FEN);
  await expect.poll(async () => (await layer(page))?.board.size, { timeout: 5000 }).toBe(360);
  await expectArrowOn(page, 'h5', 'f7', 'white');
  // scrolling moves the board in the viewport; the layer must follow it
  await page.mouse.wheel(0, 250);
  await expect.poll(async () => Math.round((await layer(page))!.layer.y), { timeout: 5000 }).toBe(Math.round(60 - 250));
  await expectArrowOn(page, 'h5', 'f7', 'white');
});

test('a pieces-only board is never presented as verified', async ({ context, serve }) => {
  // middlegame placement, no FEN in the URL, no move list → side to move & castling unknown
  await serve('/analysis', { fen: 'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7' });
  const page = await context.newPage();
  await page.goto('https://lichess.org/analysis');
  const frame = await overlayFrame(page);
  await expect(frame.getByText('Unverified · pieces only')).toBeVisible();
  await expect(frame.getByText(/Side to move \(not shown by the page\)/)).toBeVisible();
  // no arrows until the user confirms the side to move
  await page.waitForTimeout(1500);
  expect((await layer(page))?.arrows.length ?? 0).toBe(0);
  await frame.getByRole('button', { name: 'White', exact: true }).click();
  await expect.poll(async () => (await layer(page))?.arrows.length ?? 0, { timeout: 45_000 }).toBeGreaterThan(0);
});

test('position changes are picked up automatically', async ({ context, serve }) => {
  await serve('/analysis', { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [] });
  const page = await context.newPage();
  await page.goto('https://lichess.org/analysis');
  const frame = await overlayFrame(page);
  await expect(frame.getByText(/Verified position/)).toBeVisible();
  // the user plays through to the mate-in-one position on the site's board
  await page.evaluate(([fen, moves]) => {
    (window as unknown as { layout: (f: string, s: number, o: string) => void }).layout(fen as string, 480, 'white');
    const tv = document.createElement('div'); tv.className = 'analyse__moves';
    tv.innerHTML = `<div class="tview2">${(moves as string[]).map((m, i, a) => `<move${i === a.length - 1 ? ' class="active"' : ''}><san>${m}</san></move>`).join('')}</div>`;
    document.querySelector('main')!.appendChild(tv);
  }, [MATE_FEN, MATE_MOVES] as const);
  await expectArrowOn(page, 'h5', 'f7', 'white');
});

test('the overlay and every arrow disappear when a live game starts', async ({ context, serve }) => {
  await serve('/analysis', { fen: MATE_FEN, moves: MATE_MOVES });
  const page = await context.newPage();
  await page.goto('https://lichess.org/analysis');
  await overlayFrame(page);
  await expectArrowOn(page, 'h5', 'f7', 'white');
  await page.evaluate(() => { const d = document.createElement('div'); d.className = 'rclock rclock-white running'; document.body.appendChild(d); });
  await expect(page.locator('moth-chess-host')).toHaveCount(0, { timeout: 5000 });
});

test('Lichess studies are supported; study pages with a running clock are not', async ({ context, serve }) => {
  await serve('/study/AbCdEfGh', { fen: MATE_FEN, moves: MATE_MOVES });
  const page = await context.newPage();
  await page.goto('https://lichess.org/study/AbCdEfGh');
  await overlayFrame(page);
  await expectArrowOn(page, 'h5', 'f7', 'white');
  await serve('/study/ZyXwVuTs', { fen: MATE_FEN, moves: MATE_MOVES, live: true });
  const p2 = await context.newPage();
  await p2.goto('https://lichess.org/study/ZyXwVuTs');
  await p2.waitForTimeout(2500);
  await expect(p2.locator('moth-chess-host')).toHaveCount(0);
});
