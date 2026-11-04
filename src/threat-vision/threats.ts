// Threat Vision: layered threat analysis.
// Every item carries `kind: 'geometric' | 'engine-validated'` so the UI can distinguish
// simple attack geometry from tactics the engine actually confirms.
import type { Color, EngineResult, PieceType, Square } from '@/types';
import {
  attackMap, attacksFrom, attackersOf, findPins, findSkewers, hangingPieces, idx, kingIndex, opposite, parseBoard, PIECE_VALUE, sqName, see, undefendedPieces,
  type HangingPiece, type Pin, type Skewer,
} from '@/chess/geometry';
import { legalMoves, flipTurn, validateFen } from '@/chess/position';
import { toCp } from '@/engine/normalize';

export type ThreatKind = 'geometric' | 'engine-validated';

export interface CheckThreat { uci: string; san: string; by: PieceType; mate: boolean; kind: ThreatKind }
export interface ForkThreat { uci: string; san: string; square: Square; piece: PieceType; targets: Square[]; kind: ThreatKind }
export interface MaterialThreat { uci: string; san: string; target: Square; gain: number; kind: ThreatKind }
export interface KingWarning { color: Color; message: string; squares: Square[] }
export interface Defence { uci: string; san: string; reason: string }

export interface ThreatReport {
  fen: string;
  turn: Color;
  inCheck: boolean;
  attacked: Record<Color, { square: Square; count: number }[]>;
  undefended: Record<Color, Square[]>;
  hanging: HangingPiece[];
  checks: CheckThreat[];
  pins: (Pin & { color: Color })[];
  forks: ForkThreat[];
  /** Forks the opponent would have if it were their move (null-move view). */
  opponentForks: ForkThreat[];
  skewers: (Skewer & { color: Color })[];
  kingWarnings: KingWarning[];
  materialThreats: MaterialThreat[];
  opponentMaterialThreats: MaterialThreat[];
  defences: Defence[];
}

function engineMoves(result?: EngineResult | null, fen?: string, toleranceCp = 60): Set<string> {
  const s = new Set<string>();
  if (!result || result.fen !== fen || !result.lines.length) return s;
  const best = toCp(result.lines[0].score);
  for (const l of result.lines) if (l.pv[0] && best - toCp(l.score) <= toleranceCp) s.add(l.pv[0]);
  return s;
}

function forksFor(fen: string, validated: Set<string>): ForkThreat[] {
  const out: ForkThreat[] = [];
  for (const m of legalMoves(fen)) {
    const b = parseBoard(m.fenAfter);
    const to = idx(m.to);
    const mover = b.sq[to];
    if (!mover) continue;
    const moverVal = PIECE_VALUE[mover.type] || 100;
    const enemy = opposite(mover.color);
    const targets: Square[] = [];
    for (const t of attacksFrom(b, to)) {
      const q = b.sq[t];
      if (!q || q.color !== enemy) continue;
      const v = q.type === 'k' ? 100 : PIECE_VALUE[q.type];
      const defended = attackersOf(b, t, enemy).length > 0;
      if (q.type === 'k' || v > moverVal || (!defended && v >= 3)) targets.push(sqName(t));
    }
    if (targets.length < 2) continue;
    // a "fork" by a piece that is simply lost for nothing is not a fork
    const loss = see(b, to, enemy);
    if (loss >= moverVal && !targets.some((t) => b.sq[idx(t)]?.type === 'k')) continue;
    out.push({ uci: m.uci, san: m.san, square: m.to, piece: mover.type, targets, kind: validated.has(m.uci) ? 'engine-validated' : 'geometric' });
  }
  return out;
}

function materialThreatsFor(fen: string, validated: Set<string>): MaterialThreat[] {
  const b = parseBoard(fen);
  const out: MaterialThreat[] = [];
  for (const m of legalMoves(fen)) {
    if (!m.captured) continue;
    const g = see(b, idx(m.to), m.color);
    if (g > 0) out.push({ uci: m.uci, san: m.san, target: m.to, gain: g, kind: validated.has(m.uci) ? 'engine-validated' : 'geometric' });
  }
  return out.sort((a, c) => c.gain - a.gain);
}

export function analyseThreats(fen: string, engine?: EngineResult | null): ThreatReport {
  const v = validateFen(fen);
  if (!v.ok || !v.fen) throw new Error(v.error ?? 'Invalid FEN');
  fen = v.fen;
  const b = parseBoard(fen);
  const turn = b.turn;
  const enemy = opposite(turn);
  const validated = engineMoves(engine, fen);
  const legal = legalMoves(fen);
  const inCheck = kingIndex(b, turn) >= 0 && attackersOf(b, kingIndex(b, turn), enemy).length > 0;

  const attacked = { w: [] as { square: Square; count: number }[], b: [] as { square: Square; count: number }[] };
  for (const c of ['w', 'b'] as Color[]) {
    attackMap(b, c).forEach((n, i) => { if (n > 0) attacked[c].push({ square: sqName(i), count: n }); });
  }

  const checks: CheckThreat[] = legal
    .filter((m) => m.san.includes('+') || m.san.includes('#'))
    .map((m) => ({ uci: m.uci, san: m.san, by: m.piece, mate: m.san.includes('#'), kind: validated.has(m.uci) || m.san.includes('#') ? 'engine-validated' as ThreatKind : 'geometric' as ThreatKind }));
  // Mate is proven by the rules engine itself (chess.js), so '#' moves count as validated.

  const pins = [...findPins(b, 'w').map((p) => ({ ...p, color: 'w' as Color })), ...findPins(b, 'b').map((p) => ({ ...p, color: 'b' as Color }))];
  const skewers = [...findSkewers(b, 'w').map((s) => ({ ...s, color: 'w' as Color })), ...findSkewers(b, 'b').map((s) => ({ ...s, color: 'b' as Color }))];
  const hanging = [...hangingPieces(b, 'w'), ...hangingPieces(b, 'b')];

  const forks = forksFor(fen, validated);
  const nullFen = inCheck ? null : flipTurn(fen);
  const nullOk = nullFen ? validateFen(nullFen).ok : false;
  const opponentForks = nullFen && nullOk ? forksFor(nullFen, new Set()) : [];
  const materialThreats = materialThreatsFor(fen, validated);
  const opponentMaterialThreats = nullFen && nullOk ? materialThreatsFor(nullFen, new Set()) : [];

  const kingWarnings: KingWarning[] = [];
  for (const c of ['w', 'b'] as Color[]) {
    const ki = kingIndex(b, c);
    if (ki < 0) continue;
    const att = attackMap(b, opposite(c));
    const zone: Square[] = [];
    const kf = ki % 8, kr = Math.floor(ki / 8);
    for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
      const f = kf + df, r = kr + dr;
      if (f < 0 || f > 7 || r < 0 || r > 7) continue;
      if (att[r * 8 + f] > 0) zone.push(sqName(r * 8 + f));
    }
    const name = c === 'w' ? 'White' : 'Black';
    if (att[ki] > 0) kingWarnings.push({ color: c, message: `${name} king is in check`, squares: [sqName(ki)] });
    else if (zone.length >= 4) kingWarnings.push({ color: c, message: `${name} king zone is under heavy fire (${zone.length} attacked squares)`, squares: zone });
    else if (zone.length >= 2 && attackersOf(b, ki, opposite(c)).length === 0) {
      const flight = zone.length;
      if (flight >= 3) kingWarnings.push({ color: c, message: `${name} king has several attacked squares around it`, squares: zone });
    }
  }

  // Defensive responses for the side to move: legal moves that reduce what the opponent can win.
  const defences: Defence[] = [];
  const myHanging = hangingPieces(b, turn);
  if (inCheck) {
    for (const m of legal) defences.push({ uci: m.uci, san: m.san, reason: 'escapes check' });
  } else if (myHanging.length) {
    const before = myHanging.reduce((s, h) => s + h.gain, 0);
    for (const m of legal) {
      const after = parseBoard(m.fenAfter);
      const nowHanging = hangingPieces(after, turn).reduce((s, h) => s + h.gain, 0);
      const capturedVal = m.captured ? PIECE_VALUE[m.captured] : 0;
      if (nowHanging < before || capturedVal >= before) {
        defences.push({ uci: m.uci, san: m.san, reason: capturedVal >= before ? 'counter-captures material' : nowHanging === 0 ? 'removes every hanging piece' : 'reduces material at risk' });
      }
    }
  }

  return {
    fen, turn, inCheck, attacked,
    undefended: { w: undefendedPieces(b, 'w'), b: undefendedPieces(b, 'b') },
    hanging, checks, pins, forks, opponentForks, skewers, kingWarnings, materialThreats, opponentMaterialThreats,
    defences: defences.slice(0, 12),
  };
}
