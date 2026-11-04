// What-If Simulator: an isolated sandbox. It deep-copies the base position and never touches the source.
import type { MoveRecord, Square } from '@/types';
import { applyMove, buildPgn, validateFen } from '@/chess/position';
import { parseBoard, sqName } from '@/chess/geometry';

export interface SimState {
  readonly baseFen: string;
  readonly moves: readonly MoveRecord[];
  readonly cursor: number; // number of moves applied (supports stepping back)
}

export function createSim(fen: string): SimState {
  const v = validateFen(fen);
  if (!v.ok || !v.fen) throw new Error(v.error ?? 'Invalid FEN');
  return Object.freeze({ baseFen: v.fen, moves: Object.freeze([]) as readonly MoveRecord[], cursor: 0 });
}

export function currentFen(s: SimState): string {
  return s.cursor === 0 ? s.baseFen : s.moves[s.cursor - 1].fenAfter;
}

/** Play a move (either side, according to turn order). Truncates any "future" moves after the cursor. */
export function simMove(s: SimState, move: string | { from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' }): SimState | null {
  const r = applyMove(currentFen(s), move);
  if (!r) return null;
  const moves = [...s.moves.slice(0, s.cursor), r];
  return Object.freeze({ baseFen: s.baseFen, moves: Object.freeze(moves), cursor: moves.length });
}

export function simStep(s: SimState, delta: number): SimState {
  return Object.freeze({ ...s, cursor: Math.max(0, Math.min(s.moves.length, s.cursor + delta)) });
}

export function simReset(s: SimState): SimState {
  return createSim(s.baseFen);
}

/** Squares whose occupant differs between two positions (before/after highlight). */
export function diffSquares(fenA: string, fenB: string): Square[] {
  const a = parseBoard(fenA).sq, b = parseBoard(fenB).sq;
  const out: Square[] = [];
  for (let i = 0; i < 64; i++) {
    const x = a[i], y = b[i];
    if ((x?.type ?? '') + (x?.color ?? '') !== (y?.type ?? '') + (y?.color ?? '')) out.push(sqName(i));
  }
  return out;
}

export function simToPgn(s: SimState, title = 'MOTH What-If'): string {
  return buildPgn({ headers: { Event: title, Annotator: 'MOTH Chess What-If Simulator' }, startFen: s.baseFen, moves: s.moves.slice(0, s.cursor).map((m) => ({ san: m.san })) });
}

export function simUci(s: SimState): string[] {
  return s.moves.slice(0, s.cursor).map((m) => m.uci);
}
