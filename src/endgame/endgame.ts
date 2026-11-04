// Endgame Intelligence (3.0): classification, exact KPK results, rule-based verdicts for basic mates and
// well-known theoretical positions, promotion races (rule of the square) and plain-language guidance.
// Coverage is deliberately limited and stated: only KPK is exact (local bitbase). Everything else is rules
// of thumb, labelled as such — MOTH does not ship Syzygy tablebases (they are gigabytes).
import { probeKPK } from './kpk';

type PT = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
interface Pc { t: PT; white: boolean; sq: number }
export type EndgameKind =
  | 'none' | 'pawn' | 'kpk' | 'basic-mate' | 'rook' | 'rook-pawn' | 'queen' | 'minor' | 'opposite-bishops' | 'bishop-knight-mate' | 'mixed';
export interface Verdict { result: 'win-white' | 'win-black' | 'draw' | 'unclear'; certainty: 'exact' | 'theory' | 'heuristic'; why: string }
export interface EndgameInfo {
  isEndgame: boolean;
  kind: EndgameKind;
  title: string;
  material: string;
  verdict?: Verdict;
  races: { pawn: string; white: boolean; movesToQueen: number; insideSquare: boolean; unstoppable: boolean }[];
  tips: string[];
}

const NAME = (s: number) => String.fromCharCode(97 + (s & 7)) + ((s >> 3) + 1);
const file = (s: number) => s & 7, rank = (s: number) => s >> 3;
const dist = (a: number, b: number) => Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)));
const VAL: Record<PT, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function parsePieces(fen: string): { pieces: Pc[]; whiteToMove: boolean } {
  const [place, stm] = fen.split(' ');
  const pieces: Pc[] = [];
  place.split('/').forEach((row, i) => {
    let fl = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { fl += Number(ch); continue; }
      pieces.push({ t: ch.toLowerCase() as PT, white: ch === ch.toUpperCase(), sq: (7 - i) * 8 + fl });
      fl++;
    }
  });
  return { pieces, whiteToMove: stm !== 'b' };
}

const sig = (ps: Pc[], white: boolean) => 'K' + ps.filter((p) => p.white === white && p.t !== 'k').map((p) => p.t.toUpperCase()).sort((a, b) => 'QRBNP'.indexOf(a) - 'QRBNP'.indexOf(b)).join('');

/** Promotion races: for each passed pawn, moves to promote and whether the enemy king is inside the square. */
function races(ps: Pc[], whiteToMove: boolean) {
  const out: EndgameInfo['races'] = [];
  const kings = { w: ps.find((p) => p.t === 'k' && p.white)!, b: ps.find((p) => p.t === 'k' && !p.white)! };
  const onlyPawns = ps.every((p) => p.t === 'k' || p.t === 'p');
  for (const p of ps.filter((x) => x.t === 'p')) {
    const dir = p.white ? 1 : -1;
    const blocked = ps.some((o) => o.t === 'p' && o.white !== p.white && Math.abs(file(o.sq) - file(p.sq)) <= 1 && (rank(o.sq) - rank(p.sq)) * dir > 0);
    if (blocked) continue; // not a passed pawn
    const promo = p.white ? 56 + file(p.sq) : file(p.sq);
    let moves = Math.abs(7 * (p.white ? 1 : 0) - rank(p.sq)) ;
    moves = p.white ? 7 - rank(p.sq) : rank(p.sq);
    if ((p.white && rank(p.sq) === 1) || (!p.white && rank(p.sq) === 6)) moves--; // double step
    const enemyK = p.white ? kings.b : kings.w;
    const enemyToMove = p.white ? !whiteToMove : whiteToMove;
    const kingDist = dist(enemyK.sq, promo) - (enemyToMove ? 1 : 0);
    const insideSquare = kingDist <= moves;
    const ownK = p.white ? kings.w : kings.b;
    const ownKingBlocks = file(ownK.sq) === file(p.sq) && (rank(ownK.sq) - rank(p.sq)) * dir > 0;
    out.push({ pawn: NAME(p.sq), white: p.white, movesToQueen: moves, insideSquare, unstoppable: onlyPawns && !insideSquare && !ownKingBlocks });
  }
  return out;
}

export function analyseEndgame(fen: string): EndgameInfo {
  const { pieces: ps, whiteToMove } = parsePieces(fen);
  const nonPawn = ps.filter((p) => p.t !== 'k' && p.t !== 'p');
  const matW = ps.filter((p) => p.white).reduce((a, p) => a + VAL[p.t], 0), matB = ps.filter((p) => !p.white).reduce((a, p) => a + VAL[p.t], 0);
  const queens = ps.filter((p) => p.t === 'q').length;
  const isEndgame = nonPawn.reduce((a, p) => a + VAL[p.t], 0) <= 13 || (queens === 0 && nonPawn.length <= 4);
  const material = `${sig(ps, true)} vs ${sig(ps, false)}`;
  const info: EndgameInfo = { isEndgame, kind: 'none', title: 'Not an endgame yet', material, races: races(ps, whiteToMove), tips: [] };
  if (!isEndgame) return info;
  const wk = ps.find((p) => p.t === 'k' && p.white)!.sq, bk = ps.find((p) => p.t === 'k' && !p.white)!.sq;
  const w = sig(ps, true), b = sig(ps, false);
  const pair = (x: string, y: string) => (w === x && b === y) || (w === y && b === x);
  const strongWhite = matW >= matB;

  if (pair('KP', 'K')) {
    const p = ps.find((x) => x.t === 'p')!;
    const res = probeKPK(wk, bk, p.sq, p.white, whiteToMove);
    info.kind = 'kpk'; info.title = 'King and pawn vs king';
    info.verdict = { result: res === 'draw' ? 'draw' : p.white ? 'win-white' : 'win-black', certainty: 'exact', why: res === 'draw' ? 'The defending king reaches the pawn\'s path in time (exact result from MOTH\'s local KPK table).' : 'The pawn promotes by force (exact result from MOTH\'s local KPK table).' };
    info.tips.push('Key squares: the attacking king two squares in front of the pawn (on the 5th rank or beyond, one in front) wins.', 'The opposition decides: with kings facing each other an odd number of squares apart, the side NOT to move holds the opposition.', 'A rook pawn (a/h file) is a draw if the defending king reaches the corner.');
  } else if (pair('KQ', 'K') || pair('KR', 'K') || pair('KQQ', 'K') || pair('KRR', 'K') || pair('KQR', 'K') || pair('KBB', 'K')) {
    info.kind = 'basic-mate'; info.title = 'Basic checkmate';
    info.verdict = { result: strongWhite ? 'win-white' : 'win-black', certainty: 'theory', why: 'A known forced win (unless the defending side can capture a piece or is stalemated right now).' };
    info.tips.push('Drive the king to the edge: restrict it with your piece, then bring your own king close.', 'Watch for stalemate — always leave the defending king a square until the mating move.');
  } else if (pair('KBN', 'K')) {
    info.kind = 'bishop-knight-mate'; info.title = 'Bishop and knight mate';
    info.verdict = { result: strongWhite ? 'win-white' : 'win-black', certainty: 'theory', why: 'Forced win, but only in a corner of the bishop\'s colour; it can take over 30 moves (watch the 50-move rule).' };
    info.tips.push('Drive the king to the corner the bishop controls (the "W manoeuvre" with the knight).');
  } else if (pair('KN', 'K') || pair('KB', 'K') || pair('KNN', 'K') || w === 'K' && b === 'K') {
    info.kind = 'basic-mate'; info.title = 'Insufficient mating material';
    info.verdict = { result: 'draw', certainty: 'theory', why: 'One minor piece (or two knights) cannot force checkmate.' };
  } else if (nonPawn.length === 0) {
    info.kind = 'pawn'; info.title = 'Pawn endgame';
    info.tips.push('King activity is everything: centralise your king first.', 'Count the races: use the rule of the square for passed pawns.', 'An outside passed pawn decoys the enemy king away.');
  } else if (nonPawn.every((p) => p.t === 'r') && nonPawn.length === 2 && nonPawn.filter((p) => p.white).length === 1) {
    const pawns = ps.filter((p) => p.t === 'p');
    info.kind = pawns.length === 1 ? 'rook-pawn' : 'rook'; info.title = pawns.length === 1 ? 'Rook and pawn vs rook' : 'Rook endgame';
    if (pawns.length === 1) {
      const p = pawns[0], defK = p.white ? bk : wk, attK = p.white ? wk : bk;
      const ahead = (rank(defK) - rank(p.sq)) * (p.white ? 1 : -1) > 0 && Math.abs(file(defK) - file(p.sq)) <= 1;
      const advanced = p.white ? rank(p.sq) >= 6 : rank(p.sq) <= 1;
      const attInFront = (rank(attK) - rank(p.sq)) * (p.white ? 1 : -1) > 0 && Math.abs(file(attK) - file(p.sq)) <= 1;
      if (ahead) info.verdict = { result: 'draw', certainty: 'heuristic', why: 'The defending king stands in front of the pawn — the Philidor defence (rook on the 6th rank, then checks from behind) should hold.' };
      else if (advanced && attInFront) info.verdict = { result: p.white ? 'win-white' : 'win-black', certainty: 'heuristic', why: 'Lucena-type position: the attacking king shelters in front of an advanced pawn — "build a bridge" with the rook to win.' };
      info.tips.push('Philidor: defending king in front of the pawn, rook on the third rank from the defender\'s side until the pawn advances, then check from behind.', 'Lucena: king in front of its pawn on the 7th, cut the enemy king off, then build a bridge with the rook on the 4th rank.');
    } else info.tips.push('Rooks belong behind passed pawns — yours and your opponent\'s.', 'Activate the rook before grabbing pawns; a passive rook loses.', 'Cut the enemy king off along a rank or file.');
  } else if (nonPawn.length === 2 && nonPawn.every((p) => p.t === 'b') && nonPawn[0].white !== nonPawn[1].white && ((file(nonPawn[0].sq) + rank(nonPawn[0].sq)) % 2) !== ((file(nonPawn[1].sq) + rank(nonPawn[1].sq)) % 2)) {
    info.kind = 'opposite-bishops'; info.title = 'Opposite-coloured bishops';
    if (Math.abs(ps.filter((p) => p.t === 'p' && p.white).length - ps.filter((p) => p.t === 'p' && !p.white).length) <= 2) info.verdict = { result: 'draw', certainty: 'heuristic', why: 'Opposite-coloured bishops are very drawish: the defender blockades on squares the attacking bishop cannot touch.' };
    info.tips.push('The defender blockades passed pawns on the colour of their own bishop.');
  } else if (nonPawn.every((p) => p.t === 'q')) {
    info.kind = 'queen'; info.title = 'Queen endgame';
    info.tips.push('Perpetual check is the main defensive resource — keep your king sheltered.', 'Centralise the queen; a passed pawn supported by the queen is decisive.');
  } else if (nonPawn.every((p) => p.t === 'n' || p.t === 'b')) {
    info.kind = 'minor'; info.title = 'Minor-piece endgame';
    info.tips.push('Bishops prefer open positions and pawns on both wings; knights prefer closed positions.', 'Put your pawns on the opposite colour to your own bishop.');
  } else { info.kind = 'mixed'; info.title = 'Endgame'; info.tips.push('Activate the king, create a passed pawn, trade pieces when ahead (not pawns).'); }

  const unstoppable = info.races.filter((x) => x.unstoppable);
  if (unstoppable.length && !info.verdict && nonPawn.length === 0) {
    const ws = unstoppable.filter((x) => x.white), bs = unstoppable.filter((x) => !x.white);
    const best = (xs: typeof unstoppable) => Math.min(...xs.map((x) => x.movesToQueen));
    if (ws.length && !bs.length) info.verdict = { result: 'win-white', certainty: 'heuristic', why: `White's ${ws[0].pawn} pawn is outside the black king's square and queens in ${ws[0].movesToQueen}.` };
    else if (bs.length && !ws.length) info.verdict = { result: 'win-black', certainty: 'heuristic', why: `Black's ${bs[0].pawn} pawn is outside the white king's square and queens in ${bs[0].movesToQueen}.` };
    else if (ws.length && bs.length) info.verdict = { result: 'unclear', certainty: 'heuristic', why: `Promotion race: White queens in ${best(ws)}, Black in ${best(bs)} — check whether the first new queen gives check or controls the other queening square.` };
  }
  return info;
}

/** Training positions with a stated goal; each is legal and its goal was checked with the engines (see tests). */
export const ENDGAME_DRILLS: { id: string; title: string; fen: string; goal: 'win' | 'draw'; side: 'w' | 'b'; hint: string; level: 1 | 2 | 3 }[] = [
  { id: 'kq-k', title: 'Queen mate', fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1', goal: 'win', side: 'w', hint: 'Box the king in with the queen a knight\'s move away, then bring your king.', level: 1 },
  { id: 'kr-k', title: 'Rook mate', fen: '8/8/8/4k3/8/8/8/R3K3 w - - 0 1', goal: 'win', side: 'w', hint: 'Cut the king off along a rank, use the opposition to push it back.', level: 1 },
  { id: 'kpk-opposition', title: 'Win with the opposition', fen: '8/8/3k4/8/3K4/8/3P4/8 w - - 0 1', goal: 'win', side: 'w', hint: 'Use a pawn tempo move (d3) to win the opposition, then outflank.', level: 2 },
  { id: 'kpk-draw', title: 'Hold the draw', fen: '8/8/8/8/3k4/8/3PK3/8 b - - 0 1', goal: 'draw', side: 'b', hint: 'Stay in front of the pawn and keep the opposition.', level: 2 },
  { id: 'square', title: 'Rule of the square', fen: '8/8/1k6/8/8/8/6P1/6K1 w - - 0 1', goal: 'win', side: 'w', hint: 'Can the king catch the pawn? Count the square.', level: 1 },
  { id: 'lucena', title: 'Lucena: build a bridge', fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1', goal: 'win', side: 'w', hint: 'Rook to the 4th rank first, then bring the king out and block checks with the rook.', level: 3 },
  { id: 'philidor', title: 'Philidor defence', fen: '4k3/r7/8/3PK3/8/8/8/7R b - - 0 1', goal: 'draw', side: 'b', hint: 'Keep the rook on the 6th rank until the pawn advances, then check from behind.', level: 3 },
  { id: 'breakthrough', title: 'Pawn breakthrough', fen: '8/ppp5/8/PPP5/8/8/8/k5K1 w - - 0 1', goal: 'win', side: 'w', hint: 'b6! creates a passed pawn by force.', level: 3 },
];
