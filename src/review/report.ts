// Smart Game Reports (3.0): a structured, exportable report built only from a completed engine review.
// Nothing is invented: every statement points at moves and evaluations the review measured.
import type { Color, GameReview, ReviewedMove, SavedGame } from '@/types';
import { countClasses, gameAccuracy } from './review';
import { exercisesFromReview } from '@/coach/coach';
import { recogniseOpening } from '@/openings/eco';

export const ACCURACY_METHOD = 'Each move is scored from the change in the mover\'s win probability (derived from the engine evaluation before and after the move): no loss = 100, larger losses score lower. A game\'s accuracy is the average of the plain and harmonic means of its non-book, non-forced moves, so single blunders weigh more. It is a MOTH estimate and not comparable to any website\'s proprietary score.';

export interface GameReport {
  title: string;
  players: { white: string; black: string; result: string; user?: Color };
  opening?: { eco: string; name: string; leftBookAt?: number };
  accuracy: { w?: number; b?: number };
  counts: { w: ReturnType<typeof countClasses>; b: ReturnType<typeof countClasses> };
  summary: string[];
  critical: { ply: number; label: string; san: string; best?: string; swing: number; kind: 'mistake' | 'turning-point' }[];
  missed: { ply: number; label: string; san: string; best?: string; lost: number }[];
  strong: { ply: number; label: string; san: string; why: string }[];
  phases: { phase: string; w?: number; b?: number }[];
  strengths: string[];
  weaknesses: string[];
  training: { count: number; categories: string[] };
  evalCurve: number[]; // White's win % after each ply
  method: string;
}

const label = (m: ReviewedMove) => `${Math.ceil(m.ply / 2)}${m.color === 'w' ? '.' : '...'}${m.san}`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

export function buildReport(review: GameReview, game: SavedGame): GameReport {
  const mv = review.moves;
  const user = game.userColor;
  const op = (() => { try { return recogniseOpening([mv[0]?.fenBefore ?? '', ...mv.map((m) => m.fenAfter)]); } catch { return null; } })();
  const swing = (m: ReviewedMove) => m.winBefore - m.winAfter;
  const bad = mv.filter((m) => m.classification === 'blunder' || m.classification === 'mistake').sort((a, b) => swing(b) - swing(a));
  const critical = bad.slice(0, 5).map((m) => ({ ply: m.ply, label: label(m), san: m.san, best: m.bestMoveSan, swing: Math.round(swing(m)), kind: 'mistake' as const }));
  // missed opportunities: the opponent just erred (≥10% swing) and the reply gave most of it back
  const missed: GameReport['missed'] = [];
  for (let i = 1; i < mv.length; i++) {
    const prev = mv[i - 1], m = mv[i];
    if (swing(prev) >= 10 && (m.classification === 'mistake' || m.classification === 'blunder' || m.classification === 'inaccuracy') && m.bestMoveSan)
      missed.push({ ply: m.ply, label: label(m), san: m.san, best: m.bestMoveSan, lost: Math.round(swing(m)) });
  }
  // strong moves: best moves played in sharp positions (the side to move was not already winning or lost, and the move kept the balance after an opponent error)
  const strong: GameReport['strong'] = [];
  for (let i = 1; i < mv.length && strong.length < 5; i++) {
    const prev = mv[i - 1], m = mv[i];
    if (m.classification === 'best' && swing(prev) >= 10) strong.push({ ply: m.ply, label: label(m), san: m.san, why: `punished ${label(prev)} (${prev.classification})` });
  }
  for (const m of mv) {
    if (strong.length >= 5) break;
    if (m.classification === 'best' && m.winBefore > 25 && m.winBefore < 75 && m.phase !== 'opening' && !strong.some((s) => s.ply === m.ply)) strong.push({ ply: m.ply, label: label(m), san: m.san, why: 'the engine\'s first choice in a balanced position' });
  }
  const phases = (['opening', 'middlegame', 'endgame'] as const).map((p) => {
    const f = (c: Color) => avg(mv.filter((m) => m.phase === p && m.color === c && m.classification !== 'book' && m.classification !== 'forced').map((m) => m.accuracy));
    return { phase: p, w: f('w'), b: f('b') };
  });
  const sides: Color[] = user ? [user] : ['w', 'b'];
  const strengths: string[] = [], weaknesses: string[] = [];
  for (const c of sides) {
    const who = user ? 'You' : c === 'w' ? 'White' : 'Black';
    const ph = phases.map((p) => ({ p: p.phase, a: c === 'w' ? p.w : p.b })).filter((x) => x.a !== undefined) as { p: string; a: number }[];
    if (ph.length >= 2) {
      const best = [...ph].sort((a, b) => b.a - a.a)[0], worst = [...ph].sort((a, b) => a.a - b.a)[0];
      if (best.a - worst.a >= 8) { strengths.push(`${who} played the ${best.p} best (${best.a.toFixed(0)}%).`); weaknesses.push(`${who} lost most accuracy in the ${worst.p} (${worst.a.toFixed(0)}%).`); }
    }
    const cc = countClasses(mv, c);
    if (cc.blunder === 0 && mv.filter((m) => m.color === c).length >= 15) strengths.push(`${who} made no blunders.`);
    if (cc.blunder >= 2) weaknesses.push(`${who} blundered ${cc.blunder} times — check the opponent's threats before each move.`);
  }
  const ex = exercisesFromReview(review, { userColor: user, gameId: game.id });
  const summary: string[] = [];
  const res = game.result === '1-0' ? 'White won' : game.result === '0-1' ? 'Black won' : game.result === '1/2-1/2' ? 'Draw' : 'Unfinished';
  summary.push(`${res} in ${Math.ceil(mv.length / 2)} moves.`);
  if (critical[0]) summary.push(`The turning point was ${critical[0].label}: the mover's win chance dropped by ${critical[0].swing} points${critical[0].best ? `; ${critical[0].best} was better` : ''}.`);
  if (missed[0]) summary.push(`Missed chance: ${missed[0].label} let the opponent off the hook${missed[0].best ? ` (${missed[0].best} kept the advantage)` : ''}.`);
  return {
    title: `${game.white} – ${game.black}${game.date ? `, ${game.date}` : ''}`,
    players: { white: game.white, black: game.black, result: game.result, user },
    opening: op?.opening ? { eco: op.opening.eco, name: op.opening.name, leftBookAt: op.leftBookAt } : undefined,
    accuracy: { w: gameAccuracy(mv, 'w'), b: gameAccuracy(mv, 'b') },
    counts: { w: countClasses(mv, 'w'), b: countClasses(mv, 'b') },
    summary, critical, missed: missed.slice(0, 5), strong, phases, strengths, weaknesses,
    training: { count: ex.length, categories: [...new Set(ex.map((e) => e.category))] },
    evalCurve: mv.map((m) => (m.color === 'w' ? m.winAfter : 100 - m.winAfter)),
    method: ACCURACY_METHOD,
  };
}

export function reportMarkdown(r: GameReport): string {
  const L: string[] = [`# Game report: ${r.title}`, '', `Result: **${r.players.result}**${r.opening ? ` · Opening: ${r.opening.eco} ${r.opening.name}` : ''}`, ''];
  L.push('## Summary', ...r.summary.map((s) => `- ${s}`), '');
  L.push('## Accuracy', `- ${r.players.white}: ${r.accuracy.w ?? '—'}% (${r.counts.w.blunder} blunders, ${r.counts.w.mistake} mistakes, ${r.counts.w.inaccuracy} inaccuracies)`, `- ${r.players.black}: ${r.accuracy.b ?? '—'}% (${r.counts.b.blunder} blunders, ${r.counts.b.mistake} mistakes, ${r.counts.b.inaccuracy} inaccuracies)`, '');
  if (r.critical.length) L.push('## Critical moments', ...r.critical.map((c) => `- ${c.label} — win chance −${c.swing}${c.best ? `; better was ${c.best}` : ''}`), '');
  if (r.missed.length) L.push('## Missed opportunities', ...r.missed.map((c) => `- ${c.label}${c.best ? ` (${c.best} was stronger)` : ''}`), '');
  if (r.strong.length) L.push('## Strong moves', ...r.strong.map((c) => `- ${c.label}: ${c.why}`), '');
  L.push('## By phase', ...r.phases.map((p) => `- ${p.phase}: White ${p.w?.toFixed(0) ?? '—'}%, Black ${p.b?.toFixed(0) ?? '—'}%`), '');
  if (r.strengths.length || r.weaknesses.length) L.push('## Strengths and weaknesses', ...r.strengths.map((s) => `- ✓ ${s}`), ...r.weaknesses.map((s) => `- ✗ ${s}`), '');
  L.push('## Training', `- ${r.training.count} exercise(s) can be generated from this game${r.training.categories.length ? ` (${r.training.categories.join(', ')})` : ''}.`, '');
  L.push('## How accuracy is calculated', r.method, '', '_Generated locally by MOTH Chess._');
  return L.join('\n');
}
