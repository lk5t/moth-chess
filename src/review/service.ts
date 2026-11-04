// Runs a full game review against the batch engine and persists progress (resumable) + results + coach exercises.
import type { GameReview } from '@/types';
import { db } from '@/memory/db';
import { queuedEvaluate } from '@/engine/queue';
import { buildReviewedMoves, evaluateGame, gameAccuracy, reviewSummary, type Evaluator, type PositionEval } from './review';
import { exercisesFromReview } from '@/coach/coach';

export const engineEvaluator: Evaluator = (fen, depth, signal) => queuedEvaluate(fen, depth, 1, signal);

export async function reviewFor(gameId: number): Promise<GameReview | undefined> {
  return db().reviews.where('gameId').equals(gameId).last();
}

export async function runReview(gameId: number, depth: number, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; evaluate?: Evaluator } = {}): Promise<GameReview> {
  const d = db();
  const game = await d.games.get(gameId);
  if (!game) throw new Error('Game not found');
  let review = await reviewFor(gameId);
  const now = Date.now();
  if (!review || review.depth !== depth) {
    if (review?.id) await d.reviews.delete(review.id);
    review = { gameId, depth, status: 'running', progressPly: 0, totalPly: game.plyCount + 1, moves: [], evals: [], createdAt: now, updatedAt: now };
    review.id = await d.reviews.add(review);
  } else {
    await d.reviews.update(review.id!, { status: 'running', updatedAt: now });
  }
  const id = review.id!;
  let lastSave = 0;
  const res = await evaluateGame(opts.evaluate ?? engineEvaluator, game.pgn, {
    depth,
    signal: opts.signal,
    existing: review.evals as PositionEval[] | undefined,
    onProgress: (done, total, evals) => {
      opts.onProgress?.(done, total);
      if (done - lastSave >= 4) { lastSave = done; void d.reviews.update(id, { evals: evals.slice(), progressPly: done, totalPly: total, updatedAt: Date.now() }); }
    },
  });
  const moves = buildReviewedMoves(res.moves, res.evals);
  const patch: Partial<GameReview> = {
    evals: res.evals, progressPly: res.evals.length, totalPly: res.moves.length + 1, moves, updatedAt: Date.now(),
    status: res.complete ? 'complete' : 'paused',
  };
  if (res.complete) {
    patch.accuracyWhite = gameAccuracy(moves, 'w');
    patch.accuracyBlack = gameAccuracy(moves, 'b');
    patch.summary = reviewSummary(moves, game.headers);
  }
  await d.reviews.update(id, patch);
  const saved = (await d.reviews.get(id))!;
  if (res.complete) {
    await d.games.update(gameId, { reviewId: id });
    const exs = exercisesFromReview(saved, { userColor: game.userColor, gameId });
    for (const ex of exs) if (!(await d.exercises.where('contentHash').equals(ex.contentHash).count())) await d.exercises.add(ex);
  }
  return saved;
}
