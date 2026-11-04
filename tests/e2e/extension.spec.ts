import { test, expect, patchSettings } from './fixtures';

// A mate-in-one for White: Qh5xf7#  (Scholar's mate pattern)
const MATE_IN_1 = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

test('service worker boots and the manifest is the MOTH MV3 manifest', async ({ sw }) => {
  const m = await sw.evaluate(() => chrome.runtime.getManifest());
  expect(m.manifest_version).toBe(3);
  expect(m.name).toBe('MOTH Chess');
  // no static host permissions; website access is opt-in only
  expect(m.host_permissions ?? []).toEqual([]);
  expect(m.optional_host_permissions).toEqual(['https://lichess.org/*', 'https://www.chess.com/*']);
});

test('popup renders with enable switch and board launcher', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto(ext('popup.html'));
  await expect(page.getByRole('switch', { name: 'Enable MOTH Chess' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Open analysis board' })).toBeVisible();
});

test('built-in board runs the bundled engine (MOTH by default) locally and finds mate in one', async ({ context, ext }) => {
  const external: string[] = [];
  context.on('request', (r) => { if (!r.url().startsWith('chrome-extension://') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });
  const page = await context.newPage();
  await page.goto(ext(`board.html?fen=${encodeURIComponent(MATE_IN_1)}`));
  await expect(page.getByRole('heading', { name: 'Analyze', exact: true })).toBeVisible();
  // engine result: White mates in 1, best move shown in SAN
  await expect(page.locator('.line .score').first()).toHaveText('+M1');
  await expect(page.locator('.line .pv b').first()).toHaveText('Qxf7#');
  await page.screenshot({ path: 'test-results/board-analysis.png' });
  expect(external, 'no network requests outside the extension').toEqual([]);
});

test('starting position analysis reaches the requested depth with 3 lines', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto(ext('board.html?tab=analysis'));
  await expect(page.locator('.line')).toHaveCount(3);
  await expect(page.getByText(/depth ([89]|[1-9][0-9])/).first()).toBeVisible({ timeout: 80_000 });
});

test('playing a move on the board updates the position and the move list', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto(ext(`board.html?fen=${encodeURIComponent(MATE_IN_1)}`));
  const line = page.locator('.line').first();
  await expect(line.locator('.pv b')).toHaveText('Qxf7#');
  await line.click(); // clicking a suggestion plays it on the built-in board
  await expect(page.getByText('Checkmate', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Qxf7#' })).toBeVisible();
});

test('Workspace 3.0: every workspace and section opens; advanced tools sit behind "More tools" in Simple mode', async ({ context, ext, sw }) => {
  test.setTimeout(180_000);
  await patchSettings(sw, { engine: { depth: 8 } }); // keep the CPU free for the UI walk
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ext('board.html'));
  // first screen is Home with the four main actions
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  for (const a of ['Analyze a position', 'Review a game', 'Train', 'Play MOTH']) await expect(page.locator('.tile.action', { hasText: a })).toBeVisible();
  await page.screenshot({ path: 'test-results/section-home.png' });
  // Engine Lab is hidden in Simple mode
  await expect(page.getByRole('navigation', { name: 'MOTH workspaces' }).getByRole('button', { name: 'Engine Lab', exact: true })).toHaveCount(0);
  const plan: [string, string[], string[]][] = [
    ['Analyze', ['Evaluate', 'Game review', 'Openings', 'Endgame'], ['Explain', 'Threats', 'Variation tree', 'What-if']],
    ['Train', ['Coach', 'Practice', 'Play MOTH'], []],
    ['Library', ['Games', 'Player DNA'], []],
  ];
  for (const [ws, basic, adv] of plan) {
    await page.getByRole('navigation', { name: 'MOTH workspaces' }).getByRole('button', { name: ws, exact: true }).click();
    await expect(page.getByRole('heading', { name: ws, exact: true })).toBeVisible();
    for (const s of basic) {
      await page.locator('.sections').getByRole('tab', { name: s, exact: true }).click();
      await expect(page.locator('.page-head .badge')).toHaveText(s);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/section-${s.toLowerCase().replace(/[^a-z]+/g, '-')}.png` });
    }
    for (const s of adv) {
      await page.getByRole('button', { name: /More tools|Explain|Threats|Variation tree|What-if/ }).first().click();
      await page.getByRole('menuitem', { name: new RegExp(`^${s}`) }).click();
      await expect(page.locator('.page-head .badge')).toHaveText(s);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/section-${s.toLowerCase().replace(/[^a-z]+/g, '-')}.png` });
    }
  }
  // the last section is remembered across reloads
  await page.reload();
  await expect(page.locator('.page-head .badge')).toHaveText('Player DNA');
  // Full mode shows Engine Lab and the advanced tabs inline
  await page.goto(ext('options.html'));
  await page.getByRole('group', { name: 'Interface mode' }).getByRole('button', { name: 'Full' }).click();
  await page.goto(ext('board.html?tab=analysis'));
  await expect(page.locator('.sections').getByRole('tab', { name: 'Variation tree', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'MOTH workspaces' }).getByRole('button', { name: 'Engine Lab', exact: true }).click();
  await expect(page.locator('.page-head .badge')).toHaveText('MOTH Engine');
  expect(errors).toEqual([]);
});

test('settings persist across reloads (chrome.storage.local)', async ({ context, ext, sw }) => {
  const options = await context.newPage();
  await options.goto(ext('options.html'));
  await expect(options.getByRole('heading', { name: /Settings/ })).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(ext('popup.html'));
  await options.screenshot({ path: 'test-results/settings.png', fullPage: true });
  const toggle = popup.getByRole('switch', { name: 'Move arrows' });
  await expect(toggle).toBeChecked();
  await popup.screenshot({ path: 'test-results/popup.png' });
  await toggle.setChecked(false, { force: true });
  await expect(toggle).not.toBeChecked();
  await popup.reload();
  await expect(popup.getByRole('switch', { name: 'Move arrows' })).not.toBeChecked();
  const stored = await sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  expect(stored).toContain('"arrows":false');
});

test('fair play: live/competitive pages are blocked by the service worker', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto(ext('popup.html'));
  const verdicts = await page.evaluate(async () => {
    const urls = [
      'https://lichess.org/tv', 'https://lichess.org/abcdEFGH', 'https://lichess.org/tournament/xyz',
      'https://www.chess.com/play/online', 'https://www.chess.com/game/live/123456', 'https://www.chess.com/puzzles/rush',
      'https://lichess.org/analysis', 'https://www.chess.com/analysis', 'https://www.chess.com/play/computer', 'https://example.com/',
    ];
    const out: Record<string, string> = {};
    for (const url of urls) out[url] = (await chrome.runtime.sendMessage({ type: 'tab-status', tabId: -1, url })).state;
    return out;
  });
  expect(verdicts['https://lichess.org/tv']).toBe('blocked');
  // finished-game pages are allowed only once the page shows the game is over; by URL they ask for site access
  expect(verdicts['https://lichess.org/abcdEFGH']).toBe('needs-permission');
  expect(verdicts['https://lichess.org/tournament/xyz']).toBe('blocked');
  expect(verdicts['https://www.chess.com/play/online']).toBe('blocked');
  expect(verdicts['https://www.chess.com/game/live/123456']).toBe('needs-permission');
  expect(verdicts['https://www.chess.com/puzzles/rush']).toBe('blocked');
  // analysis boards are supported but need explicit user permission first
  expect(verdicts['https://lichess.org/analysis']).toBe('needs-permission');
  expect(verdicts['https://www.chess.com/analysis']).toBe('needs-permission');
  expect(verdicts['https://www.chess.com/play/computer']).toBe('needs-permission'); // unrated games vs bots
  expect(verdicts['https://example.com/']).toBe('unsupported');
});

test('no content script is registered before the user grants site access', async ({ sw }) => {
  const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  expect(scripts).toEqual([]);
});
