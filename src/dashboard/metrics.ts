// Performance Dashboard metrics. Every metric reports its sample size so the UI can flag low confidence.
import type { Color, ExerciseAttempt, ExerciseCategory, GameResult, GameReview, SavedGame } from '@/types';
import { countClasses, gameAccuracy } from '@/review/review';

export interface DashboardFilters {
  from?: number; // epoch ms on import date
  to?: number;
  eco?: string; // prefix, e.g. "B" or "B90"
  result?: GameResult | 'win' | 'loss' | 'draw';
  color?: Color;
  category?: ExerciseCategory;
}

export interface Metric { value: number | null; n: number; lowConfidence: boolean; explanation: string }

export interface DashboardData {
  gamesReviewed: number;
  accuracy: Metric;
  blundersPer100: Metric;
  mistakesPer100: Metric;
  inaccuraciesPer100: Metric;
  openings: { eco: string; name: string; games: number; score: number; accuracy: number | null }[];
  endgameAccuracy: Metric;
  openingAccuracy: Metric;
  trainingSuccess: Metric;
  trainingByCategory: { category: ExerciseCategory; attempts: number; success: number }[];
  accuracyTrend: { label: string; value: number; n: number }[];
  evalGraphs: { gameId: number; title: string; points: number[] }[];
}

const LOW_N = 5;

function userSide(g: SavedGame, f: DashboardFilters): Color | undefined {
  return f.color ?? g.userColor;
}

function resultFor(g: SavedGame, side?: Color): 'win' | 'loss' | 'draw' | 'unknown' {
  if (g.result === '1/2-1/2') return 'draw';
  if (g.result === '*' || !side) return 'unknown';
  return (g.result === '1-0') === (side === 'w') ? 'win' : 'loss';
}

export function filterGames(games: SavedGame[], f: DashboardFilters): SavedGame[] {
  return games.filter((g) => {
    if (f.from && g.importedAt < f.from) return false;
    if (f.to && g.importedAt > f.to) return false;
    if (f.eco && !(g.eco ?? '').toUpperCase().startsWith(f.eco.toUpperCase())) return false;
    if (f.color && g.userColor && g.userColor !== f.color) return false;
    if (f.result) {
      if (['1-0', '0-1', '1/2-1/2', '*'].includes(f.result)) { if (g.result !== f.result) return false; }
      else if (resultFor(g, userSide(g, f)) !== f.result) return false;
    }
    return true;
  });
}

const metric = (value: number | null, n: number, explanation: string): Metric => ({ value, n, lowConfidence: n < LOW_N, explanation });

export function computeDashboard(games: SavedGame[], reviews: GameReview[], attempts: ExerciseAttempt[], f: DashboardFilters = {}): DashboardData {
  const gs = filterGames(games, f);
  const byId = new Map(gs.map((g) => [g.id!, g]));
  const rv = reviews.filter((r) => r.status === 'complete' && byId.has(r.gameId));

  let accSum = 0, accN = 0;
  let movesN = 0, bl = 0, mi = 0, ina = 0;
  const phaseAcc: Record<string, { s: number; n: number }> = { opening: { s: 0, n: 0 }, endgame: { s: 0, n: 0 } };
  for (const r of rv) {
    const g = byId.get(r.gameId)!;
    const side = userSide(g, f);
    const colors: Color[] = side ? [side] : ['w', 'b'];
    for (const c of colors) {
      const a = gameAccuracy(r.moves, c);
      if (a !== undefined) { accSum += a; accN++; }
      const cc = countClasses(r.moves, c);
      bl += cc.blunder; mi += cc.mistake; ina += cc.inaccuracy;
      for (const m of r.moves) {
        if (m.color !== c) continue;
        if (m.classification !== 'book' && m.classification !== 'forced') movesN++;
        if ((m.phase === 'opening' || m.phase === 'endgame') && m.classification !== 'book' && m.classification !== 'forced') { phaseAcc[m.phase].s += m.accuracy; phaseAcc[m.phase].n++; }
      }
    }
  }
  const per100 = (x: number) => (movesN ? Math.round((x / movesN) * 1000) / 10 : null);

  const openMap = new Map<string, { eco: string; name: string; games: number; points: number; acc: number[] }>();
  for (const g of gs) {
    const key = g.eco ?? '—';
    const e = openMap.get(key) ?? { eco: key, name: g.openingName ?? 'Unknown', games: 0, points: 0, acc: [] };
    e.games++;
    const res = resultFor(g, userSide(g, f));
    e.points += res === 'win' ? 1 : res === 'draw' ? 0.5 : 0;
    const r = rv.find((x) => x.gameId === g.id);
    const side = userSide(g, f);
    if (r) { const a = side ? gameAccuracy(r.moves, side) : r.accuracyWhite; if (a !== undefined) e.acc.push(a); }
    openMap.set(key, e);
  }

  const at = attempts.filter((a) => (!f.category || a.category === f.category) && (!f.from || a.at >= f.from) && (!f.to || a.at <= f.to));
  const catMap = new Map<ExerciseCategory, { attempts: number; ok: number }>();
  for (const a of at) { const c = catMap.get(a.category) ?? { attempts: 0, ok: 0 }; c.attempts++; if (a.correct) c.ok++; catMap.set(a.category, c); }

  // weekly accuracy trend
  const weeks = new Map<string, { s: number; n: number }>();
  for (const r of rv) {
    const g = byId.get(r.gameId)!;
    const side = userSide(g, f);
    const a = side ? gameAccuracy(r.moves, side) : averageDefined([r.accuracyWhite, r.accuracyBlack]);
    if (a === undefined) continue;
    const d = new Date(r.createdAt);
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const label = monday.toISOString().slice(0, 10);
    const w = weeks.get(label) ?? { s: 0, n: 0 }; w.s += a; w.n++; weeks.set(label, w);
  }

  return {
    gamesReviewed: rv.length,
    accuracy: metric(accN ? Math.round((accSum / accN) * 10) / 10 : null, accN, 'Mean of per-game estimated accuracy. Each move scores 0–100 from how much engine win probability it lost (Lichess open-source formula). Not comparable with chess.com CAPS.'),
    blundersPer100: metric(per100(bl), movesN, `Moves losing ≥15 win-percentage points, per 100 non-book moves.`),
    mistakesPer100: metric(per100(mi), movesN, `Moves losing 10–15 win-percentage points, per 100 non-book moves.`),
    inaccuraciesPer100: metric(per100(ina), movesN, `Moves losing 5–10 win-percentage points, per 100 non-book moves.`),
    openings: [...openMap.values()].map((e) => ({ eco: e.eco, name: e.name, games: e.games, score: e.games ? Math.round((e.points / e.games) * 100) : 0, accuracy: e.acc.length ? Math.round(averageDefined(e.acc)! * 10) / 10 : null })).sort((a, b) => b.games - a.games),
    openingAccuracy: metric(phaseAcc.opening.n ? Math.round((phaseAcc.opening.s / phaseAcc.opening.n) * 10) / 10 : null, phaseAcc.opening.n, 'Average accuracy of non-book moves played in the opening phase.'),
    endgameAccuracy: metric(phaseAcc.endgame.n ? Math.round((phaseAcc.endgame.s / phaseAcc.endgame.n) * 10) / 10 : null, phaseAcc.endgame.n, 'Average accuracy of moves played once the position became an endgame (reduced non-pawn material).'),
    trainingSuccess: metric(at.length ? Math.round((at.filter((a) => a.correct).length / at.length) * 1000) / 10 : null, at.length, 'Share of Coach exercise attempts solved correctly (first move).'),
    trainingByCategory: [...catMap.entries()].map(([category, c]) => ({ category, attempts: c.attempts, success: Math.round((c.ok / c.attempts) * 100) })),
    accuracyTrend: [...weeks.entries()].sort().map(([label, w]) => ({ label, value: Math.round((w.s / w.n) * 10) / 10, n: w.n })),
    evalGraphs: rv.slice(-5).map((r) => {
      const g = byId.get(r.gameId)!;
      return { gameId: r.gameId, title: `${g.white} – ${g.black}`, points: r.moves.map((m) => m.winAfter * (m.color === 'w' ? 1 : -1) + (m.color === 'w' ? 0 : 100)) };
    }),
  };
}

function averageDefined(xs: (number | undefined)[]): number | undefined {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : undefined;
}
