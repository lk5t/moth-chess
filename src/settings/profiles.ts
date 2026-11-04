// Performance profiles: named bundles of engine resources. Applying a profile writes concrete values into
// the regular settings fields, so every engine consumer (board, overlay, Play MOTH) picks them up through
// the normal settings path. Hand-editing any of those fields switches the profile to 'custom'.
import type { ProfileId, Settings, SettingsPatch } from './schema';

export interface ProfileDef {
  id: Exclude<ProfileId, 'custom'>;
  label: string;
  summary: string;
  values: {
    hashMb: number; // Stockfish hash (MOTH is capped at 128 MB by engineConfigFor)
    depth: number; // live-analysis depth limit
    multiPv: number;
    mothMoveTimeMs: number; // MOTH move time in Play MOTH
    ponder: boolean; // think on the user's time in Play MOTH
    debounceMs: number; // wait before analysing a new position
    idleSec: number; // terminate the engine worker after this long without work
  };
}

export const PROFILES: readonly ProfileDef[] = [
  { id: 'eco', label: 'Eco', summary: 'Least CPU, memory and battery. Shallower analysis, engine sleeps after 20 s.',
    values: { hashMb: 16, depth: 14, multiPv: 2, mothMoveTimeMs: 60, ponder: false, debounceMs: 400, idleSec: 20 } },
  { id: 'standard', label: 'Standard', summary: 'Balanced quality and responsiveness. The default.',
    values: { hashMb: 64, depth: 18, multiPv: 3, mothMoveTimeMs: 100, ponder: true, debounceMs: 140, idleSec: 90 } },
  { id: 'performance', label: 'Performance', summary: 'Deeper, faster analysis. More memory; engine stays warm for 5 minutes.',
    values: { hashMb: 256, depth: 24, multiPv: 3, mothMoveTimeMs: 250, ponder: true, debounceMs: 60, idleSec: 300 } },
];

export const profileById = (id: ProfileId) => PROFILES.find((p) => p.id === id);

/** Settings patch that applies a profile. */
export function profilePatch(id: Exclude<ProfileId, 'custom'>): SettingsPatch {
  const p = profileById(id)!;
  const v = p.values;
  return {
    performance: { profile: id, debounceMs: v.debounceMs, idleSec: v.idleSec },
    engine: { hashMb: v.hashMb, depth: v.depth, multiPv: v.multiPv },
    moth: { moveTimeMs: v.mothMoveTimeMs, ponder: v.ponder },
  };
}

/** Which profile the current values match exactly (or 'custom'). */
export function detectProfile(s: Settings): ProfileId {
  for (const p of PROFILES) {
    const v = p.values;
    if (s.engine.hashMb === v.hashMb && s.engine.depth === v.depth && s.engine.multiPv === v.multiPv && s.moth.moveTimeMs === v.mothMoveTimeMs
      && s.moth.ponder === v.ponder && s.performance.debounceMs === v.debounceMs && s.performance.idleSec === v.idleSec) return p.id;
  }
  return 'custom';
}

/** Patch for a manual change to a profile-controlled field: keeps the label honest. */
export function withProfileTracking(cur: Settings, patch: SettingsPatch, merge: (a: Settings, b: SettingsPatch) => Settings): SettingsPatch {
  const touches = patch.engine?.hashMb !== undefined || patch.engine?.depth !== undefined || patch.engine?.multiPv !== undefined
    || patch.moth?.moveTimeMs !== undefined || patch.moth?.ponder !== undefined || patch.performance?.debounceMs !== undefined || patch.performance?.idleSec !== undefined;
  if (!touches || patch.performance?.profile) return patch;
  const next = merge(cur, patch);
  return { ...patch, performance: { ...(patch.performance ?? {}), profile: detectProfile(next) } };
}
