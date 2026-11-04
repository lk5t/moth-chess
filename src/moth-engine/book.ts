// MOTH opening book: position-keyed (transpositions resolve to the same entry), engine-validated.
// Popularity is stored and displayed, but move *selection* is filtered by the engine evaluation first,
// so a popular-but-unsound move is never preferred over a sound one.
import type { StyleName } from './wasm.ts';

export type BookTag = 'main' | 'gambit' | 'trap' | 'refutation' | 'mistake' | 'aggressive' | 'solid' | 'named';

export interface BookMove {
  uci: string;
  san: string;
  /** human games that played this move from this position */
  games: number;
  /** score of those games for the side to move, 0..1 (only meaningful when games is large) */
  score: number;
  /** engine evaluation after the move, centipawns, from the side-to-move's perspective before the move */
  eval: number;
  /** depth of the validating search */
  depth: number;
  tags: BookTag[];
  /** opening name reached by this move, if any */
  name?: string;
  eco?: string;
}

export interface BookPosition { moves: BookMove[]; name?: string; eco?: string }

export interface OpeningBook {
  format: 'moth-book-1';
  built: string;
  sources: string[];
  validation: { engine: string; depth: number };
  positions: Record<string, BookPosition>;
  stats: { positions: number; moves: number; named: number; gambits: number; traps: number; mistakes: number; humanGames: number };
}

/** Book key: the first four FEN fields (placement, side, castling, e.p.) of an engine-canonical FEN. */
export function bookKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

const SOUND_MARGIN: Record<StyleName, number> = { aggressive: 45, balanced: 25, defensive: 35 };

/**
 * Pick a book move for a style. Candidates are the engine-sound moves (within the style's margin of
 * the best evaluated book move and not worse than -60 cp absolute); style tags and popularity only
 * order the sound candidates. `random` (0..1) adds variety; pass a seeded generator for reproducibility.
 * `prefer` lets personal adaptation favour certain moves (e.g. lines the user scores badly against).
 */
export function chooseBookMove(pos: BookPosition | undefined, style: StyleName, random: () => number = Math.random, prefer?: (m: BookMove) => number): BookMove | null {
  if (!pos || !pos.moves.length) return null;
  const sound = pos.moves.filter((m) => !m.tags.includes('mistake') && m.depth > 0);
  if (!sound.length) return null;
  const best = Math.max(...sound.map((m) => m.eval));
  const margin = SOUND_MARGIN[style];
  const cands = sound.filter((m) => m.eval >= best - margin && m.eval >= -60);
  if (!cands.length) return null;
  const weight = (m: BookMove) => {
    let w = 1 + Math.log2(1 + m.games) * 0.6 + (m.eval - best + margin) / 25;
    if (m.tags.includes('main')) w += 1;
    if (style === 'aggressive') { if (m.tags.includes('gambit')) w += 2.5; if (m.tags.includes('aggressive')) w += 1.5; if (m.tags.includes('solid')) w -= 0.5; }
    if (style === 'defensive') { if (m.tags.includes('solid')) w += 2; if (m.tags.includes('gambit')) w -= 1.5; }
    if (style === 'balanced') w += (m.eval - best) / 15;
    if (prefer) w += prefer(m);
    return Math.max(0.05, w);
  };
  const ws = cands.map(weight);
  const total = ws.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < cands.length; i++) { r -= ws[i]; if (r <= 0) return cands[i]; }
  return cands[cands.length - 1];
}

export function lookup(book: OpeningBook | null, fen: string): BookPosition | undefined {
  return book?.positions[bookKey(fen)];
}
