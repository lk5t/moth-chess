import { describe, it, expect } from 'vitest';
import { THRESHOLDS, classify, buildReviewedMoves, evaluateGame, gameAccuracy, reviewSummary, annotatedPgn, type PositionEval, type Evaluator } from '@/review/review';
import { checkExerciseMove, dailySession, detectMotifs, exercisesFromReview, scheduleAfterAttempt, analyseWeaknesses, MIN_SAMPLE } from '@/coach/coach';
import { computeDashboard, filterGames } from '@/dashboard/metrics';
import { parsePgn, legalMoves } from '@/chess/position';
import { toWhite } from '@/engine/normalize';
import type { EngineResult, GameReview, SavedGame, ExerciseAttempt } from '@/types';


// White blunders the queen on move 3 (Qh5?? Nxh5 is not possible… use a clean example): 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#
const PGN = `[White "me"]\n[Black "opp"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

/** Fake evaluator: returns scripted White-perspective scores per ply, best move = first legal move unless overridden. */
function scripted(scores: number[], best: Record<number, string> = {}): Evaluator & { calls: number } {
  const g = parsePgn(PGN);
  const fens = [g.startFen, ...g.moves.map((m) => m.fenAfter)];
  const f = (async (fen: string, depth: number) => {
    f.calls++;
    const i = fens.indexOf(fen);
    const turn = fen.split(' ')[1] as 'w' | 'b';
    const moves = legalMoves(fen);
    const white = scores[i];
    const raw = moves.length === 0 ? { type: 'mate' as const, value: 0 } : { type: 'cp' as const, value: turn === 'w' ? white : -white };
    const pv = moves.length ? [best[i] ?? moves[0].uci] : [];
    const r: EngineResult = { fen, searchId: i, depth, complete: true, bestMove: pv[0], lines: [{ multipv: 1, depth, score: raw, whiteScore: toWhite(raw, turn), pv, pvSan: [] }] };
    return r;
  }) as Evaluator & { calls: number };
  f.calls = 0;
  return f;
}

describe('move classification', () => {
  it('applies the documented win%-drop thresholds', () => {
    const base = { playedUci: 'e2e4', bestUci: 'd2d4', forced: false, book: false };
    expect(classify({ ...base, drop: 0.5 })).toBe('best');
    expect(classify({ ...base, drop: 3 })).toBe('good');
    expect(classify({ ...base, drop: THRESHOLDS.inaccuracy })).toBe('inaccuracy');
    expect(classify({ ...base, drop: THRESHOLDS.mistake })).toBe('mistake');
    expect(classify({ ...base, drop: THRESHOLDS.blunder + 10 })).toBe('blunder');
    expect(classify({ ...base, drop: 40, playedUci: 'd2d4' })).toBe('best');
    expect(classify({ ...base, drop: 40, forced: true })).toBe('forced');
  });
});

describe('game review', () => {
  const scores = [20, 30, 25, 10, 15, 20, 600, 10000];
  it('evaluates every position and classifies the blunder', async () => {
    const ev = scripted(scores, { 5: 'g7g6' });
    const r = await evaluateGame(ev, PGN, { depth: 10 });
    expect(r.complete).toBe(true);
    expect(r.evals).toHaveLength(8);
    expect(r.evals[7].score.winner).toBe('w'); // final position: black is mated
    const moves = buildReviewedMoves(r.moves, r.evals);
    const nf6 = moves.find((m) => m.san === 'Nf6')!;
    expect(nf6.classification).toBe('blunder');
    expect(nf6.bestMoveSan).toBe('g6');
    expect(moves.find((m) => m.san === 'e4')!.classification).toBe('book');
    expect(gameAccuracy(moves, 'b')!).toBeLessThan(gameAccuracy(moves, 'w')!);
    const summary = reviewSummary(moves, { White: 'me', Black: 'opp' });
    expect(summary.join(' ')).toMatch(/Turning point: 3\.\.\.Nf6/);
    expect(summary.join(' ')).toMatch(/not equivalent/);
  });
  it('is cancellable and resumable without recomputing finished positions', async () => {
    const ev = scripted(scores);
    const ac = new AbortController();
    let partial: PositionEval[] = [];
    const r1 = await evaluateGame(ev, PGN, { depth: 10, signal: ac.signal, onProgress: (d, _t, e) => { partial = e.slice(); if (d === 3) ac.abort(); } });
    expect(r1.complete).toBe(false);
    expect(r1.evals).toHaveLength(3);
    const before = ev.calls;
    const r2 = await evaluateGame(ev, PGN, { depth: 10, existing: partial });
    expect(r2.complete).toBe(true);
    expect(ev.calls - before).toBe(5);
  });
  it('stops instead of fabricating when the engine returns no line', async () => {
    const empty: Evaluator = async (fen, depth) => ({ fen, searchId: 0, depth, complete: true, lines: [] });
    await expect(evaluateGame(empty, PGN, { depth: 5 })).rejects.toThrow(/No engine evaluation/);
  });
  it('exports annotated PGN with NAGs and eval comments', async () => {
    const r = await evaluateGame(scripted(scores, { 5: 'g7g6' }), PGN, { depth: 10 });
    const review: GameReview = { gameId: 1, depth: 10, status: 'complete', progressPly: 8, totalPly: 8, moves: buildReviewedMoves(r.moves, r.evals), createdAt: 0, updatedAt: 0 };
    const out = annotatedPgn(review, parsePgn(PGN).headers);
    expect(out).toContain('Nf6 $4');
    expect(out).toContain('[%eval');
    expect(parsePgn(out).moves).toHaveLength(7);
  });
});

describe('MOTH Coach', () => {
  async function review(): Promise<GameReview> {
    const r = await evaluateGame(scripted([20, 30, 25, 10, 15, 20, 600, 10000], { 5: 'g7g6' }), PGN, { depth: 10 });
    return { id: 1, gameId: 7, depth: 10, status: 'complete', progressPly: 8, totalPly: 8, moves: buildReviewedMoves(r.moves, r.evals), createdAt: Date.now(), updatedAt: Date.now() };
  }
  it('creates exercises only from the user’s own mistakes', async () => {
    const rv = await review();
    expect(exercisesFromReview(rv, { userColor: 'w' })).toHaveLength(0);
    const exs = exercisesFromReview(rv, { userColor: 'b' });
    expect(exs).toHaveLength(1);
    expect(exs[0]).toMatchObject({ solutionSan: 'g6', playedSan: 'Nf6', sourceGameId: 7, box: 0 });
    expect(exs[0].motifs).toContain('defensive');
  });
  it('validates moves: correct, near-equal alternative, game mistake, illegal', async () => {
    const [ex] = exercisesFromReview(await review(), { userColor: 'b' });
    expect(checkExerciseMove(ex, 'g7g6').result).toBe('correct');
    expect(checkExerciseMove(ex, 'd8e7', 10).result).toBe('alternative');
    expect(checkExerciseMove(ex, 'g8f6').result).toBe('incorrect');
    expect(checkExerciseMove(ex, 'e1e2').result).toBe('illegal');
  });
  it('detects tactical motifs from verified geometry', () => {
    expect(detectMotifs('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', 'd5c7')).toEqual(expect.arrayContaining(['fork', 'check']));
    expect(detectMotifs('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'd1d8')).toContain('mate-threat');
    expect(detectMotifs('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1', 'e4d5')).toContain('hanging-piece');
  });
  it('schedules with spaced repetition and builds due sessions', async () => {
    const [ex] = exercisesFromReview(await review(), { userColor: 'b' });
    const now = 1_000_000_000;
    const ok = scheduleAfterAttempt(ex, true, now);
    expect(ok.box).toBe(1);
    expect(ok.dueAt).toBe(now + 86_400_000);
    expect(scheduleAfterAttempt({ ...ex, box: 3 }, false, now).box).toBe(0);
    expect(dailySession([{ ...ex, dueAt: now + 1 }], { now })).toHaveLength(0);
    expect(dailySession([{ ...ex, dueAt: now - 1 }], { now })).toHaveLength(1);
  });
  it('refuses to draw conclusions from insufficient data', async () => {
    const rv = await review();
    const rep = analyseWeaknesses([rv], exercisesFromReview(rv, { userColor: 'b' }), [], new Map([[7, 'b']]));
    expect(rep.sufficientData).toBe(false);
    expect(rep.recommendations[0]).toMatch(/Not enough data/);
    expect(rep.recurring).toHaveLength(0);
    expect(MIN_SAMPLE).toBeGreaterThanOrEqual(3);
  });
});

describe('Performance Dashboard', () => {
  const game = (id: number, result: SavedGame['result'], userColor: 'w' | 'b', eco: string, importedAt = Date.now()): SavedGame => ({
    id, pgn: PGN, headers: {}, white: 'a', black: 'b', result, eco, openingName: eco, plyCount: 7, contentHash: String(id), importedAt, userColor, tags: [],
  });
  it('computes explainable metrics with sample sizes and low-confidence flags', async () => {
    const r = await evaluateGame(scripted([20, 30, 25, 10, 15, 20, 600, 10000], { 5: 'g7g6' }), PGN, { depth: 10 });
    const moves = buildReviewedMoves(r.moves, r.evals);
    const reviews: GameReview[] = [1, 2].map((gameId) => ({ gameId, depth: 10, status: 'complete', progressPly: 8, totalPly: 8, moves, createdAt: Date.now(), updatedAt: Date.now(), accuracyWhite: gameAccuracy(moves, 'w'), accuracyBlack: gameAccuracy(moves, 'b') }));
    const attempts: ExerciseAttempt[] = [{ exerciseId: 1, at: Date.now(), correct: true, movePlayedUci: 'g7g6', timeMs: 1000, category: 'defence', motifs: [] }];
    const d = computeDashboard([game(1, '1-0', 'b', 'C20'), game(2, '1-0', 'w', 'C20')], reviews, attempts);
    expect(d.gamesReviewed).toBe(2);
    expect(d.accuracy.n).toBe(2);
    expect(d.accuracy.lowConfidence).toBe(true);
    expect(d.accuracy.explanation).toMatch(/Not comparable/);
    expect(d.blundersPer100.value).toBeGreaterThan(0);
    expect(d.trainingSuccess.value).toBe(100);
    expect(d.openings[0]).toMatchObject({ eco: 'C20', games: 2, score: 50 });
  });
  it('filters by colour, result, opening and date', () => {
    const old = Date.now() - 100 * 86_400_000;
    const gs = [game(1, '1-0', 'w', 'B90'), game(2, '0-1', 'w', 'C20'), game(3, '1/2-1/2', 'b', 'B12', old)];
    expect(filterGames(gs, { eco: 'B' }).map((g) => g.id)).toEqual([1, 3]);
    expect(filterGames(gs, { result: 'win' }).map((g) => g.id)).toEqual([1]);
    expect(filterGames(gs, { result: 'draw' }).map((g) => g.id)).toEqual([3]);
    expect(filterGames(gs, { color: 'b' }).map((g) => g.id)).toEqual([3]);
    expect(filterGames(gs, { from: Date.now() - 86_400_000 }).map((g) => g.id)).toEqual([1, 2]);
  });
  it('returns nulls (not invented numbers) when there is no data', () => {
    const d = computeDashboard([], [], []);
    expect(d.accuracy.value).toBeNull();
    expect(d.trainingSuccess.value).toBeNull();
    expect(d.gamesReviewed).toBe(0);
  });
});
