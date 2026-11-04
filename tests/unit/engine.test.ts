import { describe, it, expect } from 'vitest';
import { parseInfo, parseBestMove, parseOption, goCommand } from '@/engine/uci';
import { toWhite, toCp, winPercent, formatScore, moveAccuracy, evalBarFraction, describeScore } from '@/engine/normalize';
import { StockfishEngine } from '@/engine/engine';
import { START_FEN } from '@/chess/position';
import { FakeEngine } from './fakeEngine';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('UCI parsing', () => {
  it('parses a full info line with MultiPV and PV', () => {
    const i = parseInfo('info depth 18 seldepth 25 multipv 2 score cp -34 nodes 1234567 nps 890000 hashfull 120 tbhits 0 time 1387 pv e7e5 g1f3 b8c6');
    expect(i).toMatchObject({ depth: 18, seldepth: 25, multipv: 2, score: { type: 'cp', value: -34 }, nodes: 1234567, nps: 890000, timeMs: 1387, pv: ['e7e5', 'g1f3', 'b8c6'] });
  });
  it('parses mate scores and bounds', () => {
    expect(parseInfo('info depth 5 score mate -3 lowerbound pv e1e2')).toMatchObject({ score: { type: 'mate', value: -3 }, bound: 'lower' });
    expect(parseInfo('info depth 5 score cp 12 upperbound')).toMatchObject({ bound: 'upper' });
  });
  it('handles wdl, currmove and info string lines', () => {
    expect(parseInfo('info depth 10 multipv 1 score cp 20 wdl 100 800 100 pv d2d4')?.pv).toEqual(['d2d4']);
    expect(parseInfo('info string NNUE evaluation using nn.bin')?.string).toContain('NNUE');
    expect(parseInfo('bestmove e2e4')).toBeNull();
  });
  it('parses bestmove with/without ponder and (none)', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toEqual({ bestMove: 'e2e4', ponder: 'e7e5' });
    expect(parseBestMove('bestmove (none)')).toEqual({ bestMove: null, ponder: undefined });
  });
  it('parses option lines and builds go commands', () => {
    expect(parseOption('option name Threads type spin default 1 min 1 max 1024')).toMatchObject({ name: 'Threads', min: 1, max: 1024 });
    expect(parseOption('option name Clear Hash type button')?.name).toBe('Clear Hash');
    expect(goCommand({ depth: 18 })).toBe('go depth 18');
    expect(goCommand({ depth: 12, moveTimeMs: 500 })).toBe('go depth 12 movetime 500');
  });
});

describe('evaluation normalisation', () => {
  it('converts side-to-move scores to White perspective', () => {
    expect(toWhite({ type: 'cp', value: 50 }, 'w').value).toBe(50);
    expect(toWhite({ type: 'cp', value: 50 }, 'b').value).toBe(-50);
    expect(toWhite({ type: 'mate', value: 3 }, 'b')).toMatchObject({ type: 'mate', value: -3 });
  });
  it('keeps the winner for "mate 0" (side to move is checkmated)', () => {
    const w = toWhite({ type: 'mate', value: 0 }, 'b'); // black to move and mated → White won
    expect(w.winner).toBe('w');
    expect(winPercent(w)).toBe(100);
    expect(toCp(w)).toBe(10000);
    expect(formatScore(w)).toBe('1-0 #');
    expect(describeScore(w)).toContain('White');
  });
  it('maps scores to win% monotonically and symmetrically', () => {
    expect(winPercent({ type: 'cp', value: 0 })).toBeCloseTo(50, 5);
    expect(winPercent({ type: 'cp', value: 300 })).toBeGreaterThan(winPercent({ type: 'cp', value: 100 }));
    expect(winPercent({ type: 'cp', value: 200 }) + winPercent({ type: 'cp', value: -200 })).toBeCloseTo(100, 5);
    expect(evalBarFraction({ type: 'mate', value: 2, perspective: 'white' })).toBe(1);
  });
  it('formats scores', () => {
    expect(formatScore({ type: 'cp', value: 123, perspective: 'white' })).toBe('+1.23');
    expect(formatScore({ type: 'cp', value: -5, perspective: 'white' })).toBe('−0.05');
    expect(formatScore({ type: 'mate', value: -2, perspective: 'white' })).toBe('-M2');
  });
  it('computes move accuracy within 0..100, 100 for no loss', () => {
    expect(moveAccuracy(60, 60)).toBeCloseTo(100, 0);
    expect(moveAccuracy(60, 30)).toBeLessThan(moveAccuracy(60, 55));
    expect(moveAccuracy(90, 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('engine controller (scripted UCI engine)', () => {
  it('performs the UCI handshake and applies options clamped to engine limits', async () => {
    const fake = new FakeEngine({ threadsMax: 1 });
    const e = new StockfishEngine(() => fake, { threads: 4, hashMb: 64 }, { idleMs: 0 });
    await e.init();
    expect(e.getStatus()).toBe('ready');
    expect(fake.sent).toContain('setoption name Threads value 1'); // clamped from 4
    expect(fake.sent).toContain('setoption name Hash value 64');
    expect(e.engineName).toBe('FakeFish 1.0');
    expect(e.effectiveConfig().threads).toBe(1);
  });

  it('analyses with MultiPV, converts PVs to SAN and White-perspective scores', async () => {
    const fake = new FakeEngine();
    const e = new StockfishEngine(() => fake, undefined, { idleMs: 0, updateIntervalMs: 0 });
    const updates: number[] = [];
    const r = await e.analyse('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { depth: 5, multiPv: 3 }, (u) => updates.push(u.depth)).result;
    expect(r.complete).toBe(true);
    expect(r.depth).toBe(5);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0].whiteScore.value).toBe(-30); // black to move, cp 30 for black → −30 for White
    expect(r.lines[0].pvSan[0]).toBeTruthy();
    expect(fake.sent).toContain('setoption name MultiPV value 3');
    expect(updates.length).toBeGreaterThan(1);
  });

  it('rejects stale results: a new search cancels the old one and late output is ignored', async () => {
    const fake = new FakeEngine({ stepMs: 5 });
    const e = new StockfishEngine(() => fake, undefined, { idleMs: 0, updateIntervalMs: 0 });
    const first = e.analyse(START_FEN, { depth: 50, multiPv: 1 });
    await wait(20);
    // output that the engine still emits for the OLD position after `stop`
    fake.injectAfterStop(['info depth 30 multipv 1 score cp 999 pv e2e4']);
    const second = e.analyse('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { depth: 3, multiPv: 1 });
    const r1 = await first.result;
    const r2 = await second.result;
    expect(r1.complete).toBe(false);
    expect(r1.lines.every((l) => l.score.value !== 999)).toBe(true);
    expect(r2.complete).toBe(true);
    expect(r2.fen.split(' ')[1]).toBe('b');
    expect(r2.lines.every((l) => l.score.value !== 999)).toBe(true);
  });

  it('serves repeated positions from cache', async () => {
    const fake = new FakeEngine();
    const e = new StockfishEngine(() => fake, undefined, { idleMs: 0 });
    await e.analyse(START_FEN, { depth: 4, multiPv: 2 }).result;
    const goes = fake.sent.filter((c) => c.startsWith('go')).length;
    const r = await e.analyse(START_FEN, { depth: 3, multiPv: 2 }).result;
    expect(r.fromCache).toBe(true);
    expect(fake.sent.filter((c) => c.startsWith('go')).length).toBe(goes);
  });

  it('cancels a specific search', async () => {
    const e = new StockfishEngine(() => new FakeEngine({ stepMs: 5 }), undefined, { idleMs: 0 });
    const h = e.analyse(START_FEN, { depth: 100, multiPv: 1 });
    await wait(15);
    h.cancel();
    const r = await h.result;
    expect(r.complete).toBe(false);
  });

  it('reports checkmate positions without fabricating moves', async () => {
    const e = new StockfishEngine(() => new FakeEngine(), undefined, { idleMs: 0 });
    const r = await e.analyse('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', { depth: 5, multiPv: 3 }).result;
    expect(r.bestMove).toBeUndefined();
    expect(r.lines[0]?.whiteScore.winner).toBe('b');
  });

  it('restarts after a stall and finishes queued work', async () => {
    let n = 0;
    const engines: FakeEngine[] = [];
    const e = new StockfishEngine(() => { const f = new FakeEngine({ mute: n++ === 0 }); engines.push(f); return f; }, undefined, { idleMs: 0, stallTimeoutMs: 60 });
    const statuses: string[] = [];
    e.onStatus((s) => statuses.push(s));
    const stuck = await e.analyse(START_FEN, { depth: 5, multiPv: 1 }).result; // first engine never answers "go"
    expect(stuck.complete).toBe(false);
    expect(statuses).toContain('restarting');
    expect(engines[0].terminated).toBe(true);
    const ok = await e.analyse(START_FEN, { depth: 3, multiPv: 1 }).result;
    expect(ok.complete).toBe(true);
    expect(e.restarts).toBe(1);
  });

  it('recovers from a crash', async () => {
    const fakes: FakeEngine[] = [];
    const e = new StockfishEngine(() => { const f = new FakeEngine({ stepMs: 5 }); fakes.push(f); return f; }, undefined, { idleMs: 0 });
    const h = e.analyse(START_FEN, { depth: 100, multiPv: 1 });
    await wait(20);
    fakes[0].crash();
    expect((await h.result).complete).toBe(false);
    expect((await e.analyse(START_FEN, { depth: 2, multiPv: 1 }).result).complete).toBe(true);
  });

  it('terminates the worker after idling and re-initialises lazily', async () => {
    const fakes: FakeEngine[] = [];
    const e = new StockfishEngine(() => { const f = new FakeEngine(); fakes.push(f); return f; }, undefined, { idleMs: 30 });
    await e.analyse(START_FEN, { depth: 2, multiPv: 1 }).result;
    await wait(60);
    expect(e.getStatus()).toBe('terminated');
    expect(fakes[0].terminated).toBe(true);
    e.clearCache();
    await e.analyse(START_FEN, { depth: 2, multiPv: 1 }).result;
    expect(fakes).toHaveLength(2);
  });

  it('rejects invalid FEN without touching the engine', async () => {
    const fake = new FakeEngine();
    const e = new StockfishEngine(() => fake, undefined, { idleMs: 0 });
    await expect(e.analyse('garbage', { depth: 3, multiPv: 1 }).result).rejects.toThrow();
    expect(fake.sent).toHaveLength(0);
  });
});

describe('engine recovery (v2.1)', () => {
  it('stops after repeated consecutive crashes instead of looping, and retry() recovers', async () => {
    let crashy = true;
    const fakes: FakeEngine[] = [];
    const e = new StockfishEngine(() => { const f = new FakeEngine({ stepMs: 5 }); fakes.push(f); return f; }, undefined, { idleMs: 0, restartBaseMs: 5, maxConsecutiveFailures: 3 });
    const errors: [string, boolean][] = [];
    e.onError((m, fatal) => errors.push([m, fatal]));
    for (let i = 0; i < 3; i++) {
      const h = e.analyse(START_FEN, { depth: 100, multiPv: 1 });
      await wait(15);
      if (crashy) fakes[fakes.length - 1].crash();
      expect((await h.result).complete).toBe(false);
    }
    expect(e.getStatus()).toBe('error');
    expect(e.lastError).toMatch(/3 times in a row/);
    expect(errors.at(-1)?.[1]).toBe(true);
    const spawned = fakes.length;
    // further positions do not respawn the worker
    expect((await e.analyse(START_FEN, { depth: 2, multiPv: 1 }).result).complete).toBe(false);
    expect(fakes.length).toBe(spawned);
    crashy = false;
    e.retry();
    expect((await e.analyse(START_FEN, { depth: 2, multiPv: 1 }).result).complete).toBe(true);
    expect(e.consecutiveFailures).toBe(0);
  });

  it('resets the failure counter after a normal answer', async () => {
    const fakes: FakeEngine[] = [];
    const e = new StockfishEngine(() => { const f = new FakeEngine({ stepMs: 5 }); fakes.push(f); return f; }, undefined, { idleMs: 0, restartBaseMs: 5, maxConsecutiveFailures: 2 });
    for (let i = 0; i < 4; i++) {
      const h = e.analyse(START_FEN, { depth: 100, multiPv: 1 });
      await wait(15);
      fakes[fakes.length - 1].crash();
      await h.result;
      expect(e.consecutiveFailures).toBe(1);
      e.clearCache(); // a cached answer does not prove the engine is healthy
      expect((await e.analyse(START_FEN, { depth: 2, multiPv: 1 }).result).complete).toBe(true);
      expect(e.consecutiveFailures).toBe(0);
    }
    expect(e.getStatus()).not.toBe('error');
    expect(e.restarts).toBe(4);
  });

  it('fails fast with a clear message when engine files are missing (no restart loop)', async () => {
    let spawned = 0;
    const e = new StockfishEngine(() => {
      spawned++;
      const f = new FakeEngine();
      const send = f.send.bind(f);
      f.send = (c: string) => { if (c === 'uci') setTimeout(() => f.emit('info string fatal moth.wasm could not be loaded'), 0); else send(c); };
      return f;
    }, undefined, { idleMs: 0, initTimeoutMs: 500 });
    e.engineName = 'MOTH Engine';
    expect((await e.analyse(START_FEN, { depth: 2, multiPv: 1 }).result).complete).toBe(false);
    expect(e.getStatus()).toBe('error');
    expect(e.lastError).toMatch(/MOTH Engine files are missing or damaged/);
    await e.analyse(START_FEN, { depth: 3, multiPv: 1 }).result;
    expect(spawned).toBe(1);
  });

  it('explains common fatal errors in plain language', async () => {
    const { explainEngineError } = await import('@/engine/engine');
    expect(explainEngineError('Engine did not respond to the UCI handshake', 'Stockfish')).toMatch(/did not start in time/);
    expect(explainEngineError('RangeError: out of memory', 'Stockfish')).toMatch(/Eco profile/);
  });
});
