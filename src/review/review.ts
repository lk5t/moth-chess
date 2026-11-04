// PGN game review: sequential, cancellable, resumable engine analysis + move classification.
import type { Color, EngineResult, GameReview, MoveClass, ReviewedMove, WhiteScore, MoveRecord, GamePhase } from '@/types';
import { moveAccuracy, moverWinPercent, formatScore } from '@/engine/normalize';
import { legalMoves, parsePgn, uciLineToSan, buildPgn } from '@/chess/position';
import { lookupPosition } from '@/openings/eco';
import { parseBoard, phaseOf } from '@/chess/geometry';

/** Win%-drop thresholds (mover's perspective, 0–100 scale). Derived from Lichess's open-source judgement levels. */
export const THRESHOLDS = { inaccuracy: 5, mistake: 10, blunder: 15 } as const;

export interface PositionEval { fen: string; score: WhiteScore; bestUci?: string; depth: number }

export function classify(opts: { drop: number; playedUci: string; bestUci?: string; forced: boolean; book: boolean }): MoveClass {
  if (opts.forced) return 'forced';
  if (opts.book) return 'book';
  if (opts.bestUci && opts.playedUci === opts.bestUci) return 'best';
  if (opts.drop >= THRESHOLDS.blunder) return 'blunder';
  if (opts.drop >= THRESHOLDS.mistake) return 'mistake';
  if (opts.drop >= THRESHOLDS.inaccuracy) return 'inaccuracy';
  return opts.drop <= 1 ? 'best' : 'good';
}

/** Turn per-position evaluations into reviewed moves. evals[i] = position BEFORE move i; evals[n] = final position. */
export function buildReviewedMoves(moves: MoveRecord[], evals: PositionEval[]): ReviewedMove[] {
  const out: ReviewedMove[] = [];
  let bookStill = true;
  for (let i = 0; i < moves.length && i + 1 < evals.length; i++) {
    const m = moves[i];
    const before = evals[i], after = evals[i + 1];
    const winBefore = moverWinPercent(before.score, m.color);
    const winAfter = moverWinPercent(after.score, m.color);
    const drop = Math.max(0, winBefore - winAfter);
    const book = bookStill && i < 30 && !!lookupPosition(m.fenAfter);
    if (!book) bookStill = false;
    const forced = legalMoves(m.fenBefore).length === 1;
    const best = before.bestUci ? uciLineToSan(m.fenBefore, [before.bestUci]).san[0] : undefined;
    out.push({
      ply: i + 1, san: m.san, uci: m.uci, color: m.color, fenBefore: m.fenBefore, fenAfter: m.fenAfter,
      evalBefore: before.score, evalAfter: after.score, bestMoveUci: before.bestUci, bestMoveSan: best,
      winBefore, winAfter, accuracy: book || forced ? 100 : moveAccuracy(winBefore, winAfter),
      classification: classify({ drop, playedUci: m.uci, bestUci: before.bestUci, forced, book }),
      phase: phaseOf(parseBoard(m.fenBefore), i) as GamePhase,
    });
  }
  return out;
}

/** Game accuracy per colour: harmonic-leaning mean of move accuracies (penalises blunders more than a plain mean). */
export function gameAccuracy(moves: ReviewedMove[], color: Color): number | undefined {
  const a = moves.filter((m) => m.color === color && m.classification !== 'book' && m.classification !== 'forced').map((m) => m.accuracy);
  if (!a.length) return undefined;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const harmonic = a.length / a.reduce((s, x) => s + 1 / Math.max(1, x), 0);
  return Math.round(((mean + harmonic) / 2) * 10) / 10;
}

export function countClasses(moves: ReviewedMove[], color?: Color) {
  const c: Record<MoveClass, number> = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, book: 0, forced: 0 };
  for (const m of moves) if (!color || m.color === color) c[m.classification]++;
  return c;
}

export function reviewSummary(moves: ReviewedMove[], headers: Record<string, string> = {}): string[] {
  const s: string[] = [];
  for (const color of ['w', 'b'] as Color[]) {
    const name = (color === 'w' ? headers.White : headers.Black) || (color === 'w' ? 'White' : 'Black');
    const c = countClasses(moves, color);
    const acc = gameAccuracy(moves, color);
    s.push(`${name}: ${acc !== undefined ? `estimated accuracy ${acc}%` : 'no scored moves'} — ${c.blunder} blunder${c.blunder === 1 ? '' : 's'}, ${c.mistake} mistake${c.mistake === 1 ? '' : 's'}, ${c.inaccuracy} inaccurac${c.inaccuracy === 1 ? 'y' : 'ies'}.`);
  }
  const worst = [...moves].filter((m) => m.classification === 'blunder' || m.classification === 'mistake').sort((a, b) => (b.winBefore - b.winAfter) - (a.winBefore - a.winAfter))[0];
  if (worst) {
    const num = Math.ceil(worst.ply / 2);
    s.push(`Turning point: ${num}${worst.color === 'w' ? '.' : '...'}${worst.san} (${worst.classification}) — win chance fell from ${worst.winBefore.toFixed(0)}% to ${worst.winAfter.toFixed(0)}%. ${worst.bestMoveSan ? `${worst.bestMoveSan} was stronger.` : ''}`.trim());
  }
  const leftBook = moves.find((m) => m.classification !== 'book');
  if (leftBook && leftBook.ply > 1) s.push(`The game left the local opening book at move ${Math.ceil(leftBook.ply / 2)}.`);
  const phases: GamePhase[] = ['opening', 'middlegame', 'endgame'];
  for (const p of phases) {
    const pm = moves.filter((m) => m.phase === p && m.classification !== 'book' && m.classification !== 'forced');
    if (pm.length >= 4) {
      const avg = pm.reduce((x, m) => x + m.accuracy, 0) / pm.length;
      s.push(`${p[0].toUpperCase() + p.slice(1)}: average move accuracy ${avg.toFixed(0)}% over ${pm.length} moves.`);
    }
  }
  s.push('Accuracy is a MOTH estimate from engine win-probability changes; it is not equivalent to any chess site\'s proprietary score.');
  return s;
}

export interface ReviewRunOptions {
  depth: number;
  signal?: AbortSignal;
  /** previously computed evaluations (resume) */
  existing?: PositionEval[];
  onProgress?: (done: number, total: number, evals: PositionEval[]) => void;
}

export type Evaluator = (fen: string, depth: number, signal?: AbortSignal) => Promise<EngineResult>;

/**
 * Evaluate every position of a game. Resumes from `existing`; stops early (returning partial results) when aborted.
 * The evaluator is injected (engine queue in the extension, a fake in unit tests).
 */
export async function evaluateGame(evaluate: Evaluator, pgn: string, opts: ReviewRunOptions): Promise<{ evals: PositionEval[]; complete: boolean; moves: MoveRecord[] }> {
  const g = parsePgn(pgn);
  const fens = [g.startFen, ...g.moves.map((m) => m.fenAfter)];
  const evals: PositionEval[] = [];
  for (const e of opts.existing ?? []) { if (evals.length < fens.length && e.fen === fens[evals.length]) evals.push(e); else break; }
  for (let i = evals.length; i < fens.length; i++) {
    if (opts.signal?.aborted) return { evals, complete: false, moves: g.moves };
    let r: EngineResult;
    try {
      r = await evaluate(fens[i], opts.depth, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) return { evals, complete: false, moves: g.moves };
      throw e;
    }
    if (!r.complete && opts.signal?.aborted) return { evals, complete: false, moves: g.moves };
    const top = r.lines[0];
    // Never fabricate: a position without an engine line stops the review.
    if (!top) throw new Error(`No engine evaluation for position ${i}`);
    evals.push({ fen: fens[i], score: top.whiteScore, bestUci: r.bestMove ?? top.pv[0], depth: top.depth });
    opts.onProgress?.(evals.length, fens.length, evals);
  }
  return { evals, complete: true, moves: g.moves };
}

const NAG: Partial<Record<MoveClass, string>> = { inaccuracy: '$6', mistake: '$2', blunder: '$4' };

export function annotatedPgn(review: GameReview, headers: Record<string, string>, startFen?: string): string {
  return buildPgn({
    headers: { ...headers, Annotator: `MOTH Chess (Stockfish depth ${review.depth})` },
    startFen,
    result: (headers.Result as never) ?? '*',
    moves: review.moves.map((m) => ({
      san: m.san,
      nag: NAG[m.classification],
      comment: [
        `[%eval ${m.evalAfter.type === 'mate' ? '#' + m.evalAfter.value : (m.evalAfter.value / 100).toFixed(2)}]`,
        m.classification !== 'best' && m.classification !== 'book' && m.classification !== 'forced' && m.classification !== 'good' && m.bestMoveSan ? `${m.classification}; best was ${m.bestMoveSan}` : '',
      ].filter(Boolean).join(' '),
    })),
  });
}

export function evalLabel(s: WhiteScore) { return formatScore(s); }
