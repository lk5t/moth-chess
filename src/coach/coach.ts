// MOTH Coach — personalised training from the user's own reviewed games.
// Conclusions are only drawn when there is enough data; otherwise the coach says so.
import type { Color, ExerciseAttempt, ExerciseCategory, GameReview, ReviewedMove, TacticalMotif, TrainingExercise } from '@/types';
import { analyseThreats } from '@/threat-vision/threats';
import { applyMove } from '@/chess/position';
import { contentHash } from '@/utils/hash';
import { PIECE_VALUE, parseBoard, see, idx } from '@/chess/geometry';
import { THRESHOLDS } from '@/review/review';

export const MIN_SAMPLE = 3;
const DAY = 86_400_000;
const BOX_INTERVAL = [0, 1, 3, 7, 21].map((d) => d * DAY);

/** Identify which motifs the correct move exploits — from verified geometry and rules only. */
export function detectMotifs(fen: string, solutionUci: string): TacticalMotif[] {
  const motifs = new Set<TacticalMotif>();
  const rec = applyMove(fen, solutionUci);
  if (!rec) return [];
  const threats = analyseThreats(fen);
  if (rec.san.includes('#')) motifs.add('mate-threat');
  else if (rec.san.includes('+')) motifs.add('check');
  if (rec.promotion) motifs.add('promotion');
  if (threats.forks.some((f) => f.uci === solutionUci)) motifs.add('fork');
  if (rec.captured) {
    const g = see(parseBoard(fen), idx(rec.to), rec.color);
    if (g > 0) motifs.add(threats.hanging.some((h) => h.square === rec.to) ? 'hanging-piece' : 'material-gain');
  }
  const after = analyseThreats(rec.fenAfter);
  const enemy = rec.color === 'w' ? 'b' : 'w';
  if (after.pins.filter((p) => p.color === enemy).length > threats.pins.filter((p) => p.color === enemy).length) motifs.add('pin');
  if (after.skewers.filter((s) => s.color === enemy).length > threats.skewers.filter((s) => s.color === enemy).length) motifs.add('skewer');
  if (after.checks.some((c) => c.mate) && !rec.san.includes('#')) motifs.add('mate-threat');
  const myHangingBefore = threats.hanging.filter((h) => h.color === rec.color).reduce((s, h) => s + h.gain, 0);
  const myHangingAfter = after.hanging.filter((h) => h.color === rec.color).reduce((s, h) => s + h.gain, 0);
  if (myHangingBefore > 0 && myHangingAfter < myHangingBefore) motifs.add('defensive');
  if (!motifs.size) motifs.add('positional');
  return [...motifs];
}

function categoryFor(m: ReviewedMove, motifs: TacticalMotif[]): ExerciseCategory {
  if (m.winBefore >= 70 && m.winAfter < 60) return 'missed-win';
  if (motifs.includes('defensive')) return 'defence';
  if (m.phase === 'opening') return 'opening';
  if (m.phase === 'endgame') return 'endgame';
  if (motifs.some((x) => ['fork', 'pin', 'skewer', 'hanging-piece', 'material-gain', 'mate-threat', 'check'].includes(x))) return 'tactic';
  return 'middlegame';
}

const MOTIF_TEXT: Record<TacticalMotif, string> = {
  fork: 'a fork that attacks two targets at once',
  pin: 'a pin that freezes an enemy piece',
  skewer: 'a skewer through a valuable piece',
  'hanging-piece': 'winning a loose (undefended) piece',
  check: 'a forcing check',
  'mate-threat': 'a mating idea',
  'material-gain': 'a capture that wins material',
  positional: 'a positional improvement',
  promotion: 'pawn promotion',
  defensive: 'saving material that was under attack',
};

export function explainExercise(m: ReviewedMove, motifs: TacticalMotif[]): string {
  const idea = motifs.map((x) => MOTIF_TEXT[x]).join(', ');
  const lost = (m.winBefore - m.winAfter).toFixed(0);
  return `In the game ${m.san} was played (${m.classification}); ${m.bestMoveSan ?? 'the engine move'} was stronger. The key idea is ${idea}. Your winning chances dropped by about ${lost} percentage points.`;
}

/** Build exercises from a completed review — only the user's own mistakes/blunders when their colour is known. */
export function exercisesFromReview(review: GameReview, opts: { userColor?: Color; gameId?: number; minDrop?: number } = {}): TrainingExercise[] {
  const minDrop = opts.minDrop ?? THRESHOLDS.mistake;
  const out: TrainingExercise[] = [];
  for (const m of review.moves) {
    if (opts.userColor && m.color !== opts.userColor) continue;
    if (m.classification !== 'mistake' && m.classification !== 'blunder' && !(m.winBefore - m.winAfter >= minDrop)) continue;
    if (!m.bestMoveUci || m.bestMoveUci === m.uci || !m.bestMoveSan) continue;
    const motifs = detectMotifs(m.fenBefore, m.bestMoveUci);
    const now = Date.now();
    out.push({
      fen: m.fenBefore, solutionUci: m.bestMoveUci, solutionSan: m.bestMoveSan, playedUci: m.uci, playedSan: m.san,
      category: categoryFor(m, motifs), motifs, phase: m.phase, evalLossWin: m.winBefore - m.winAfter,
      sourceGameId: opts.gameId ?? review.gameId, sourcePly: m.ply, explanation: explainExercise(m, motifs),
      createdAt: now, box: 0, dueAt: now, contentHash: contentHash(`${m.fenBefore}|${m.bestMoveUci}`),
    });
  }
  return out;
}

export interface MoveCheck { result: 'correct' | 'alternative' | 'incorrect' | 'illegal'; san?: string; feedback: string }

/**
 * Validate a training move. `alternativeLossCp`, when provided by a quick engine check, lets
 * near-equal alternatives count as correct rather than insisting on one engine move.
 */
export function checkExerciseMove(ex: TrainingExercise, uci: string, alternativeLossCp?: number): MoveCheck {
  const rec = applyMove(ex.fen, uci);
  if (!rec) return { result: 'illegal', feedback: 'That move is not legal here.' };
  if (uci === ex.solutionUci) return { result: 'correct', san: rec.san, feedback: `Correct — ${rec.san}! ${ex.explanation.split('. ').slice(1).join('. ')}` };
  if (alternativeLossCp !== undefined && alternativeLossCp <= 30) return { result: 'alternative', san: rec.san, feedback: `${rec.san} is also good according to the engine (within ${(alternativeLossCp / 100).toFixed(2)} pawns). The game move to beat was ${ex.solutionSan}.` };
  if (ex.playedUci === uci) return { result: 'incorrect', san: rec.san, feedback: `${rec.san} is what was played in the game — it was a ${ex.evalLossWin >= THRESHOLDS.blunder ? 'blunder' : 'mistake'}. Look for ${ex.motifs.map((m) => MOTIF_TEXT[m]).join(' or ')}.` };
  return { result: 'incorrect', san: rec.san, feedback: `${rec.san} is not the strongest. Hint: look for ${ex.motifs.map((m) => MOTIF_TEXT[m]).join(' or ')}.` };
}

/** Leitner spaced repetition. */
export function scheduleAfterAttempt(ex: TrainingExercise, correct: boolean, now = Date.now()): Pick<TrainingExercise, 'box' | 'dueAt'> {
  const box = correct ? Math.min(4, ex.box + 1) : 0;
  return { box, dueAt: now + (correct ? BOX_INTERVAL[box] : 10 * 60_000) };
}

export function dailySession(exercises: TrainingExercise[], opts: { size?: number; category?: ExerciseCategory; now?: number } = {}): TrainingExercise[] {
  const now = opts.now ?? Date.now();
  const pool = exercises.filter((e) => !opts.category || e.category === opts.category);
  const due = pool.filter((e) => e.dueAt <= now).sort((a, b) => a.box - b.box || b.evalLossWin - a.evalLossWin);
  return due.slice(0, opts.size ?? 10);
}

export interface WeaknessReport {
  sufficientData: boolean;
  gamesReviewed: number;
  mistakesAnalysed: number;
  byCategory: { category: ExerciseCategory; count: number }[];
  byMotif: { motif: TacticalMotif; count: number }[];
  byPhase: { phase: string; count: number; avgLoss: number }[];
  recurring: string[];
  recommendations: string[];
  trend?: { recentAccuracy: number; earlierAccuracy: number; n: number };
}

export function analyseWeaknesses(reviews: GameReview[], exercises: TrainingExercise[], attempts: ExerciseAttempt[], userColorByGame: Map<number, Color | undefined>): WeaknessReport {
  const complete = reviews.filter((r) => r.status === 'complete');
  const userMoves = complete.flatMap((r) => r.moves.filter((m) => { const c = userColorByGame.get(r.gameId); return !c || m.color === c; }));
  const bad = userMoves.filter((m) => m.classification === 'mistake' || m.classification === 'blunder');
  const cat = new Map<ExerciseCategory, number>();
  const motif = new Map<TacticalMotif, number>();
  for (const e of exercises) {
    cat.set(e.category, (cat.get(e.category) ?? 0) + 1);
    for (const m of e.motifs) motif.set(m, (motif.get(m) ?? 0) + 1);
  }
  const phases = ['opening', 'middlegame', 'endgame'].map((p) => {
    const pm = bad.filter((m) => m.phase === p);
    return { phase: p, count: pm.length, avgLoss: pm.length ? pm.reduce((s, m) => s + (m.winBefore - m.winAfter), 0) / pm.length : 0 };
  });
  const sufficient = complete.length >= 2 && bad.length >= MIN_SAMPLE;
  const recurring: string[] = [];
  const recs: string[] = [];
  if (sufficient) {
    for (const [m, n] of [...motif.entries()].sort((a, b) => b[1] - a[1])) if (n >= MIN_SAMPLE && m !== 'positional') recurring.push(`Missed ${MOTIF_TEXT[m]} ${n} times.`);
    const worstPhase = [...phases].sort((a, b) => b.count - a.count)[0];
    if (worstPhase.count >= MIN_SAMPLE) recurring.push(`Most mistakes happen in the ${worstPhase.phase} (${worstPhase.count} of ${bad.length}).`);
    const hangingMissed = exercises.filter((e) => e.motifs.includes('defensive')).length;
    if (hangingMissed >= MIN_SAMPLE) recurring.push(`Left material under attack ${hangingMissed} times — check what your opponent threatens before moving.`);
    const topCat = [...cat.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCat) recs.push(`Focus training on "${topCat[0]}" exercises (${topCat[1]} generated from your games).`);
    if (worstPhase.phase === 'endgame' && worstPhase.count >= MIN_SAMPLE) recs.push('Study basic endgame technique: king activity, passed pawns, rook behind the pawn.');
    if (worstPhase.phase === 'opening' && worstPhase.count >= MIN_SAMPLE) recs.push('Review your openings in the Opening Explorer and save the lines you play as favourites.');
    const recentAttempts = attempts.filter((a) => a.at > Date.now() - 14 * DAY);
    if (recentAttempts.length >= 5) {
      const rate = recentAttempts.filter((a) => a.correct).length / recentAttempts.length;
      recs.push(`Training success over the last two weeks: ${(rate * 100).toFixed(0)}% (${recentAttempts.length} attempts).`);
    }
  } else {
    recs.push(`Not enough data yet: review at least 2 games with ${MIN_SAMPLE}+ mistakes for personal recommendations (currently ${complete.length} game${complete.length === 1 ? '' : 's'}, ${bad.length} mistake${bad.length === 1 ? '' : 's'}).`);
  }
  let trend: WeaknessReport['trend'];
  const sorted = [...complete].sort((a, b) => a.createdAt - b.createdAt);
  if (sorted.length >= 6) {
    const half = Math.floor(sorted.length / 2);
    const acc = (rs: GameReview[]) => {
      const v = rs.map((r) => { const c = userColorByGame.get(r.gameId); return c === 'b' ? r.accuracyBlack : c === 'w' ? r.accuracyWhite : avg([r.accuracyWhite, r.accuracyBlack]); }).filter((x): x is number => x !== undefined);
      return avg(v) ?? 0;
    };
    trend = { earlierAccuracy: acc(sorted.slice(0, half)), recentAccuracy: acc(sorted.slice(half)), n: sorted.length };
  }
  return {
    sufficientData: sufficient, gamesReviewed: complete.length, mistakesAnalysed: bad.length,
    byCategory: [...cat.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    byMotif: [...motif.entries()].map(([m, count]) => ({ motif: m, count })).sort((a, b) => b.count - a.count),
    byPhase: phases, recurring, recommendations: recs, trend,
  };
}

function avg(xs: (number | undefined)[]): number | undefined {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : undefined;
}

void PIECE_VALUE;
