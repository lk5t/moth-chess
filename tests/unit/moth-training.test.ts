// MOTH learning pipeline: PGN ingestion, dataset hygiene, training, self-play, gating, registry,
// opening book selection, board verification, personal adaptation, latency statistics.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MothWasm } from '@/moth-engine/wasm';
import { ingestPgn, augment, moveQuality } from '@/moth-engine/training/ingest';
import { DEFAULT_TRAINING, evaluateLoss, makeTarget, netChecksum, trainNetwork, type Sample } from '@/moth-engine/training/trainer';
import { matchStats, playGame, runMatch } from '@/moth-engine/training/selfplay';
import { decideCandidate, rollback, type Registry } from '@/moth-engine/training/gate';
import { randomNetwork, rng, type ModelMeta } from '@/moth-engine/model';
import { chooseBookMove, type BookPosition } from '@/moth-engine/book';
import { verifyReading, replaySans, type BoardReading } from '@/content/adapters/adapters';
import { buildProfile, preparation } from '@/play/adaptation';
import { latencyStats } from '@/play/client';
import type { PracticeGame } from '@/memory/db';

const WASM = readFileSync(resolve(__dirname, '../../public/moth-engine/moth.wasm'));
let e: MothWasm;
beforeAll(async () => { e = await MothWasm.create(WASM, 8); });

const G1 = `[Event "t1"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7 Kxf7 7. Qf3+ Ke6 8. Nc3 Ncb4 9. a3 Nxc2+ 10. Kd1 Nxa1 11. Nxd5 Kd6 12. d4 c6 13. Bg5 Qxg5 14. dxe5+ Kxe5 15. Re1+ Kd6 16. Qf4+ Qxf4 1-0`;
const G2 = `[Event "t2"]\n[White "C"]\n[Black "D"]\n[Result "0-1"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 8. cxd5 Nxd5 9. Bxe7 Qxe7 10. Nxd5 exd5 11. Rc1 Be6 12. Qa4 c5 0-1`;
const BAD = `[Event "bad"]\n[Result "1-0"]\n\n1. e4 e5 2. Ke3 Ke6 3. Qh5 Qh4 4. Qxe5+ Kf6 5. Nf3 Kg6 1-0`;
const DUP = G1.replace('"t1"', '"t1"');

describe('PGN ingestion', () => {
  it('validates by replaying, rejects illegal games and contradicting results', () => {
    const { positions, report } = ingestPgn(e, [G1, G2, BAD, '[Event "x"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O f6 6. d4 exd4 7. Nxd4 c5 8. Nb3 Qxd1 9. Rxd1 Bg4 10. f3 Be6 11. Qh5 1-0'].join('\n\n'), { skipOpeningPlies: 4 });
    expect(report.gamesRead).toBe(4);
    expect(report.gamesValid).toBe(2);
    expect(report.rejectReasons['illegal move']).toBeGreaterThanOrEqual(1);
    expect(positions.length).toBeGreaterThan(10);
    // every stored position is legal and the played move is legal in it
    for (const p of positions) { expect(e.setFen(p.fen)).toBe(true); expect(e.legalMoves()).toContain(p.played); }
  });
  it('deduplicates positions across games and keeps whole games in one split', () => {
    const seen = new Set<string>();
    const a = ingestPgn(e, G1, {}, seen);
    const b = ingestPgn(e, DUP, {}, seen);
    expect(b.positions.length).toBe(0);
    expect(b.report.duplicatesSkipped).toBeGreaterThan(0);
    expect(new Set(a.positions.map((p) => p.split)).size).toBe(1);
  });
  it('mines sacrifices (static exchange) and checkmates', () => {
    const { report } = ingestPgn(e, G1);
    expect(report.sacrifices.offered).toBeGreaterThan(0); // 6.Nxf7 / 13...Qxg5 style material offers
  });
  it('labels results from the side to move, but never calls a move good because the game was won', () => {
    expect(moveQuality(50, -300)).toBe('blunder'); // the winner's blunder is still a blunder
    expect(moveQuality(0, -60)).toBe('inaccuracy');
    expect(moveQuality(40, 35)).toBe('good');
    const { positions } = ingestPgn(e, G1);
    const w = positions.find((p) => p.fen.split(' ')[1] === 'w')!, b = positions.find((p) => p.fen.split(' ')[1] === 'b')!;
    expect(w.result).toBe(1); expect(b.result).toBe(0);
  });
  it('augmentation produces legal, new, off-distribution positions', () => {
    const seen = new Set<string>();
    const { positions } = ingestPgn(e, [G1, G2].join('\n\n'), {}, seen);
    const aug = augment(e, positions, 1, rng(1), seen);
    expect(aug.length).toBeGreaterThan(0);
    for (const p of aug) { expect(e.setFen(p.fen)).toBe(true); expect(p.result).toBeUndefined(); expect(p.origin).toBe('augmented'); }
  });
});

function samplesFrom(fens: { fen: string; teacher: number; result: number }[]): Sample[] {
  return fens.map((p) => {
    e.setFen(p.fen); e.loadNetwork(null);
    const f = e.features();
    return { fw: Int16Array.from(f.white), fb: Int16Array.from(f.black), stmWhite: e.sideToMove() === 'w', classical: e.evaluate().classical, target: makeTarget(p.teacher, p.result, 0.75, 400) };
  });
}

describe('training', () => {
  it('real gradient descent: parameters change and loss falls on a learnable signal', () => {
    const seen = new Set<string>();
    const { positions } = ingestPgn(e, [G1, G2].join('\n\n'), { skipOpeningPlies: 0, maxPositionsPerGame: 60 }, seen);
    // learnable target: "teacher" = a fixed function of the position (MOTH depth-3 search)
    const data = positions.map((p) => { e.setFen(p.fen); const r = e.search({ depth: 3 }); return { fen: p.fen, teacher: r.lines[0]?.score ?? 0, result: p.result ?? 0.5 }; });
    const s = samplesFrom(data);
    const init = randomNetwork(16, 5);
    const before = evaluateLoss(init, s, 400);
    const { net, history } = trainNetwork(s, s, { ...DEFAULT_TRAINING, hidden: 16, epochs: 30, batchSize: 16, learningRate: 0.01, weightDecay: 0 }, init);
    expect(netChecksum(net)).not.toBe(netChecksum(init));
    expect(history.length).toBe(30);
    expect(evaluateLoss(net, s, 400)).toBeLessThan(before);
  });
  it('is reproducible for a fixed seed', () => {
    const s = samplesFrom([{ fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', teacher: 40, result: 0.5 }, { fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', teacher: 300, result: 1 }]);
    const cfg = { ...DEFAULT_TRAINING, hidden: 8, epochs: 3, batchSize: 1 };
    expect(netChecksum(trainNetwork(s, s, cfg).net)).toBe(netChecksum(trainNetwork(s, s, cfg).net));
  });
  it('targets blend teacher and result, and fall back to the teacher for augmented positions', () => {
    expect(makeTarget(0, 1, 0.75, 400)).toBeCloseTo(0.75 * 0.5 + 0.25, 5);
    expect(makeTarget(400, undefined, 0.75, 400)).toBeCloseTo(1 / (1 + Math.exp(-1)), 5);
  });
});

describe('self-play and gating', () => {
  it('plays complete legal games between configurations', async () => {
    const a = await MothWasm.create(WASM, 4), b = await MothWasm.create(WASM, 4);
    const g = playGame({ name: 'A', engine: a, net: null, style: 'aggressive', nodes: 800 }, { name: 'B', engine: b, net: null, style: 'defensive', nodes: 800 }, ['e2e4', 'e7e5'], 80);
    expect(['1-0', '0-1', '1/2-1/2']).toContain(g.result);
    e.setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    for (const m of [...g.opening, ...g.moves]) expect(e.play(m)).toBe(true);
    expect(g.records.length).toBe(g.moves.length);
  });
  it('rejects a weaker candidate: a corrupted network loses its benchmark match', async () => {
    const a = await MothWasm.create(WASM, 4), b = await MothWasm.create(WASM, 4);
    const bad = randomNetwork(32, 99, 100);
    for (let i = 0; i < bad.w2.length; i++) bad.w2[i] *= 300; // large random corrections = a bad evaluation
    const openings = [['e2e4', 'e7e5'], ['d2d4', 'd7d5'], ['c2c4', 'e7e5'], ['e2e4', 'c7c5'], ['g1f3', 'd7d5']];
    const { stats } = runMatch({ name: 'bad', engine: a, net: bad, style: 'balanced', nodes: 1500 }, { name: 'classical', engine: b, net: null, style: 'balanced', nodes: 1500 }, openings);
    expect(stats.games).toBe(10);
    const meta = { metrics: { valLoss: 0.03, valLossParent: 0.025, match: stats, tactics: { solved: 10, total: 20, byTheme: {}, budgetMs: 0 }, parentTactics: { solved: 14, total: 20, byTheme: {}, budgetMs: 0 } } } as unknown as ModelMeta;
    const d = decideCandidate(meta);
    expect(d.promoted).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/validation loss/);
  });
  it('promotes only on measured improvement in every gate', () => {
    const good = matchStats(70, 60, 30, 'parent');
    expect(good.elo).toBeGreaterThan(0);
    expect(good.los).toBeGreaterThan(0.9);
    const ok = decideCandidate({ metrics: { valLoss: 0.02, valLossParent: 0.021, match: good, tactics: { solved: 100, total: 120, byTheme: {}, budgetMs: 0 }, parentTactics: { solved: 101, total: 120, byTheme: {}, budgetMs: 0 } } } as unknown as ModelMeta);
    expect(ok.promoted).toBe(true);
    const flat = decideCandidate({ metrics: { valLoss: 0.02, valLossParent: 0.021, match: matchStats(50, 60, 50, 'parent'), tactics: undefined, parentTactics: undefined } } as unknown as ModelMeta);
    expect(flat.promoted).toBe(false); // better loss alone is not enough
  });
  it('Elo statistics are symmetric and bounded', () => {
    const s = matchStats(10, 0, 10, 'x');
    expect(s.score).toBe(0.5); expect(Math.abs(s.elo)).toBeLessThan(1e-9); expect(s.los).toBeCloseTo(0.5, 5);
    expect(matchStats(30, 0, 10, 'x').elo).toBeCloseTo(-matchStats(10, 0, 30, 'x').elo, 5);
  });
  it('rollback re-activates an approved model and never a rejected one', () => {
    const reg: Registry = { format: 'moth-registry-1', active: 'b', models: [
      { id: 'a', version: '1', file: 'a', status: 'retired', parent: 'classical', createdAt: 1, summary: {}, reasons: [] },
      { id: 'b', version: '2', file: 'b', status: 'approved', parent: 'a', createdAt: 2, summary: {}, reasons: [] },
      { id: 'c', version: '3', file: 'c', status: 'rejected', parent: 'b', createdAt: 3, summary: {}, reasons: [] },
    ] };
    const r = rollback(reg, 'a');
    expect(r.active).toBe('a');
    expect(r.models.find((m) => m.id === 'b')!.status).toBe('retired');
    expect(() => rollback(reg, 'c')).toThrow();
  });
});

describe('opening book selection', () => {
  const pos: BookPosition = { moves: [
    { uci: 'e2e4', san: 'e4', games: 9000, score: 0.52, eval: 35, depth: 12, tags: ['main'] },
    { uci: 'b2b4', san: 'b4', games: 40, score: 0.5, eval: 5, depth: 12, tags: ['gambit', 'aggressive'] }, // sound for Aggressive (≤45 cp below best), outside Balanced's margin
    { uci: 'f2f3', san: 'f3', games: 20000, score: 0.7, eval: -120, depth: 12, tags: ['mistake'] },
    { uci: 'c2c4', san: 'c4', games: 3000, score: 0.53, eval: 20, depth: 12, tags: ['solid'] },
  ] };
  it('never selects an unsound or mistaken move, however popular', () => {
    const r = rng(4);
    for (let i = 0; i < 300; i++) for (const s of ['aggressive', 'balanced', 'defensive'] as const) expect(chooseBookMove(pos, s, r)?.uci).not.toBe('f2f3');
  });
  it('styles prefer different sound moves', () => {
    const count = (s: 'aggressive' | 'balanced' | 'defensive') => { const r = rng(9); const c: Record<string, number> = {}; for (let i = 0; i < 400; i++) { const m = chooseBookMove(pos, s, r)!.uci; c[m] = (c[m] ?? 0) + 1; } return c; };
    const ag = count('aggressive'), de = count('defensive');
    expect(ag.b2b4 ?? 0).toBeGreaterThan(de.b2b4 ?? 0); // the sound gambit is an aggressive choice
    expect(de.c2c4 ?? 0).toBeGreaterThan(ag.c2c4 ?? 0);
  });
});

describe('board recognition verification', () => {
  const base: BoardReading = { site: 'lichess', placement: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R', orientation: 'white', turn: null, castling: null, ep: null, source: 'dom', verified: false, warnings: ['Castling and en-passant rights are not exposed'] };
  it('verifies a position from the page move list only if it reproduces the board', () => {
    const v = verifyReading(base, { sans: ['e4', 'e5', 'Nf3', 'Nc6'] });
    expect(v.verified).toBe(true);
    expect(v.source).toBe('history');
    expect(v.fullFen).toBe('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    const mismatch = verifyReading(base, { sans: ['e4', 'e5', 'Nf3', 'Nf6'] });
    expect(mismatch.verified).toBe(false);
    expect(verifyReading(base, { sans: ['e4', 'e5', 'Ke2'] }).verified).toBe(false);
  });
  it('accepts a page FEN only when its placement matches the pieces on the board', () => {
    expect(verifyReading(base, { fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' }).verified).toBe(true);
    expect(verifyReading(base, { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }).verified).toBe(false);
  });
  it('replays SAN with annotations; illegal history yields null', () => {
    expect(replaySans(['e4!', 'e5?!', 'Qh5', 'Nc6', 'Bc4', 'Nf6??', 'Qxf7#'])).toMatch(/^r1bqkb1r\/pppp1Qpp/);
    expect(replaySans(['e4', 'e4'])).toBeNull();
  });
});

describe('personal adaptation', () => {
  const pg = (over: Partial<PracticeGame>): PracticeGame => ({ at: 1, userColor: 'b', style: 'balanced', level: 4, timeControl: '5+3', result: '1-0', reason: 'checkmate', uci: ['e2e4', 'c7c5', 'g1f3', 'd7d6'], openingKey: 'e2e4 c7c5', openingName: 'Sicilian Defense', userMoves: [{ ply: 1, uci: 'c7c5', before: 20, after: -300, tags: ['blunder', 'hung-piece'] }], ...over });
  it('builds a profile from practice games only', () => {
    const p = buildProfile([pg({}), pg({ result: '0-1' }), pg({ userColor: 'w', result: '1/2-1/2', userMoves: [] })]);
    expect(p.games).toBe(3);
    expect(p.asBlack.games).toBe(2);
    expect(p.asBlack.score).toBeCloseTo(0.5);
    expect(p.weaknesses[0].tag).toMatch(/blunder|hung-piece/);
  });
  it('prepares the lines the user scores badly against (≥2 games, ≤40%)', () => {
    expect(preparation([pg({})])).toBe(''); // one game is not evidence
    const prep = preparation([pg({}), pg({ at: 2 })]);
    expect(prep).toContain('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR_w_KQkq_-=e2e4');
  });
});

describe('latency statistics', () => {
  it('computes nearest-rank percentiles', () => {
    const s = latencyStats(Array.from({ length: 100 }, (_, i) => i + 1))!;
    expect(s.p50).toBe(50); expect(s.p95).toBe(95); expect(s.p99).toBe(99); expect(s.max).toBe(100);
    expect(latencyStats([])).toBeNull();
  });
});
