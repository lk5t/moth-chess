// Website integration: fair-play classification, board adapters helpers, arrow mapping, overlay geometry, settings.
import { describe, it, expect } from 'vitest';
import { classifyPage, classifyUrl, type PageProbe } from '@/content/detector/sites';
import { composeFen, fenFromLichessPath, turnFromLastMove, gridToPlacement, emptyGrid } from '@/content/adapters/adapters';
import { arrowPath, isKnightMove, pointToSquare, squareCenter, squareOrigin } from '@/content/arrows/geometry';
import { clampToViewport, defaultOverlayState, dragTo, resizeTo, MIN_W, MIN_H } from '@/content/overlay/layout';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings } from '@/settings/schema';
import { START_FEN } from '@/chess/position';

const probe = (url: string, dom: string[] = []): PageProbe => {
  const u = new URL(url);
  return { hostname: u.hostname, pathname: u.pathname, has: (s) => dom.includes(s) };
};

describe('fair-play restrictions', () => {
  it('supports analysis boards and unrated practice', () => {
    expect(classifyPage(probe('https://lichess.org/analysis'))).toMatchObject({ status: 'supported', context: 'analysis' });
    expect(classifyPage(probe('https://lichess.org/analysis/standard/rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR_w_KQkq_-_0_1'))).toMatchObject({ status: 'supported' });
    expect(classifyPage(probe('https://lichess.org/practice/checkmates/piece-checkmates-i/BJy6fEDf'))).toMatchObject({ status: 'supported', context: 'practice' });
    expect(classifyPage(probe('https://www.chess.com/analysis'))).toMatchObject({ status: 'supported', site: 'chesscom' });
    expect(classifyPage(probe('https://www.chess.com/play/computer'))).toMatchObject({ status: 'supported', site: 'chesscom', context: 'computer' });
    expect(classifyPage(probe('https://www.chess.com/play/computer/discover'))).toMatchObject({ status: 'supported', context: 'computer' });
    expect(classifyPage(probe('https://www.chess.com/play/computers-online')).status).toBe('blocked');
    expect(classifyPage(probe('https://www.chess.com/play/computer', ['.clock-player-turn'])).status).toBe('blocked');
  });
  it('blocks live and rated game pages by URL', () => {
    for (const url of [
      'https://lichess.org/AbCdEf12', 'https://lichess.org/AbCdEf12/black', 'https://lichess.org/AbCdEf123456', 'https://lichess.org/tv',
      'https://lichess.org/training', 'https://lichess.org/storm', 'https://lichess.org/tournament/xyz', 'https://lichess.org/swiss/abc',
      'https://www.chess.com/play/online', 'https://www.chess.com/game/live/123456', 'https://www.chess.com/game/daily/42', 'https://www.chess.com/puzzles/rated',
      'https://www.chess.com/puzzles/rush',
    ]) expect(classifyPage(probe(url)).status, url).toBe('blocked');
  });
  it('blocks an analysis URL when live-game elements (running clocks) are present', () => {
    expect(classifyPage(probe('https://lichess.org/analysis', ['.rclock.running'])).status).toBe('blocked');
    expect(classifyPage(probe('https://www.chess.com/analysis', ['.clock-component.clock-player-turn'])).status).toBe('blocked');
  });
  it('3.0: finished games and solved puzzles become analysable only with positive evidence on the page', () => {
    // URL alone (and any uncertain state) → blocked, marked pending
    for (const url of ['https://lichess.org/AbCdEf12', 'https://lichess.org/training/aB3dE', 'https://www.chess.com/game/live/123456', 'https://www.chess.com/puzzles/rated']) {
      const v = classifyPage(probe(url));
      expect(v.status, url).toBe('blocked');
      expect((v as { pending?: boolean }).pending, url).toBe(true);
    }
    expect(classifyPage(probe('https://lichess.org/AbCdEf12', ['.result-wrap']))).toMatchObject({ status: 'supported', context: 'finished game' });
    expect(classifyPage(probe('https://lichess.org/training/aB3dE', ['.puzzle__feedback.after']))).toMatchObject({ status: 'supported', context: 'solved puzzle' });
    expect(classifyPage(probe('https://www.chess.com/game/live/123456', ['.game-over-modal-content']))).toMatchObject({ status: 'supported', context: 'finished game' });
    expect(classifyPage(probe('https://www.chess.com/puzzles/rated', ['.puzzle-feedback-solved']))).toMatchObject({ status: 'supported', context: 'solved puzzle' });
    // a running clock always wins, even with "game over" evidence
    expect(classifyPage(probe('https://lichess.org/AbCdEf12', ['.result-wrap', '.rclock.running'])).status).toBe('blocked');
    expect(classifyPage(probe('https://www.chess.com/game/live/1', ['.game-over-modal-content', '.clock-player-turn'])).status).toBe('blocked');
  });
  it('3.0: timed and competitive modes stay blocked with no way to unlock', () => {
    for (const [url, dom] of [
      ['https://lichess.org/storm', ['.puzzle__feedback.after']], ['https://lichess.org/streak', ['.puzzle__feedback.after']], ['https://lichess.org/racer/abc', []],
      ['https://lichess.org/AbCdEf123456', ['.result-wrap']], ['https://lichess.org/tournament/xyz', ['.result-wrap']],
      ['https://www.chess.com/puzzles/rush', ['.puzzle-feedback-solved']], ['https://www.chess.com/puzzles/battle', ['.puzzle-feedback-solved']],
      ['https://www.chess.com/play/online', ['.game-over-modal-content']], ['https://www.chess.com/tournament/live/x', ['.game-over-modal-content']],
    ] as const) {
      const v = classifyPage(probe(url, [...dom]));
      expect(v.status, url).toBe('blocked');
      expect((v as { pending?: boolean }).pending, url).toBeFalsy();
    }
  });
  it('3.0: lessons, editor and explorer are allowed', () => {
    expect(classifyPage(probe('https://lichess.org/editor')).status).toBe('supported');
    expect(classifyPage(probe('https://www.chess.com/lessons/the-pin/1')).status).toBe('supported');
  });
  it('ignores unrelated websites and non-https', () => {
    expect(classifyPage(probe('https://example.com/analysis')).status).toBe('unsupported');
    expect(classifyUrl('http://lichess.org/analysis').status).toBe('unsupported');
    expect(classifyUrl('https://lichess.org/').status).toBe('unsupported');
    expect(classifyUrl(undefined).status).toBe('unsupported');
  });
});

describe('board adapters (no guessing of hidden metadata)', () => {
  it('reads a FEN from Lichess analysis URLs', () => {
    expect(fenFromLichessPath('/analysis/standard/rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR_b_KQkq_-_0_1')).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(fenFromLichessPath('/analysis')).toBeNull();
  });
  it('infers side to move only from a visible last-move highlight', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR';
    expect(turnFromLastMove(afterE4, ['e2', 'e4'])).toBe('b');
    expect(turnFromLastMove(START_FEN.split(' ')[0])).toBe('w');
    expect(turnFromLastMove(afterE4)).toBeNull(); // unknown → user must choose
  });
  it('composes a FEN and drops castling rights that are impossible on the board', () => {
    const r = composeFen({ placement: 'r3k2r/8/8/8/8/8/8/R3K1R1', turn: 'w', castling: null, ep: null }, { castling: 'KQkq' });
    expect(r.fen).toBe('r3k2r/8/8/8/8/8/8/R3K1R1 w Qkq - 0 1');
    expect(r.problems.some((p) => p.includes('"K"'))).toBe(true);
    expect(composeFen({ placement: '8/8/8/8/8/8/8/K6k', turn: null, castling: null, ep: null }).fen).toBeNull();
  });
  it('serialises an empty grid', () => expect(gridToPlacement(emptyGrid())).toBe('8/8/8/8/8/8/8/8'));
});

describe('arrow coordinate mapping & board orientation', () => {
  it('maps squares for white orientation', () => {
    expect(squareOrigin('a8', 800, 'white')).toEqual({ x: 0, y: 0 });
    expect(squareOrigin('h1', 800, 'white')).toEqual({ x: 700, y: 700 });
    expect(squareCenter('e4', 800, 'white')).toEqual({ x: 450, y: 450 });
  });
  it('maps squares for a flipped board', () => {
    expect(squareOrigin('a8', 800, 'black')).toEqual({ x: 700, y: 700 });
    expect(squareOrigin('h1', 800, 'black')).toEqual({ x: 0, y: 0 });
  });
  it('pointToSquare inverts squareCenter in both orientations', () => {
    for (const o of ['white', 'black'] as const) for (const s of ['a1', 'e4', 'h8', 'c7'] as const) {
      const c = squareCenter(s, 480, o);
      expect(pointToSquare(c.x, c.y, 480, o)).toBe(s);
    }
    expect(pointToSquare(-1, 10, 480, 'white')).toBeNull();
  });
  it('draws knight moves as an L and scales with board size', () => {
    expect(isKnightMove('g1', 'f3')).toBe(true);
    expect(isKnightMove('e2', 'e4')).toBe(false);
    const straight = arrowPath('e2', 'e4', 800, 'white');
    const knight = arrowPath('g1', 'f3', 800, 'white');
    expect(knight.split('L').length).toBeGreaterThan(straight.split('L').length);
    // the arrow tip sits at the destination centre
    expect(straight).toContain('450.00,450.00');
  });
});

describe('overlay dragging & resizing', () => {
  const vw = 1280, vh = 800;
  it('starts inside the viewport', () => {
    const s = defaultOverlayState(vw, vh);
    expect(s.x + s.w).toBeLessThanOrEqual(vw);
    expect(s.y).toBeGreaterThanOrEqual(0);
  });
  it('drags with the pointer and clamps to the viewport', () => {
    const s = defaultOverlayState(vw, vh);
    const moved = dragTo(s, { px: 100, py: 100, x: s.x, y: s.y }, 50, 120, vw, vh);
    expect(moved.x).toBe(s.x - 50);
    expect(moved.y).toBe(s.y + 20);
    const far = dragTo(s, { px: 0, py: 0, x: s.x, y: s.y }, 99999, 99999, vw, vh);
    expect(far.x + far.w).toBeLessThanOrEqual(vw);
    expect(far.y).toBeLessThan(vh);
  });
  it('resizes with minimum sizes and re-clamps on viewport shrink', () => {
    const s = defaultOverlayState(vw, vh);
    const r = resizeTo(s, { px: 0, py: 0, w: s.w, h: s.h }, -2000, -2000, vw, vh);
    expect(r.w).toBe(MIN_W);
    expect(r.h).toBe(MIN_H);
    const shrunk = clampToViewport({ ...s, x: 1200 }, 600, 500);
    expect(shrunk.x + shrunk.w).toBeLessThanOrEqual(600);
  });
});

describe('settings validation', () => {
  it('repairs corrupt stored settings', () => {
    const s = validateSettings({ engine: { depth: 999, multiPv: -3, hashMb: 'x' }, appearance: { theme: 'neon' }, visual: { threatLayers: { pins: 'yes' } } });
    expect(s.engine.depth).toBe(30);
    expect(s.engine.multiPv).toBe(1);
    expect(s.engine.hashMb).toBe(DEFAULT_SETTINGS.engine.hashMb);
    expect(s.appearance.theme).toBe('dark');
    expect(s.visual.threatLayers.pins).toBe(DEFAULT_SETTINGS.visual.threatLayers.pins);
  });
  it('defaults match the specification', () => {
    expect(DEFAULT_SETTINGS.engine).toMatchObject({ depth: 18, multiPv: 3, threads: 1, hashMb: 64 });
  });
  it('deep-merges patches', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { visual: { threatLayers: { attacked: true } } });
    expect(s.visual.threatLayers.attacked).toBe(true);
    expect(s.visual.threatLayers.pins).toBe(true);
    expect(s.visual.arrows).toBe(true);
  });
});
