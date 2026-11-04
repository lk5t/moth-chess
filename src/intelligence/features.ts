// Verified board features. Every value here is computed from the position — nothing is guessed.
import type { Color, PieceType, Square } from '@/types';
import {
  attackMap, attacksFrom, findPins, hangingPieces, idx, kingIndex, material, opposite, parseBoard, phaseOf, pieces, fileOf, rankOf, sqName,
  type Board, type HangingPiece, type Pin,
} from '@/chess/geometry';

export interface SideFeatures {
  material: number;
  developed: number; // minor pieces off their home squares
  undevelopedMinors: Square[];
  castled: boolean;
  canCastle: boolean;
  kingSquare: Square;
  pawnShield: number; // own pawns in front of the king (max 3)
  openFilesNearKing: number;
  kingAttackers: number; // enemy attacks on the king zone
  doubledPawns: number;
  isolatedPawns: number;
  passedPawns: Square[];
  centerControl: number; // attacks on d4,e4,d5,e5 + 1 per occupying pawn/piece
  hanging: HangingPiece[];
  pinnedPieces: Pin[];
  mobility: number; // geometric pseudo-mobility
  bishopPair: boolean;
  kingCentralization: number; // endgame king activity (0..6, higher = more central)
}

export interface PositionFeatures {
  fen: string;
  turn: Color;
  phase: 'opening' | 'middlegame' | 'endgame';
  w: SideFeatures;
  b: SideFeatures;
  materialDiff: number;
}

const CENTER = ['d4', 'e4', 'd5', 'e5'] as Square[];

function pawnFiles(b: Board, color: Color): number[] {
  const files = new Array(8).fill(0);
  b.sq.forEach((p, i) => { if (p?.type === 'p' && p.color === color) files[fileOf(i)]++; });
  return files;
}

function isPassed(b: Board, i: number, color: Color): boolean {
  const f = fileOf(i), r = rankOf(i);
  const enemy = opposite(color);
  for (let df = -1; df <= 1; df++) {
    const nf = f + df;
    if (nf < 0 || nf > 7) continue;
    for (let nr = 0; nr < 8; nr++) {
      const ahead = color === 'w' ? nr > r : nr < r;
      if (!ahead) continue;
      const p = b.sq[nr * 8 + nf];
      if (p?.type === 'p' && p.color === enemy) return false;
    }
  }
  return true;
}

function sideFeatures(b: Board, color: Color, phase: PositionFeatures['phase']): SideFeatures {
  const enemy = opposite(color);
  const myAtt = attackMap(b, color);
  const homeRank = color === 'w' ? '1' : '8';
  const minorsHome = (['b', 'g'].map((f) => ({ sq: `${f}${homeRank}` as Square, t: 'n' as PieceType }))
    .concat(['c', 'f'].map((f) => ({ sq: `${f}${homeRank}` as Square, t: 'b' as PieceType }))));
  const undevelopedMinors = minorsHome.filter(({ sq, t }) => { const p = b.sq[idx(sq)]; return p?.type === t && p.color === color; }).map((x) => x.sq);
  const minors = pieces(b, color).filter((p) => p.type === 'n' || p.type === 'b').length;
  const ki = kingIndex(b, color);
  const kingSquare = ki >= 0 ? sqName(ki) : ('e1' as Square);
  const kf = fileOf(ki), kr = rankOf(ki);
  const castled = ki >= 0 && rankOf(ki) === (color === 'w' ? 0 : 7) && (kf >= 6 || kf <= 2);
  const rights = color === 'w' ? /[KQ]/.test(b.castling) : /[kq]/.test(b.castling);
  const dir = color === 'w' ? 1 : -1;
  let shield = 0;
  for (let df = -1; df <= 1; df++) {
    for (const dr of [1, 2]) {
      const f = kf + df, r = kr + dir * dr;
      if (f < 0 || f > 7 || r < 0 || r > 7) continue;
      const p = b.sq[r * 8 + f];
      if (p?.type === 'p' && p.color === color) { shield++; break; }
    }
  }
  const myFiles = pawnFiles(b, color);
  let openNear = 0;
  for (let df = -1; df <= 1; df++) { const f = kf + df; if (f >= 0 && f <= 7 && myFiles[f] === 0) openNear++; }
  const enemyAtt = attackMap(b, enemy);
  let kingAttackers = 0;
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    const f = kf + df, r = kr + dr;
    if (f >= 0 && f <= 7 && r >= 0 && r <= 7) kingAttackers += enemyAtt[r * 8 + f];
  }
  const doubled = myFiles.reduce((s, n) => s + (n > 1 ? n - 1 : 0), 0);
  const isolated = myFiles.reduce((s, n, f) => s + (n > 0 && (f === 0 || myFiles[f - 1] === 0) && (f === 7 || myFiles[f + 1] === 0) ? n : 0), 0);
  const passed: Square[] = [];
  b.sq.forEach((p, i) => { if (p?.type === 'p' && p.color === color && isPassed(b, i, color)) passed.push(sqName(i)); });
  let center = 0;
  for (const s of CENTER) { center += myAtt[idx(s)]; const p = b.sq[idx(s)]; if (p && p.color === color) center += 1; }
  let mobility = 0;
  b.sq.forEach((p, i) => { if (p && p.color === color && p.type !== 'p' && p.type !== 'k') mobility += attackSquaresFree(b, i, color); });
  const bishops = pieces(b, color).filter((p) => p.type === 'b');
  const centralization = ki >= 0 ? 6 - (Math.max(3 - kf, kf - 4, 0) + Math.max(3 - kr, kr - 4, 0)) : 0;
  return {
    material: material(b)[color],
    developed: Math.max(0, minors - undevelopedMinors.length),
    undevelopedMinors,
    castled,
    canCastle: rights,
    kingSquare,
    pawnShield: shield,
    openFilesNearKing: openNear,
    kingAttackers,
    doubledPawns: doubled,
    isolatedPawns: isolated,
    passedPawns: passed,
    centerControl: center,
    hanging: hangingPieces(b, color),
    pinnedPieces: findPins(b, color),
    mobility,
    bishopPair: bishops.length >= 2 && new Set(bishops.map((x) => (fileOf(idx(x.square)) + rankOf(idx(x.square))) % 2)).size === 2,
    kingCentralization: phase === 'endgame' ? Math.max(0, centralization) : 0,
  };
}

/** Squares a piece attacks that are empty or enemy-occupied (pseudo-mobility). */
function attackSquaresFree(b: Board, i: number, color: Color): number {
  let n = 0;
  for (const t of attacksFrom(b, i)) { const q = b.sq[t]; if (!q || q.color !== color) n++; }
  return n;
}

export function computeFeatures(fen: string, ply?: number): PositionFeatures {
  const b = parseBoard(fen);
  const phase = phaseOf(b, ply);
  const w = sideFeatures(b, 'w', phase);
  const bl = sideFeatures(b, 'b', phase);
  return { fen, turn: b.turn, phase, w, b: bl, materialDiff: w.material - bl.material };
}
