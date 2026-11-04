// Deterministic board geometry: attack maps, rays, pins, material.
// Pure functions over a parsed FEN — used by Intelligence and Threat Vision.
// "Geometric" attacks ignore pins/legality on purpose; legality is checked via chess.js where it matters.
import type { Color, PieceType, Square } from '@/types';

export const FILES = 'abcdefgh';
export const PIECE_VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export interface BoardPiece { type: PieceType; color: Color; square: Square }

export interface Board {
  /** index 0 = a1, 7 = h1, 56 = a8 */
  sq: (null | { type: PieceType; color: Color })[];
  turn: Color;
  castling: string;
  ep: string;
}

export const idx = (s: Square): number => (Number(s[1]) - 1) * 8 + FILES.indexOf(s[0]);
export const sqName = (i: number): Square => `${FILES[i % 8]}${Math.floor(i / 8) + 1}` as Square;
export const fileOf = (i: number) => i % 8;
export const rankOf = (i: number) => Math.floor(i / 8);

export function parseBoard(fen: string): Board {
  const [placement, turn, castling = '-', ep = '-'] = fen.split(' ');
  const sq: Board['sq'] = new Array(64).fill(null);
  const rows = placement.split('/');
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const rank = 7 - r;
      sq[rank * 8 + f] = { type: ch.toLowerCase() as PieceType, color: ch === ch.toUpperCase() ? 'w' : 'b' };
      f++;
    }
  });
  return { sq, turn: turn === 'b' ? 'b' : 'w', castling, ep };
}

export function pieces(b: Board, color?: Color): BoardPiece[] {
  const out: BoardPiece[] = [];
  b.sq.forEach((p, i) => { if (p && (!color || p.color === color)) out.push({ ...p, square: sqName(i) }); });
  return out;
}

export const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

function onBoard(f: number, r: number) { return f >= 0 && f < 8 && r >= 0 && r < 8; }

/** Squares attacked by the piece on index i (geometric, including squares occupied by own pieces = "defended"). */
export function attacksFrom(b: Board, i: number): number[] {
  const p = b.sq[i];
  if (!p) return [];
  const f = fileOf(i), r = rankOf(i);
  const out: number[] = [];
  const add = (df: number, dr: number) => { if (onBoard(f + df, r + dr)) out.push((r + dr) * 8 + f + df); };
  const slide = (dirs: number[][]) => {
    for (const [df, dr] of dirs) {
      let nf = f + df, nr = r + dr;
      while (onBoard(nf, nr)) {
        const j = nr * 8 + nf;
        out.push(j);
        if (b.sq[j]) break;
        nf += df; nr += dr;
      }
    }
  };
  switch (p.type) {
    case 'p': { const d = p.color === 'w' ? 1 : -1; add(-1, d); add(1, d); break; }
    case 'n': KNIGHT.forEach(([a, c]) => add(a, c)); break;
    case 'k': KING.forEach(([a, c]) => add(a, c)); break;
    case 'b': slide(BISHOP_DIRS); break;
    case 'r': slide(ROOK_DIRS); break;
    case 'q': slide(BISHOP_DIRS); slide(ROOK_DIRS); break;
  }
  return out;
}

/** Indices of `color` pieces attacking square index `t`. */
export function attackersOf(b: Board, t: number, color: Color): number[] {
  const out: number[] = [];
  b.sq.forEach((p, i) => { if (p && p.color === color && attacksFrom(b, i).includes(t)) out.push(i); });
  return out;
}

/** Attack-count map per colour (64 entries). */
export function attackMap(b: Board, color: Color): number[] {
  const m = new Array(64).fill(0);
  b.sq.forEach((p, i) => { if (p && p.color === color) for (const t of attacksFrom(b, i)) m[t]++; });
  return m;
}

export function kingIndex(b: Board, color: Color): number {
  return b.sq.findIndex((p) => p?.type === 'k' && p.color === color);
}

export function material(b: Board): { w: number; b: number; diff: number; counts: Record<Color, Record<PieceType, number>> } {
  const counts: Record<Color, Record<PieceType, number>> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
  let w = 0, bl = 0;
  for (const p of b.sq) {
    if (!p) continue;
    counts[p.color][p.type]++;
    if (p.color === 'w') w += PIECE_VALUE[p.type]; else bl += PIECE_VALUE[p.type];
  }
  return { w, b: bl, diff: w - bl, counts };
}

export interface Pin { pinned: Square; pinner: Square; to: Square; absolute: boolean }

/**
 * Pins against the king (absolute) and against the queen/rook (relative):
 * a sliding enemy piece, then exactly one `color` piece, then the target of higher value.
 */
export function findPins(b: Board, color: Color): Pin[] {
  const out: Pin[] = [];
  const enemy = opposite(color);
  b.sq.forEach((p, i) => {
    if (!p || p.color !== enemy || !['b', 'r', 'q'].includes(p.type)) return;
    const dirs = p.type === 'b' ? BISHOP_DIRS : p.type === 'r' ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
    for (const [df, dr] of dirs) {
      let f = fileOf(i) + df, r = rankOf(i) + dr;
      let first = -1;
      while (onBoard(f, r)) {
        const j = r * 8 + f;
        const q = b.sq[j];
        if (q) {
          if (first < 0) {
            if (q.color !== color) break;
            first = j;
          } else {
            if (q.color === color) {
              const pinnedVal = PIECE_VALUE[b.sq[first]!.type];
              const behindVal = q.type === 'k' ? 100 : PIECE_VALUE[q.type];
              if (q.type === 'k' || behindVal > pinnedVal) out.push({ pinned: sqName(first), pinner: sqName(i), to: sqName(j), absolute: q.type === 'k' });
            }
            break;
          }
        }
        f += df; r += dr;
      }
    }
  });
  return out;
}

export interface Skewer { attacker: Square; front: Square; back: Square }

/** Skewers: a slider attacks a valuable `color` piece directly with a lesser `color` piece behind it on the same line. */
export function findSkewers(b: Board, color: Color): Skewer[] {
  const out: Skewer[] = [];
  const enemy = opposite(color);
  b.sq.forEach((p, i) => {
    if (!p || p.color !== enemy || !['b', 'r', 'q'].includes(p.type)) return;
    const dirs = p.type === 'b' ? BISHOP_DIRS : p.type === 'r' ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
    for (const [df, dr] of dirs) {
      let f = fileOf(i) + df, r = rankOf(i) + dr;
      let first = -1;
      while (onBoard(f, r)) {
        const j = r * 8 + f;
        const q = b.sq[j];
        if (q) {
          if (first < 0) { if (q.color !== color) break; first = j; }
          else {
            if (q.color === color) {
              const fp = b.sq[first]!;
              const fv = fp.type === 'k' ? 100 : PIECE_VALUE[fp.type];
              if (fv > PIECE_VALUE[q.type] && fv >= PIECE_VALUE[p.type]) out.push({ attacker: sqName(i), front: sqName(first), back: sqName(j) });
            }
            break;
          }
        }
        f += df; r += dr;
      }
    }
  });
  return out;
}

/**
 * Static exchange estimate on square t for `attackerColor` capturing first.
 * Returns material balance (in pawns) the attacker can expect; > 0 means the capture wins material.
 */
export function see(b: Board, t: number, attackerColor: Color): number {
  const target = b.sq[t];
  if (!target || target.color === attackerColor) return 0;
  const board: Board = { ...b, sq: b.sq.slice() };
  const gains: number[] = [];
  let side = attackerColor;
  let onSquare = PIECE_VALUE[target.type] || 100;
  let depth = 0;
  while (true) {
    const atk = attackersOf(board, t, side).sort((a, c) => (PIECE_VALUE[board.sq[a]!.type] || 100) - (PIECE_VALUE[board.sq[c]!.type] || 100));
    if (!atk.length) break;
    const from = atk[0];
    const mover = board.sq[from]!;
    gains[depth] = onSquare - (depth > 0 ? gains[depth - 1] : 0);
    onSquare = PIECE_VALUE[mover.type] || 100;
    board.sq[t] = mover;
    board.sq[from] = null;
    side = opposite(side);
    depth++;
    if (mover.type === 'k' && attackersOf(board, t, side).length) { depth--; break; } // king cannot capture into check
  }
  if (!depth) return 0;
  for (let d = depth - 1; d > 0; d--) gains[d - 1] = -Math.max(-gains[d - 1], gains[d]);
  return gains[0];
}

export interface HangingPiece { square: Square; type: PieceType; color: Color; reason: 'undefended' | 'attacked-by-lesser' | 'loses-exchange'; gain: number }

/** Pieces of `color` that the opponent can win by capture (SEE > 0). Kings excluded. */
export function hangingPieces(b: Board, color: Color): HangingPiece[] {
  const enemy = opposite(color);
  const out: HangingPiece[] = [];
  b.sq.forEach((p, i) => {
    if (!p || p.color !== color || p.type === 'k') return;
    const atk = attackersOf(b, i, enemy);
    if (!atk.length) return;
    const gain = see(b, i, enemy);
    if (gain <= 0) return;
    const def = attackersOf(b, i, color);
    const minAtk = Math.min(...atk.map((a) => PIECE_VALUE[b.sq[a]!.type] || 100));
    out.push({ square: sqName(i), type: p.type, color, gain, reason: !def.length ? 'undefended' : minAtk < PIECE_VALUE[p.type] ? 'attacked-by-lesser' : 'loses-exchange' });
  });
  return out;
}

export function undefendedPieces(b: Board, color: Color): Square[] {
  return pieces(b, color).filter((p) => p.type !== 'k' && attackersOf(b, idx(p.square), color).length === 0).map((p) => p.square);
}

/** Game phase from non-pawn material (excluding kings). */
export function phaseOf(b: Board, ply?: number): 'opening' | 'middlegame' | 'endgame' {
  const m = material(b);
  const npm = (['n', 'b', 'r', 'q'] as PieceType[]).reduce((s, t) => s + (m.counts.w[t] + m.counts.b[t]) * PIECE_VALUE[t], 0);
  if (npm <= 26) return 'endgame'; // e.g. ≤ R+B+N vs R+B each side… roughly queenless & reduced
  const undeveloped = (['b1', 'g1', 'c1', 'f1', 'b8', 'g8', 'c8', 'f8'] as Square[]).filter((s) => {
    const p = b.sq[idx(s)];
    return p && (p.type === 'n' || p.type === 'b') && p.color === (s[1] === '1' ? 'w' : 'b');
  }).length;
  if ((ply !== undefined && ply < 20 && undeveloped >= 2) || undeveloped >= 4) return 'opening';
  return 'middlegame';
}
