// Personal opponent adaptation. Learns only from the user's completed practice games against MOTH and
// is kept completely separate from the engine's evaluation model: it changes which *sound* book lines
// MOTH chooses (opponent preparation) and what MOTH Coach recommends — never the network weights.
import { applyMove, positionKey, START_FEN } from '@/chess/position';
import { db, type PracticeGame } from '@/memory/db';
import type { StockfishEngine } from '@/engine/engine';

export interface Profile {
  games: number;
  asWhite: { games: number; score: number };
  asBlack: { games: number; score: number };
  openings: { key: string; name: string; games: number; score: number; userColor: 'w' | 'b' }[];
  weaknesses: { tag: string; count: number; perGame: number }[];
  phases: { opening: number; middlegame: number; endgame: number }; // average evaluation loss per move (cp)
  gambits: { faced: number; score: number };
  attacking: { sacrifices: number; checksGiven: number };
  recent: { at: number; result: string; userColor: 'w' | 'b'; score: number }[];
}

const scoreFor = (g: PracticeGame) => (g.result === '1/2-1/2' ? 0.5 : (g.result === '1-0') === (g.userColor === 'w') ? 1 : 0);

export function buildProfile(games: PracticeGame[]): Profile {
  const p: Profile = { games: games.length, asWhite: { games: 0, score: 0 }, asBlack: { games: 0, score: 0 }, openings: [], weaknesses: [], phases: { opening: 0, middlegame: 0, endgame: 0 }, gambits: { faced: 0, score: 0 }, attacking: { sacrifices: 0, checksGiven: 0 }, recent: [] };
  const op = new Map<string, Profile['openings'][number]>();
  const tags = new Map<string, number>();
  const phaseSum = { opening: [0, 0], middlegame: [0, 0], endgame: [0, 0] } as Record<'opening' | 'middlegame' | 'endgame', [number, number]>;
  for (const g of games) {
    const s = scoreFor(g);
    const side = g.userColor === 'w' ? p.asWhite : p.asBlack;
    side.games++; side.score += s;
    const k = `${g.userColor}|${g.openingKey}`;
    const o = op.get(k) ?? { key: g.openingKey, name: g.openingName ?? g.openingKey, games: 0, score: 0, userColor: g.userColor };
    o.games++; o.score += s; op.set(k, o);
    if (/Gambit/i.test(g.openingName ?? '')) { p.gambits.faced++; p.gambits.score += s; }
    for (const m of g.userMoves) {
      for (const t of m.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
      if (m.tags.includes('sacrifice')) p.attacking.sacrifices++;
      if (m.tags.includes('check')) p.attacking.checksGiven++;
      const ph = m.tags.includes('endgame') ? 'endgame' : m.ply < 20 ? 'opening' : 'middlegame';
      phaseSum[ph][0] += Math.max(0, m.before - m.after); phaseSum[ph][1]++;
    }
    p.recent.push({ at: g.at, result: g.result, userColor: g.userColor, score: s });
  }
  p.openings = [...op.values()].map((o) => ({ ...o, score: o.games ? o.score / o.games : 0 })).sort((a, b) => b.games - a.games);
  if (p.asWhite.games) p.asWhite.score /= p.asWhite.games;
  if (p.asBlack.games) p.asBlack.score /= p.asBlack.games;
  if (p.gambits.faced) p.gambits.score /= p.gambits.faced;
  const ERR = new Set(['blunder', 'mistake', 'inaccuracy', 'hung-piece', 'missed-capture', 'missed-mate', 'allowed-mate']);
  p.weaknesses = [...tags.entries()].filter(([t]) => ERR.has(t)).map(([tag, count]) => ({ tag, count, perGame: games.length ? count / games.length : 0 })).sort((a, b) => b.count - a.count);
  for (const ph of ['opening', 'middlegame', 'endgame'] as const) p.phases[ph] = phaseSum[ph][1] ? phaseSum[ph][0] / phaseSum[ph][1] : 0;
  p.recent.sort((a, b) => b.at - a.at);
  p.recent = p.recent.slice(0, 20);
  return p;
}

/**
 * Opponent preparation: book positions where MOTH played a move and the user went on to score badly
 * (≤ 0.4 over ≥ 2 games) — MOTH prefers those moves again *if they are still sound in its book*.
 * Encoded for the engine's `Prepare` UCI option ("fenKey=uci;…", spaces as underscores).
 */
export function preparation(games: PracticeGame[]): string {
  const stats = new Map<string, { games: number; score: number }>();
  for (const g of games) {
    const s = scoreFor(g);
    let fen = START_FEN;
    for (let i = 0; i < Math.min(12, g.uci.length); i++) {
      const moverIsMoth = (fen.split(' ')[1] === 'w') !== (g.userColor === 'w');
      const r = applyMove(fen, g.uci[i]);
      if (!r) break;
      if (moverIsMoth) {
        const k = `${fen.split(' ').slice(0, 4).join('_')}=${g.uci[i]}`;
        const st = stats.get(k) ?? { games: 0, score: 0 };
        st.games++; st.score += s; stats.set(k, st);
      }
      fen = r.fenAfter;
    }
  }
  return [...stats.entries()].filter(([, v]) => v.games >= 2 && v.score / v.games <= 0.4).map(([k]) => k).slice(0, 200).join(';');
}

/**
 * Classify the user's moves of a finished game with MOTH's evaluation before and after each move.
 * Uses a separate (batch) engine so it never disturbs live play.
 */
export async function analyseUserMoves(engine: StockfishEngine, uci: string[], userColor: 'w' | 'b', depth = 9, signal?: AbortSignal): Promise<PracticeGame['userMoves']> {
  const out: PracticeGame['userMoves'] = [];
  let fen = START_FEN;
  const fens: string[] = [fen];
  for (const m of uci) { const r = applyMove(fen, m); if (!r) break; fen = r.fenAfter; fens.push(fen); }
  const evalOf = async (f: string): Promise<{ cp: number; best?: string; mate?: number }> => {
    const r = await engine.analyse(f, { depth, multiPv: 1 }).result;
    const l = r.lines[0];
    if (!l) return { cp: 0 };
    const cp = l.score.type === 'mate' ? (l.score.value > 0 ? 2000 - l.score.value : -2000 - l.score.value) : l.score.value;
    return { cp, best: l.pv[0], mate: l.score.type === 'mate' ? l.score.value : undefined };
  };
  for (let i = 0; i < fens.length - 1; i++) {
    if (signal?.aborted) break;
    const stm = fens[i].split(' ')[1];
    if (stm !== userColor) continue;
    const before = await evalOf(fens[i]);
    const afterOpp = await evalOf(fens[i + 1]);
    const after = -afterOpp.cp;
    const drop = before.cp - after;
    const rec = applyMove(fens[i], uci[i])!;
    const tags: string[] = [];
    if (drop >= 300) tags.push('blunder'); else if (drop >= 120) tags.push('mistake'); else if (drop >= 50) tags.push('inaccuracy');
    if (drop >= 150 && before.best && before.best !== uci[i] && applyMove(fens[i], before.best)?.captured) tags.push('missed-capture');
    if (before.mate && before.mate > 0 && !(afterOpp.mate !== undefined && afterOpp.mate < 0)) tags.push('missed-mate');
    if (afterOpp.mate !== undefined && afterOpp.mate > 0) tags.push('allowed-mate');
    if (drop >= 200 && afterOpp.best && applyMove(fens[i + 1], afterOpp.best)?.captured && !before.mate) tags.push('hung-piece');
    if (rec.san.includes('+')) tags.push('check');
    const pieces = fens[i].split(' ')[0].replace(/[^nbrqNBRQ]/g, '').length;
    if (pieces <= 4) tags.push('endgame');
    // sound sacrifice: the opponent's best reply wins ≥ 2 points of material back, yet the evaluation barely drops
    const reply = afterOpp.best ? applyMove(fens[i + 1], afterOpp.best) : null;
    if (reply?.captured && pieceValue(reply.captured) - pieceValue(rec.captured) >= 2 && drop < 60) tags.push('sacrifice');
    out.push({ ply: i, uci: uci[i], before: before.cp, after, best: before.best, tags });
  }
  return out;
}
const pieceValue = (p?: string) => ({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 } as Record<string, number>)[p ?? ''] ?? 0;

/** Training advice from games against MOTH (personal adaptation). Requires ≥ 3 practice games. */
export function practiceAdvice(p: Profile): string[] {
  if (p.games < 3) return [];
  const out: string[] = [];
  const top = p.weaknesses[0];
  const per = (t: string) => p.weaknesses.find((w) => w.tag === t)?.perGame ?? 0;
  if (top) out.push(`Against MOTH you most often make: ${top.tag.replace(/-/g, ' ')} (${top.count}× in ${p.games} games).`);
  if (per('hung-piece') >= 0.5) out.push('Before each move, check which of your pieces are undefended — practise the "hanging piece" exercises.');
  if (per('missed-capture') + per('missed-mate') >= 0.5) out.push('You miss winning captures and mates: run tactical sessions (forks, pins, mates) from the Coach.');
  const worst = (['opening', 'middlegame', 'endgame'] as const).reduce((a, b) => (p.phases[b] > p.phases[a] ? b : a), 'opening');
  if (p.phases[worst] > 40) out.push(`Your largest average loss per move is in the ${worst} (${p.phases[worst].toFixed(0)} cp) — focus training there.`);
  if (p.gambits.faced >= 2 && p.gambits.score < 0.4) out.push(`You score ${(p.gambits.score * 100).toFixed(0)}% against gambits — MOTH will keep testing you with sound gambits on Aggressive.`);
  const weakOpening = p.openings.find((o) => o.games >= 2 && o.score <= 0.25);
  if (weakOpening) out.push(`Weak line: ${weakOpening.name} as ${weakOpening.userColor === 'w' ? 'White' : 'Black'} (${(weakOpening.score * 100).toFixed(0)}% in ${weakOpening.games}). MOTH prepares it against you while learning is on.`);
  return out;
}

export async function savePractice(g: PracticeGame): Promise<number> { return db().practice.add(g); }
export async function practiceGames(): Promise<PracticeGame[]> { return db().practice.toArray(); }
export async function deletePracticeHistory(): Promise<void> { await db().practice.clear(); }
export { positionKey };
