// Evaluation normalisation.
// UCI scores are from the side-to-move's perspective. MOTH always stores and displays
// White-perspective scores (labelled as such in the UI); helpers convert when the mover's view is needed.
import type { Color, EngineScore, WhiteScore } from '@/types';

export function toWhite(score: EngineScore, turn: Color): WhiteScore {
  if (score.type === 'mate' && score.value === 0) return { type: 'mate', value: 0, perspective: 'white', winner: turn === 'w' ? 'b' : 'w' };
  const sign = turn === 'w' ? 1 : -1;
  return { type: score.type, value: score.value * sign, perspective: 'white' };
}

export function forColor(score: WhiteScore, color: Color): EngineScore {
  return { type: score.type, value: color === 'w' ? score.value : -score.value };
}

/**
 * Centipawn-equivalent for comparisons/graphs. Mates map to ±(10000 - 10·moves).
 * For raw (side-to-move) scores `mate 0` means the mover is mated; White scores carry `winner`.
 */
export function toCp(score: { type: 'cp' | 'mate'; value: number; winner?: Color }): number {
  if (score.type === 'cp') return score.value;
  if (score.value === 0) return score.winner ? (score.winner === 'w' ? 10000 : -10000) : -10000;
  return Math.sign(score.value) * (10000 - Math.abs(score.value) * 10);
}

/**
 * Win probability (0–100) for White from a White-perspective score, using the logistic model
 * published by Lichess (open source). This is an *estimate*, not a site-equivalent metric.
 */
export function winPercent(score: WhiteScore | { type: 'cp' | 'mate'; value: number; winner?: Color }): number {
  if (score.type === 'mate') {
    if (score.value === 0) return score.winner === 'w' ? 100 : 0;
    return score.value > 0 ? 100 : 0;
  }
  const cp = Math.max(-1000, Math.min(1000, score.value));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function moverWinPercent(score: WhiteScore, mover: Color): number {
  const w = winPercent(score);
  return mover === 'w' ? w : 100 - w;
}

/** Per-move accuracy from win% drop (Lichess open-source formula). */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  const drop = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export function formatScore(score: WhiteScore | undefined | null, opts: { perspective?: Color } = {}): string {
  if (!score) return '…';
  const v = opts.perspective === 'b' ? -score.value : score.value;
  if (score.type === 'mate') {
    if (v === 0) return score.winner === 'w' ? '1-0 #' : score.winner === 'b' ? '0-1 #' : '#';
    return `${v > 0 ? '+' : '-'}M${Math.abs(v)}`;
  }
  const pawns = v / 100;
  return `${pawns > 0 ? '+' : pawns < 0 ? '−' : ''}${Math.abs(pawns).toFixed(2)}`;
}

/** Fraction (0..1) of the evaluation bar filled for White. */
export function evalBarFraction(score: WhiteScore | undefined | null): number {
  if (!score) return 0.5;
  return winPercent(score) / 100;
}

export function describeScore(score: WhiteScore): string {
  if (score.type === 'mate') {
    if (score.value === 0) return `Checkmate — ${score.winner === 'w' ? 'White' : 'Black'} has won`;
    return `${score.value > 0 ? 'White' : 'Black'} mates in ${Math.abs(score.value)}`;
  }
  const a = Math.abs(score.value);
  const side = score.value > 0 ? 'White' : 'Black';
  if (a < 30) return 'Roughly equal';
  if (a < 80) return `${side} is slightly better`;
  if (a < 200) return `${side} is clearly better`;
  if (a < 500) return `${side} is winning`;
  return `${side} is completely winning`;
}
