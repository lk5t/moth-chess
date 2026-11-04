// Player DNA and adaptive training (3.0). Everything here is computed from the user's own completed,
// imported or practice games and training history in local storage — never from live play.
import { db, type RepertoireLine, type TrainingLog } from '@/memory/db';
import { analyseWeaknesses, type WeaknessReport } from '@/coach/coach';
import { ENDGAME_DRILLS } from '@/endgame/endgame';
import type { Color, GameReview, SavedGame, TrainingExercise } from '@/types';

const DAY = 24 * 3600e3;
/** Leitner intervals in days for boxes 0..4 (shared by exercises and repertoire drills). */
export const BOX_DAYS = [0, 1, 3, 7, 21];

export async function logTraining(e: Omit<TrainingLog, 'id'>): Promise<void> { await db().trainingLog.add(e); }

export interface PlayerDna {
  games: number;
  reviewed: number;
  openings: { name: string; eco: string; games: number; score: number; color: Color | 'both' }[];
  accuracy: { overall: number | null; trend: { label: string; value: number }[] };
  phases: { phase: string; mistakes: number; avgLoss: number }[];
  motifs: { motif: string; count: number }[];
  endgame: { drills: number; success: number; byKind: { id: string; title: string; tries: number; solved: number }[] };
  training: { attempts: number; success: number; last14: number };
  weaknesses: WeaknessReport;
  style: string[];
  sufficient: boolean;
}

const scoreOf = (g: SavedGame): number | null => {
  const side = g.userColor;
  if (g.result === '1/2-1/2') return 0.5;
  if (!side || g.result === '*') return null;
  return (g.result === '1-0') === (side === 'w') ? 1 : 0;
};

export function computeDna(games: SavedGame[], reviews: GameReview[], exercises: TrainingExercise[], attempts: { at: number; correct: boolean }[], log: TrainingLog[]): PlayerDna {
  const byId = new Map(games.map((g) => [g.id!, g]));
  const colorBy = new Map<number, Color | undefined>(games.map((g) => [g.id!, g.userColor]));
  const weak = analyseWeaknesses(reviews, exercises, attempts as never, colorBy);
  // openings: by name, from the user's side
  const op = new Map<string, { name: string; eco: string; games: number; pts: number; n: number; colors: Set<Color> }>();
  for (const g of games) {
    if (!g.openingName) continue;
    const e = op.get(g.openingName) ?? { name: g.openingName, eco: g.eco ?? '', games: 0, pts: 0, n: 0, colors: new Set<Color>() };
    e.games++; const s = scoreOf(g); if (s !== null) { e.pts += s; e.n++; }
    if (g.userColor) e.colors.add(g.userColor);
    op.set(g.openingName, e);
  }
  const openings = [...op.values()].sort((a, b) => b.games - a.games).slice(0, 8)
    .map((e) => ({ name: e.name, eco: e.eco, games: e.games, score: e.n ? e.pts / e.n : NaN, color: (e.colors.size === 1 ? [...e.colors][0] : 'both') as Color | 'both' }));
  // accuracy trend (user's side, chronological, grouped by 5 reviews)
  const done = reviews.filter((r) => r.status === 'complete').sort((a, b) => a.createdAt - b.createdAt);
  const accs = done.map((r) => { const c = colorBy.get(r.gameId); return c === 'b' ? r.accuracyBlack : c === 'w' ? r.accuracyWhite : r.accuracyWhite !== undefined && r.accuracyBlack !== undefined ? (r.accuracyWhite + r.accuracyBlack) / 2 : undefined; })
    .filter((x): x is number => typeof x === 'number');
  const trend: { label: string; value: number }[] = [];
  for (let i = 0; i < accs.length; i += 5) { const xs = accs.slice(i, i + 5); trend.push({ label: `${i + 1}–${i + xs.length}`, value: xs.reduce((a, b) => a + b, 0) / xs.length }); }
  const endLog = log.filter((l) => l.kind === 'endgame');
  const byKind = ENDGAME_DRILLS.map((d) => { const xs = endLog.filter((l) => l.itemId === d.id); return { id: d.id, title: d.title, tries: xs.length, solved: xs.filter((x) => x.success).length }; }).filter((x) => x.tries);
  const recent = attempts.filter((a) => a.at > Date.now() - 14 * DAY);
  // style observations, only from measured data
  const style: string[] = [];
  const tactical = weak.byMotif.filter((m) => m.motif !== 'positional').reduce((a, m) => a + m.count, 0);
  if (weak.sufficientData) {
    const worst = [...weak.byPhase].sort((a, b) => b.count - a.count)[0];
    if (worst?.count) style.push(`Most costly phase: ${worst.phase}.`);
    if (tactical > (weak.byMotif.find((m) => m.motif === 'positional')?.count ?? 0)) style.push('More of your mistakes are tactical than positional.');
    else style.push('More of your mistakes are positional than tactical.');
  }
  const whiteGames = games.filter((g) => g.userColor === 'w'), blackGames = games.filter((g) => g.userColor === 'b');
  const avgScore = (gs: SavedGame[]) => { const xs = gs.map(scoreOf).filter((x): x is number => x !== null); return xs.length >= 3 ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const sw = avgScore(whiteGames), sb = avgScore(blackGames);
  if (sw !== null && sb !== null && Math.abs(sw - sb) >= 0.15) style.push(`You score better with ${sw > sb ? 'White' : 'Black'} (${Math.round(Math.max(sw, sb) * 100)}% vs ${Math.round(Math.min(sw, sb) * 100)}%).`);
  void byId;
  return {
    games: games.length, reviewed: done.length, openings,
    accuracy: { overall: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null, trend },
    phases: weak.byPhase.map((p) => ({ phase: p.phase, mistakes: p.count, avgLoss: p.avgLoss })),
    motifs: weak.byMotif.map((m) => ({ motif: m.motif, count: m.count })),
    endgame: { drills: endLog.length, success: endLog.filter((l) => l.success).length, byKind },
    training: { attempts: attempts.length, success: attempts.filter((a) => a.correct).length, last14: recent.length },
    weaknesses: weak, style, sufficient: weak.sufficientData,
  };
}

export async function loadDna(): Promise<PlayerDna> {
  const d = db();
  const [games, reviews, exercises, attempts, log] = await Promise.all([d.games.toArray(), d.reviews.toArray(), d.exercises.toArray(), d.attempts.toArray(), d.trainingLog.toArray()]);
  return computeDna(games, reviews, exercises, attempts, log);
}

/** Delete the derived profile data (training history and repertoire statistics). Games are kept. */
export async function resetDna(opts: { history: boolean; exercises: boolean }) {
  const d = db();
  if (opts.history) await d.trainingLog.clear();
  if (opts.exercises) { await d.attempts.clear(); await d.exercises.toCollection().modify({ box: 0, dueAt: Date.now() }); }
  await d.repertoire.toCollection().modify({ drilled: 0, correct: 0, box: 0, dueAt: 0 });
}

// ---------------- adaptive difficulty for endgame drills ----------------
/** Current drill level: start at 1; move up after two consecutive successes at a level, down after two failures. */
export function endgameLevel(log: TrainingLog[]): 1 | 2 | 3 {
  let level = 1;
  let streak = 0;
  for (const l of log.filter((x) => x.kind === 'endgame').sort((a, b) => a.at - b.at)) {
    if ((l.level ?? 1) !== level) continue;
    streak = l.success ? Math.max(1, streak + 1) : Math.min(-1, streak - 1);
    if (streak >= 2 && level < 3) { level++; streak = 0; }
    if (streak <= -2 && level > 1) { level--; streak = 0; }
  }
  return level as 1 | 2 | 3;
}

export interface Recommendation { kind: 'exercises' | 'endgame' | 'repertoire' | 'review' | 'play'; title: string; why: string; target?: string; count?: number }

/** What to train next, in priority order, with the reason for each suggestion. */
export function recommend(dna: PlayerDna, due: { exercises: number; repertoire: number }, log: TrainingLog[]): Recommendation[] {
  const out: Recommendation[] = [];
  if (due.exercises) out.push({ kind: 'exercises', title: `${due.exercises} exercise${due.exercises > 1 ? 's' : ''} due`, why: 'Spaced repetition: positions from your own mistakes, scheduled for today.', count: due.exercises });
  if (due.repertoire) out.push({ kind: 'repertoire', title: `${due.repertoire} repertoire line${due.repertoire > 1 ? 's' : ''} to drill`, why: 'Keep your opening lines fresh.', count: due.repertoire });
  const lvl = endgameLevel(log);
  const solved = new Set(log.filter((l) => l.kind === 'endgame' && l.success).map((l) => l.itemId));
  const nextDrill = ENDGAME_DRILLS.filter((d) => d.level === lvl).find((d) => !solved.has(d.id)) ?? ENDGAME_DRILLS.find((d) => !solved.has(d.id));
  const endWeak = dna.phases.find((p) => p.phase === 'endgame');
  if (nextDrill) out.push({ kind: 'endgame', title: `Endgame: ${nextDrill.title}`, why: endWeak && endWeak.mistakes >= 3 ? `You made ${endWeak.mistakes} mistakes in endgames.` : `Level ${lvl} technique you have not solved yet.`, target: nextDrill.id });
  if (dna.games > dna.reviewed) out.push({ kind: 'review', title: `Review ${dna.games - dna.reviewed} unreviewed game${dna.games - dna.reviewed > 1 ? 's' : ''}`, why: 'Reviews create new personal exercises and improve your Player DNA.' });
  if (!dna.games) out.push({ kind: 'play', title: 'Play a game against MOTH', why: 'Your games are the raw material for coaching and training.' });
  return out;
}

// ---------------- repertoire ----------------
export const repKey = (color: 'w' | 'b', uci: string[]) => `${color}:${uci.join(' ')}`;
export async function saveRepertoire(color: 'w' | 'b', name: string, uci: string[]): Promise<boolean> {
  const key = repKey(color, uci);
  if (await db().repertoire.where('key').equals(key).count()) return false;
  await db().repertoire.add({ color, name, uci, key, createdAt: Date.now(), drilled: 0, correct: 0, dueAt: Date.now(), box: 0 });
  return true;
}
export function scheduleRepertoire(r: RepertoireLine, correct: boolean, now = Date.now()): Pick<RepertoireLine, 'box' | 'dueAt' | 'drilled' | 'correct'> {
  const box = correct ? Math.min(4, r.box + 1) : 0;
  return { box, dueAt: now + BOX_DAYS[box] * DAY, drilled: r.drilled + 1, correct: r.correct + (correct ? 1 : 0) };
}
/** For a drill: the user's move at `ply` must equal the repertoire move (only plies of the user's colour are asked). */
export function repertoireQuestions(r: RepertoireLine): number[] {
  return r.uci.map((_, i) => i).filter((i) => (i % 2 === 0) === (r.color === 'w'));
}
