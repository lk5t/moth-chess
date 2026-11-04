// MOTH Engine: move generation (perft), rules, search, deadlines, styles, sacrifices, NNUE, UCI.
// All tests run the real WebAssembly engine.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MothWasm } from '@/moth-engine/wasm';
import { MothUci } from '@/moth-engine/uci';
import { decodeModel, encodeModel, randomNetwork, type ModelMeta } from '@/moth-engine/model';
import { WAC } from '@/moth-engine/training/tactics';
import { forwardCp, NN_CLAMP } from '@/moth-engine/training/trainer';
import type { OpeningBook } from '@/moth-engine/book';

const WASM = readFileSync(resolve(__dirname, '../../public/moth-engine/moth.wasm'));
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let e: MothWasm;
beforeAll(async () => { e = await MothWasm.create(WASM, 16); });

describe('move generation (perft)', () => {
  const suite: [string, string, number[]][] = [
    ['startpos', START, [20, 400, 8902, 197281]],
    ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['position3 (en passant, pins)', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    ['position4 (promotions, castling)', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
    ['position5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
    ['position6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
  ];
  for (const [name, fen, counts] of suite) {
    it(`${name} matches reference counts`, () => {
      counts.forEach((n, i) => { expect(e.setFen(fen)).toBe(true); expect(e.perft(i + 1)).toBe(n); });
    });
  }
});

describe('rules', () => {
  it('castling both sides, and not through check', () => {
    e.setFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(e.legalMoves()).toEqual(expect.arrayContaining(['e1g1', 'e1c1']));
    e.setFen('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1'); // f2 rook attacks f1 → no O-O
    expect(e.legalMoves()).not.toContain('e1g1');
    expect(e.uciToSan('e1c1')).toBe('O-O-O');
  });
  it('en passant only when legal, and canonical e.p. square', () => {
    e.setFen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
    expect(e.legalMoves()).toContain('e5f6');
    expect(e.uciToSan('e5f6')).toBe('exf6');
    e.setFen(START); e.play('e2e4');
    expect(e.fen().split(' ')[3]).toBe('-'); // no black pawn can capture → no e.p. square recorded
  });
  it('promotion to all four pieces in UCI and SAN', () => {
    e.setFen('5b2/3P1pk1/2Q3p1/1P2p3/4Pn1p/q4P2/P4BPP/5BK1 w - - 3 32');
    const pr = e.legalMoves().filter((m) => m.startsWith('d7'));
    expect(pr.sort()).toEqual(['d7d8b', 'd7d8n', 'd7d8q', 'd7d8r']);
    expect(e.sanToUci('d8=Q')).toBe('d7d8q');
    expect(e.sanToUci('d8N')).toBe('d7d8n');
  });
  it('checkmate, stalemate, insufficient material, fifty moves, repetition', () => {
    e.setFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'); expect(e.gameState()).toBe('checkmate');
    e.setFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'); expect(e.gameState()).toBe('stalemate');
    e.setFen('8/8/4k3/8/8/2N5/4K3/8 w - - 0 1'); expect(e.gameState()).toBe('insufficient');
    e.setFen('8/8/4k3/8/8/2R5/4K3/8 w - - 100 80'); expect(e.gameState()).toBe('fifty-move');
    e.setFen(START);
    for (const m of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) e.play(m);
    expect(e.gameState()).toBe('repetition');
  });
  it('rejects illegal FENs and illegal moves', () => {
    expect(e.setFen('8/8/8/8/8/8/8/8 w - - 0 1')).toBe(false); // no kings
    expect(e.setFen('4k3/8/8/8/8/8/8/R3K2R b - - 0 1')).toBe(true);
    expect(e.setFen('4k3/4R3/8/8/8/8/8/4K3 w - - 0 1')).toBe(false); // side not to move is in check
    e.setFen(START);
    expect(e.play('e2e5')).toBe(false);
  });
  it('tolerates over-disambiguated SAN only when unique', () => {
    e.setFen('rnb1k2r/pp3ppp/5n2/8/1b1N4/2N5/PP3PPP/R1B1KB1R w KQkq - 1 10'); // c3 knight pinned
    expect(e.sanToUci('Ndb5')).toBe('d4b5');
  });
});

describe('search', () => {
  it('finds quick mates and returns mate scores', () => {
    e.setFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
    const r = e.search({ movetimeMs: 500 });
    expect(r.bestMove).toBe('h5f7');
    expect(e.uciScore(r.lines[0].score)).toEqual({ type: 'mate', value: 1 });
    e.setFen('r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1');
    const r2 = e.search({ movetimeMs: 1000 });
    expect(r2.bestMove).toBe('d5f6');
    expect(e.uciScore(r2.lines[0].score)).toEqual({ type: 'mate', value: 2 });
  });
  it('solves classic tactics (Win At Chess) including a queen sacrifice', () => {
    let solved = 0;
    for (const w of WAC) { e.newGame(); e.setFen(w.fen); if (w.best.includes(e.search({ movetimeMs: 600 }).bestMove!)) solved++; }
    expect(solved).toBeGreaterThanOrEqual(8);
    e.setFen('r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1'); // WAC.004: Qxh7+! Kxh7 hxg6+ mates
    expect(e.search({ movetimeMs: 500 }).bestMove).toBe('h6h7');
  });
  it('examines defensive replies before accepting a sacrifice', () => {
    // Bxh7+ looks tempting but Black's king escapes and White is just a piece down
    e.newGame();
    e.setFen('r1bq1rk1/pppn1ppp/4pn2/3p4/1bPP4/2NBPN2/PP3PPP/R1BQK2R w KQ - 0 7');
    const r = e.search({ movetimeMs: 800 });
    expect(r.bestMove).not.toBe('d3h7');
  });
  it('MultiPV returns distinct root moves ordered by score', () => {
    e.setFen(START);
    const r = e.search({ depth: 7, multipv: 3 });
    expect(r.lines).toHaveLength(3);
    expect(new Set(r.lines.map((l) => l.pv[0])).size).toBe(3);
    expect(r.lines[0].score).toBeGreaterThanOrEqual(r.lines[2].score);
  });
  it('respects deadlines and always returns a legal move, even at 1 ms', () => {
    const fens = [START, 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', '8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1'];
    for (const budget of [1, 5, 20, 100]) for (const f of fens) {
      e.newGame(); e.setFen(f);
      const t0 = performance.now();
      const r = e.search({ movetimeMs: budget });
      const took = performance.now() - t0;
      expect(e.legalMoves()).toContain(r.bestMove);
      expect(took).toBeLessThan(budget + 15);
    }
  });
});

describe('styles', () => {
  const positions = [
    'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    'rnbqk2r/ppp1bppp/4pn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 4 5',
    'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7',
    'r2q1rk1/pp2bppp/2n1pn2/3p4/3P1B2/2PB1N2/PP1N1PPP/R2Q1RK1 w - - 0 10',
    'r1bq1rk1/pp3ppp/2nbpn2/3p4/2PP4/2N1PN2/PP3PPP/R1BQKB1R w KQ - 0 8',
  ];
  it('never override a forced win: all styles find the same mate', () => {
    for (const s of ['aggressive', 'balanced', 'defensive'] as const) {
      e.setStyle(s); e.newGame();
      e.setFen('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
      const r = e.search({ movetimeMs: 300 });
      expect(r.bestMove).toBe('d1d8');
    }
    e.setStyle('balanced');
  });
  it('only choose between moves the search considers close', () => {
    for (const fen of positions) {
      e.setStyle('balanced'); e.newGame(); e.setFen(fen);
      const ref = e.search({ depth: 8, multipv: 8 });
      const scoreOf = new Map(ref.lines.map((l) => [l.pv[0], l.score]));
      for (const s of ['aggressive', 'defensive'] as const) {
        e.setStyle(s); e.newGame(); e.setFen(fen);
        const mv = e.search({ depth: 8 }).bestMove!;
        // the styled choice is among the balanced engine's top candidates, within a small margin of the best
        const sc = scoreOf.get(mv);
        expect(sc, `${s} played ${mv} in ${fen}`).toBeDefined();
        expect(ref.lines[0].score - (sc ?? -9999)).toBeLessThanOrEqual(60);
      }
    }
    e.setStyle('balanced');
  });
  it('change evaluation emphasis (aggressive values king attack, defensive values shelter)', () => {
    const fen = 'r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 w - - 0 6';
    e.setFen(fen); e.setStyle('aggressive'); const a = e.evaluate().classical;
    e.setStyle('defensive'); const d = e.evaluate().classical;
    e.setStyle('balanced'); const b = e.evaluate().classical;
    expect(new Set([a, b, d]).size).toBeGreaterThan(1);
  });
});

describe('NNUE evaluation', () => {
  it('incremental accumulator updates equal a fresh computation, and match the trainer', async () => {
    const net = randomNetwork(32, 7);
    const fresh = await MothWasm.create(WASM, 1);
    e.loadNetwork(net); fresh.loadNetwork(net);
    let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let g = 0; g < 10; g++) {
      e.setFen(START);
      for (let i = 0; i < 60; i++) {
        const lm = e.legalMoves(); if (!lm.length) break;
        e.play(lm[Math.floor(rnd() * lm.length)]);
        fresh.setFen(e.fen());
        expect(e.evaluate().nnue).toBe(fresh.evaluate().nnue);
        const f = fresh.features();
        const t = Math.trunc(forwardCp(net, { fw: Int16Array.from(f.white), fb: Int16Array.from(f.black), stmWhite: fresh.sideToMove() === 'w', classical: 0, target: 0 }));
        expect(fresh.evaluate().nnue).toBe(Math.max(-NN_CLAMP, Math.min(NN_CLAMP, t)));
      }
    }
    e.loadNetwork(null);
    expect(e.evaluate().nnue).toBe(0);
  });
  it('model files round-trip (from Node Buffers too)', () => {
    const net = randomNetwork(16, 1);
    const meta = { id: 't', version: '0', createdAt: 0, hidden: 16, scale: 100, status: 'approved', settings: {}, data: {}, metrics: {} } as unknown as ModelMeta;
    const bytes = Buffer.from(encodeModel(meta, net)); // Buffer: view into a pooled ArrayBuffer
    const back = decodeModel(bytes);
    expect(back.meta.id).toBe('t');
    expect(Array.from(back.weights.w1.slice(0, 50))).toEqual(Array.from(net.w1.slice(0, 50)));
    expect(back.weights.w2).toEqual(net.w2);
  });
});

describe('UCI front end', () => {
  const tinyBook: OpeningBook = {
    format: 'moth-book-1', built: '', sources: [], validation: { engine: 'test', depth: 1 }, stats: { positions: 1, moves: 2, named: 0, gambits: 1, traps: 0, mistakes: 0, humanGames: 0 },
    positions: { 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -': { moves: [
      { uci: 'e2e4', san: 'e4', games: 1000, score: 0.52, eval: 30, depth: 12, tags: ['main'] },
      { uci: 'd2d4', san: 'd4', games: 800, score: 0.52, eval: 28, depth: 12, tags: [] },
      { uci: 'f2f4', san: 'f4', games: 5000, score: 0.6, eval: -90, depth: 12, tags: ['gambit'] }, // popular but unsound
    ] } },
  };
  async function uci(book: OpeningBook | null = null) {
    const engine = await MothWasm.create(WASM, 8);
    const lines: string[] = [];
    let waiters: [(l: string) => boolean, (l: string) => void][] = [];
    const u = new MothUci(engine, {
      emit: (l) => { lines.push(l); waiters = waiters.filter(([t, r]) => (t(l) ? (r(l), false) : true)); },
      now: () => performance.now(), yieldNow: () => new Promise((r) => setImmediate(r)),
      loadModel: async () => null, loadBook: async () => book, random: () => 0.5,
    });
    const wait = (t: (l: string) => boolean) => new Promise<string>((r) => waiters.push([t, r]));
    u.handle('uci'); await wait((l) => l === 'uciok');
    u.handle('isready'); await wait((l) => l === 'readyok');
    return { u, lines, wait };
  }
  it('handshake advertises MOTH options', async () => {
    const { lines } = await uci();
    expect(lines).toContain('id name MOTH Engine 2.0');
    expect(lines.some((l) => l.startsWith('option name Style type combo'))).toBe(true);
  });
  it('go movetime answers within budget; repeat answers from the cache', async () => {
    const { u, lines, wait } = await uci();
    u.handle('position startpos moves e2e4 e7e5 g1f3'); u.handle('go movetime 100');
    let t = performance.now(); expect(await wait((l) => l.startsWith('bestmove'))).toMatch(/^bestmove [a-h][1-8][a-h][1-8]/);
    expect(performance.now() - t).toBeLessThan(140);
    t = performance.now(); u.handle('go movetime 100'); await wait((l) => l.startsWith('bestmove'));
    expect(performance.now() - t).toBeLessThan(10);
    expect(lines.some((l) => / cache$/.test(l))).toBe(true);
  });
  it('go infinite stops promptly on stop', async () => {
    const { u, wait } = await uci();
    u.handle('position startpos'); u.handle('go infinite');
    await new Promise((r) => setTimeout(r, 400));
    const t = performance.now(); u.handle('stop'); await wait((l) => l.startsWith('bestmove'));
    expect(performance.now() - t).toBeLessThan(300);
  });
  it('ponder → ponderhit answers quickly', async () => {
    const { u, wait } = await uci();
    u.handle('position startpos moves e2e4'); u.handle('go ponder movetime 100');
    await new Promise((r) => setTimeout(r, 600));
    const t = performance.now(); u.handle('ponderhit'); await wait((l) => l.startsWith('bestmove'));
    expect(performance.now() - t).toBeLessThan(60);
  });
  it('opening book: engine-sound moves only, popularity never overrides soundness', async () => {
    const { u, lines, wait } = await uci(tinyBook);
    for (let i = 0; i < 5; i++) {
      u.handle('ucinewgame'); u.handle('position startpos'); u.handle('go movetime 50');
      const bm = await wait((l) => l.startsWith('bestmove'));
      expect(['bestmove e2e4', 'bestmove d2d4']).toContain(bm.split(' ').slice(0, 2).join(' '));
    }
    expect(lines.some((l) => l.startsWith('info string book'))).toBe(true);
  });
  it('Prepare (personal adaptation) steers the choice among sound book moves', async () => {
    const { u, wait } = await uci(tinyBook);
    u.handle('setoption name Prepare value rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR_w_KQkq_-=d2d4');
    u.handle('position startpos'); u.handle('go movetime 50');
    expect(await wait((l) => l.startsWith('bestmove'))).toMatch(/^bestmove d2d4/);
  });
  it('illegal input never reaches the search; no-move positions answer (none)', async () => {
    const { u, wait } = await uci();
    u.handle('position startpos moves e2e4 zz99'); u.handle('go movetime 20');
    expect(await wait((l) => l.startsWith('bestmove'))).toMatch(/^bestmove [a-h][1-8]/);
    u.handle('position fen 7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'); u.handle('go movetime 20');
    expect(await wait((l) => l.startsWith('bestmove'))).toBe('bestmove (none)');
  });
  it('reduced skill still plays legal moves', async () => {
    const { u, wait } = await uci();
    u.handle('setoption name Skill Level value 2');
    for (let i = 0; i < 4; i++) { u.handle('position startpos moves d2d4'); u.handle('go movetime 30'); expect(await wait((l) => l.startsWith('bestmove'))).toMatch(/^bestmove [a-h][1-8][a-h][1-8]/); }
  });
});
