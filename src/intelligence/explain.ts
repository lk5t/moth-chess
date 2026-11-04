// MOTH Intelligence: explainable analysis above Stockfish.
// Stockfish supplies evaluations and best lines only. All natural-language reasoning here is
// produced by deterministic heuristics over verified board features, and every insight is tagged
// with its source so the UI never presents a heuristic as an engine-proven fact.
import type { Color, EngineLine, EngineResult, Square } from '@/types';
import { computeFeatures, type PositionFeatures, type SideFeatures } from './features';
import { analyseThreats, type ThreatReport } from '@/threat-vision/threats';
import { applyMove, gameStatus, validateFen } from '@/chess/position';
import { describeScore, formatScore, toCp } from '@/engine/normalize';
import { opposite, parseBoard, see, idx } from '@/chess/geometry';
import type { DetailLevel } from '@/settings/schema';

export type InsightSource = 'engine' | 'heuristic' | 'rules';
export type InsightCategory = 'summary' | 'material' | 'development' | 'king-safety' | 'pawn-structure' | 'center' | 'hanging' | 'tactics' | 'endgame' | 'comparison';

export interface Insight { text: string; source: InsightSource; category: InsightCategory; weight: number }

export interface CandidateExplanation {
  rank: number;
  uci: string;
  san: string;
  evalText: string;
  deltaFromBestCp: number;
  engineDepth: number;
  reasons: Insight[];
}

export interface IntelligenceReport {
  fen: string;
  phase: PositionFeatures['phase'];
  features: PositionFeatures;
  threats: ThreatReport;
  insights: Insight[];
  candidates: CandidateExplanation[];
  summary: string;
}

const NAME: Record<Color, string> = { w: 'White', b: 'Black' };
const PNAME: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

function sideInsights(f: PositionFeatures, c: Color): Insight[] {
  const s: SideFeatures = f[c];
  const o: SideFeatures = f[opposite(c)];
  const n = NAME[c];
  const out: Insight[] = [];
  if (f.phase !== 'endgame') {
    if (s.undevelopedMinors.length >= 2 && f.phase === 'opening')
      out.push({ text: `${n} still has ${s.undevelopedMinors.length} minor pieces on their starting squares (${s.undevelopedMinors.join(', ')}).`, source: 'heuristic', category: 'development', weight: 2 });
    if (!s.castled && !s.canCastle && f.phase !== 'opening' && ['d', 'e'].includes(s.kingSquare[0]))
      out.push({ text: `${n}'s king is stuck in the centre without castling rights.`, source: 'heuristic', category: 'king-safety', weight: 3 });
    else if (!s.castled && s.canCastle && f.phase === 'opening' && s.undevelopedMinors.length <= 1)
      out.push({ text: `${n} has developed enough to consider castling.`, source: 'heuristic', category: 'king-safety', weight: 1 });
    if (s.castled && s.pawnShield <= 1)
      out.push({ text: `${n}'s castled king has a thin pawn shield (${s.pawnShield} pawn${s.pawnShield === 1 ? '' : 's'}).`, source: 'heuristic', category: 'king-safety', weight: 2 });
    if (s.kingAttackers >= 5)
      out.push({ text: `${n}'s king zone is attacked ${s.kingAttackers} times.`, source: 'heuristic', category: 'king-safety', weight: 3 });
    if (s.centerControl - o.centerControl >= 3)
      out.push({ text: `${n} controls the centre more firmly (${s.centerControl} vs ${o.centerControl} on d4/e4/d5/e5).`, source: 'heuristic', category: 'center', weight: 1.5 });
  }
  if (s.doubledPawns) out.push({ text: `${n} has ${s.doubledPawns} doubled pawn${s.doubledPawns > 1 ? 's' : ''}.`, source: 'heuristic', category: 'pawn-structure', weight: 1 });
  if (s.isolatedPawns) out.push({ text: `${n} has ${s.isolatedPawns} isolated pawn${s.isolatedPawns > 1 ? 's' : ''}.`, source: 'heuristic', category: 'pawn-structure', weight: 1 });
  if (s.passedPawns.length) out.push({ text: `${n} has a passed pawn on ${s.passedPawns.join(', ')}.`, source: 'heuristic', category: 'pawn-structure', weight: f.phase === 'endgame' ? 3 : 1.5 });
  if (s.bishopPair && !o.bishopPair) out.push({ text: `${n} has the bishop pair.`, source: 'heuristic', category: 'material', weight: 0.8 });
  for (const h of s.hanging)
    out.push({ text: `${n}'s ${PNAME[h.type]} on ${h.square} can be won (${h.reason.replace(/-/g, ' ')}, about ${h.gain} pawn${h.gain === 1 ? '' : 's'}).`, source: 'heuristic', category: 'hanging', weight: 4 });
  for (const p of s.pinnedPieces)
    out.push({ text: `${n}'s piece on ${p.pinned} is ${p.absolute ? 'pinned to the king' : `pinned against ${p.to}`} by ${p.pinner}.`, source: 'heuristic', category: 'tactics', weight: p.absolute ? 2.5 : 1.5 });
  return out;
}

function endgameInsights(f: PositionFeatures): Insight[] {
  if (f.phase !== 'endgame') return [];
  const out: Insight[] = [];
  out.push({ text: 'Endgame principle: activate the king — it is a strong piece once queens are reduced.', source: 'heuristic', category: 'endgame', weight: 1 });
  for (const c of ['w', 'b'] as Color[]) {
    const s = f[c], o = f[opposite(c)];
    if (s.kingCentralization - o.kingCentralization >= 2) out.push({ text: `${NAME[c]}'s king is noticeably more active.`, source: 'heuristic', category: 'endgame', weight: 1.5 });
    if (s.passedPawns.length) out.push({ text: `Endgame principle: ${NAME[c]} should push the passed pawn with king support; rooks belong behind passed pawns.`, source: 'heuristic', category: 'endgame', weight: 1.2 });
  }
  const b = parseBoard(f.fen);
  const nonPawn = b.sq.filter((p) => p && p.type !== 'p' && p.type !== 'k').length;
  if (nonPawn === 0) out.push({ text: 'Pure king-and-pawn ending: opposition and key squares decide the result.', source: 'heuristic', category: 'endgame', weight: 2 });
  return out;
}

function moveReasons(fen: string, line: EngineLine, before: PositionFeatures, threats: ThreatReport): Insight[] {
  const uci = line.pv[0];
  const rec = applyMove(fen, uci);
  if (!rec) return [];
  const mover = rec.color;
  const after = computeFeatures(rec.fenAfter);
  const s0 = before[mover], s1 = after[mover];
  const o0 = before[opposite(mover)], o1 = after[opposite(mover)];
  const r: Insight[] = [];
  const add = (text: string, category: InsightCategory, weight: number, source: InsightSource = 'heuristic') => r.push({ text, category, weight, source });

  if (rec.san.includes('#')) add('Delivers checkmate.', 'tactics', 10, 'rules');
  else if (rec.san.includes('+')) add('Gives check, forcing a reply.', 'tactics', 1.5, 'rules');
  if (rec.captured) {
    const g = see(parseBoard(fen), idx(rec.to), mover);
    if (g > 0) add(`Wins material: captures the ${PNAME[rec.captured]} on ${rec.to} (static exchange ≈ +${g}).`, 'material', 4);
    else if (g === 0) add(`Trades on ${rec.to}.`, 'material', 1);
    else add(`Gives up material on ${rec.to} (static exchange ≈ ${g}) — the engine sees compensation.`, 'material', 3);
  }
  if (rec.promotion) add(`Promotes to a ${PNAME[rec.promotion]}.`, 'material', 6, 'rules');
  if (rec.san.startsWith('O-O')) add(rec.san === 'O-O' ? 'Castles kingside, tucking the king away and connecting the rooks.' : 'Castles queenside, activating the rook on the d-file.', 'king-safety', 3);
  if (s1.developed > s0.developed) add(`Develops a ${PNAME[rec.piece]} toward the centre.`, 'development', 2);
  const dc = s1.centerControl - s0.centerControl;
  if (dc >= 2) add(`Improves centre control (+${dc}).`, 'center', 1.5);
  if (s1.passedPawns.length > s0.passedPawns.length) add('Creates a passed pawn.', 'pawn-structure', 2);
  if (o1.passedPawns.length < o0.passedPawns.length) add("Removes or blocks the opponent's passed pawn.", 'pawn-structure', 2);
  if (s1.doubledPawns > s0.doubledPawns) add('Accepts doubled pawns.', 'pawn-structure', 1);
  if (s1.isolatedPawns > s0.isolatedPawns) add('Leaves an isolated pawn.', 'pawn-structure', 1);
  if (s1.pawnShield < s0.pawnShield && s1.castled) add("Weakens the king's pawn shield.", 'king-safety', 1.5);
  const hang0 = s0.hanging.reduce((a, h) => a + h.gain, 0);
  const hang1 = s1.hanging.reduce((a, h) => a + h.gain, 0);
  if (hang0 > 0 && hang1 < hang0) add(hang1 === 0 ? 'Saves the piece that was en prise.' : 'Reduces the material left hanging.', 'hanging', 3);
  if (hang1 > hang0) add(`Leaves material loose (≈${hang1 - hang0} pawn${hang1 - hang0 === 1 ? '' : 's'} attackable) — the engine judges it acceptable.`, 'hanging', 2);
  const oh1 = o1.hanging.reduce((a, h) => a + h.gain, 0);
  const oh0 = o0.hanging.reduce((a, h) => a + h.gain, 0);
  if (oh1 > oh0) add(`Creates a threat against ${o1.hanging.map((h) => `the ${PNAME[h.type]} on ${h.square}`).join(' and ')}.`, 'tactics', 3);
  const fork = threats.forks.find((f) => f.uci === uci);
  if (fork) add(`Forks ${fork.targets.join(' and ')} with the ${PNAME[fork.piece]}.`, 'tactics', 4, fork.kind === 'engine-validated' ? 'engine' : 'heuristic');
  if (o1.pinnedPieces.length > o0.pinnedPieces.length) add(`Pins the piece on ${o1.pinnedPieces[o1.pinnedPieces.length - 1].pinned}.`, 'tactics', 2);
  if (s1.pinnedPieces.length < s0.pinnedPieces.length) add('Breaks a pin.', 'tactics', 1.5);
  if (after.phase === 'endgame' && rec.piece === 'k' && s1.kingCentralization > s0.kingCentralization) add('Activates the king, following endgame principles.', 'endgame', 2);
  if (!r.length) add('A quiet improving move; no single feature dominates — the engine prefers it on deeper calculation.', 'summary', 0.5);
  return r.sort((a, b) => b.weight - a.weight);
}

export interface ExplainOptions { detail?: DetailLevel; ply?: number }

export function explainPosition(fenIn: string, engine?: EngineResult | null, opts: ExplainOptions = {}): IntelligenceReport {
  const v = validateFen(fenIn);
  if (!v.ok || !v.fen) throw new Error(v.error ?? 'Invalid FEN');
  const fen = v.fen;
  const features = computeFeatures(fen, opts.ply);
  const threats = analyseThreats(fen, engine);
  const status = gameStatus(fen);
  const insights: Insight[] = [];

  if (status.over) {
    insights.push({ text: status.checkmate ? `Checkmate — ${NAME[status.winner!]} wins.` : `Game drawn (${status.reason?.replace(/-/g, ' ')}).`, source: 'rules', category: 'summary', weight: 10 });
  }
  const md = features.materialDiff;
  insights.push({
    text: md === 0 ? 'Material is level.' : `${md > 0 ? 'White' : 'Black'} is ahead by ${Math.abs(md)} point${Math.abs(md) === 1 ? '' : 's'} of material.`,
    source: 'heuristic', category: 'material', weight: md === 0 ? 0.5 : 2,
  });
  insights.push(...sideInsights(features, 'w'), ...sideInsights(features, 'b'), ...endgameInsights(features));
  if (threats.inCheck) insights.push({ text: `${NAME[features.turn]} is in check and must respond.`, source: 'rules', category: 'tactics', weight: 5 });
  const mates = threats.checks.filter((c) => c.mate);
  if (mates.length) insights.push({ text: `${NAME[features.turn]} has mate in one: ${mates.map((m) => m.san).join(', ')}.`, source: 'rules', category: 'tactics', weight: 10 });

  const engineOk = engine && engine.fen === fen && engine.lines.length > 0;
  const candidates: CandidateExplanation[] = [];
  if (engineOk) {
    const top = engine!.lines[0];
    insights.unshift({ text: `${describeScore(top.whiteScore)} (Stockfish ${formatScore(top.whiteScore)} at depth ${top.depth}, White's perspective).`, source: 'engine', category: 'summary', weight: 9 });
    const bestCp = toCp(top.score);
    engine!.lines.forEach((l, i) => {
      if (!l.pv[0]) return;
      const delta = bestCp - toCp(l.score);
      const reasons = moveReasons(fen, l, features, threats);
      if (i > 0) {
        reasons.push({
          text: delta <= 15 ? `Practically equal to ${top.pvSan[0]} according to the engine.` : `The engine rates it ${(delta / 100).toFixed(2)} pawns worse than ${top.pvSan[0]} (depth ${l.depth}).`,
          source: 'engine', category: 'comparison', weight: 2,
        });
      } else if (l.pvSan.length > 1) {
        reasons.push({ text: `Main line: ${l.pvSan.slice(0, 6).join(' ')}.`, source: 'engine', category: 'comparison', weight: 1 });
      }
      candidates.push({ rank: i + 1, uci: l.pv[0], san: l.pvSan[0] ?? l.pv[0], evalText: formatScore(l.whiteScore), deltaFromBestCp: delta, engineDepth: l.depth, reasons });
    });
  }

  const detail = opts.detail ?? 'standard';
  const limit = detail === 'brief' ? 3 : detail === 'standard' ? 7 : 50;
  const sorted = insights.sort((a, b) => b.weight - a.weight);
  const reasonLimit = detail === 'brief' ? 2 : detail === 'standard' ? 4 : 10;
  candidates.forEach((c) => (c.reasons = c.reasons.slice(0, reasonLimit)));

  return { fen, phase: features.phase, features, threats, insights: sorted.slice(0, limit), candidates, summary: buildSummary(features, candidates, sorted) };
}

function buildSummary(f: PositionFeatures, cands: CandidateExplanation[], insights: Insight[]): string {
  const parts: string[] = [];
  const phase = f.phase === 'opening' ? 'An opening position' : f.phase === 'middlegame' ? 'A middlegame position' : 'An endgame';
  parts.push(`${phase} with ${NAME[f.turn]} to move.`);
  const top = cands[0];
  if (top) {
    const why = top.reasons.filter((r) => r.category !== 'comparison').slice(0, 2).map((r) => lowerFirst(r.text.replace(/\.$/, '')));
    parts.push(`${top.san} is the engine's choice${why.length ? ` — it ${why.join(' and ')}` : ''}.`);
    const alt = cands[1];
    if (alt && alt.deltaFromBestCp > 50) {
      const altWhy = alt.reasons.find((r) => r.category !== 'comparison' && r.category !== 'summary');
      parts.push(`The alternative ${alt.san} ${altWhy ? lowerFirst(altWhy.text.replace(/\.$/, '')) + ', but it' : ''} is about ${(alt.deltaFromBestCp / 100).toFixed(1)} pawns worse.`.replace(/\s+/g, ' '));
    }
  } else {
    const key = insights.find((i) => i.category !== 'material' && i.source !== 'engine');
    if (key) parts.push(key.text);
  }
  return parts.join(' ');
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------- Pluggable explanation providers (optional local LLM later) ----------

export interface ExplanationProvider {
  id: string;
  label: string;
  /** Must not be required: the heuristic provider is always available. */
  available(): Promise<boolean>;
  explain(report: IntelligenceReport): Promise<string>;
}

export const heuristicProvider: ExplanationProvider = {
  id: 'heuristic',
  label: 'MOTH heuristics (built-in)',
  available: async () => true,
  explain: async (r) => r.summary,
};

const providers = new Map<string, ExplanationProvider>([[heuristicProvider.id, heuristicProvider]]);
export function registerProvider(p: ExplanationProvider) { providers.set(p.id, p); }
export function listProviders() { return [...providers.values()]; }

export function squaresOf(insights: Insight[]): Square[] {
  return insights.flatMap((i) => (i.text.match(/\b[a-h][1-8]\b/g) ?? []) as Square[]);
}

