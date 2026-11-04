// Promotion gate and model registry types. A candidate is promoted only if it measurably improves on
// its parent; otherwise it is kept as `rejected` (with the reasons) and the parent stays active.
import type { MatchResult, ModelMeta, ModelStatus } from '../model.ts';

export interface RegistryEntry {
  id: string;
  version: string;
  file: string;
  status: ModelStatus;
  parent: string;
  createdAt: number;
  summary: { data?: ModelMeta['data']; valLoss?: number; valLossParent?: number; match?: MatchResult; tactics?: { solved: number; total: number }; parentTactics?: { solved: number; total: number } };
  reasons: string[];
}
export interface Registry { format: 'moth-registry-1'; active: string | null; models: RegistryEntry[] }

export interface GatePolicy {
  /** required relative validation-loss improvement over the parent */
  minValImprovement: number;
  /** minimum match score against the parent */
  minScore: number;
  /** minimum likelihood of superiority (from wins/losses) */
  minLos: number;
  /** allowed tactical regression (puzzles) */
  maxTacticsDrop: number;
}
export const DEFAULT_GATE: GatePolicy = { minValImprovement: 0.002, minScore: 0.5, minLos: 0.8, maxTacticsDrop: 0.03 };

export function decideCandidate(meta: ModelMeta, policy: GatePolicy = DEFAULT_GATE): { promoted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let ok = true;
  const m = meta.metrics;
  if (m.valLoss === undefined || m.valLossParent === undefined) { ok = false; reasons.push('no validation loss measured'); }
  else {
    const rel = (m.valLossParent - m.valLoss) / m.valLossParent;
    if (rel < policy.minValImprovement) { ok = false; reasons.push(`validation loss ${m.valLoss.toFixed(5)} vs parent ${m.valLossParent.toFixed(5)} (${(rel * 100).toFixed(2)}%, need ≥ ${(policy.minValImprovement * 100).toFixed(1)}%)`); }
    else reasons.push(`validation loss improved ${(rel * 100).toFixed(2)}%`);
  }
  if (!m.match || m.match.games === 0) { ok = false; reasons.push('no match played'); }
  else {
    const s = m.match;
    if (s.score < policy.minScore || s.los < policy.minLos) { ok = false; reasons.push(`match ${(s.score * 100).toFixed(1)}% (LOS ${(s.los * 100).toFixed(0)}%) vs ${s.vs}: not a measurable improvement`); }
    else reasons.push(`match ${(s.score * 100).toFixed(1)}%, Elo ${s.elo >= 0 ? '+' : ''}${s.elo} ± ${s.eloError}, LOS ${(s.los * 100).toFixed(0)}%`);
  }
  if (m.tactics && m.parentTactics && m.tactics.total) {
    const drop = (m.parentTactics.solved - m.tactics.solved) / m.tactics.total;
    if (drop > policy.maxTacticsDrop) { ok = false; reasons.push(`tactics regressed: ${m.tactics.solved}/${m.tactics.total} vs parent ${m.parentTactics.solved}`); }
    else reasons.push(`tactics ${m.tactics.solved}/${m.tactics.total} (parent ${m.parentTactics.solved})`);
  }
  return { promoted: ok, reasons };
}

/** Roll back: make an older approved/retired model active again. */
export function rollback(reg: Registry, toId: string): Registry {
  const target = reg.models.find((m) => m.id === toId);
  if (!target || target.status === 'rejected') throw new Error('can only roll back to a model that passed validation');
  const next: Registry = { ...reg, models: reg.models.map((m) => ({ ...m })) };
  for (const m of next.models) {
    if (m.id === reg.active) m.status = 'retired';
    if (m.id === toId) m.status = 'approved';
  }
  next.active = toId;
  return next;
}
