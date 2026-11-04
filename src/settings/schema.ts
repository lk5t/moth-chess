// Settings schema, defaults and validation. Lightweight → chrome.storage.local.

export type Theme = 'dark' | 'light' | 'system';
export type Accent = 'violet' | 'indigo' | 'teal' | 'rose' | 'amber';
export type DetailLevel = 'brief' | 'standard' | 'detailed';

export interface Settings {
  enabled: boolean;
  appearance: { theme: Theme; accent: Accent; overlayOpacity: number; overlayScale: number; animation: number };
  engine: { depth: number; moveTimeMs: number; threads: number; hashMb: number; multiPv: number };
  visual: { arrows: boolean; arrowWidth: number; arrowOpacity: number; threatVision: boolean; squareHighlights: boolean; evalBar: boolean;
    threatLayers: { attacked: boolean; undefended: boolean; hanging: boolean; checks: boolean; pins: boolean; forks: boolean; skewers: boolean; kingSafety: boolean; defences: boolean } };
  intelligence: { detail: DetailLevel; autoSummary: boolean; coachingRecommendations: boolean };
  review: { depth: number };
  general: { startMinimized: boolean; notifications: boolean; autoAnalyse: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  appearance: { theme: 'dark', accent: 'violet', overlayOpacity: 0.97, overlayScale: 1, animation: 1 },
  engine: { depth: 18, moveTimeMs: 0, threads: 1, hashMb: 64, multiPv: 3 },
  visual: {
    arrows: true, arrowWidth: 1, arrowOpacity: 0.85, threatVision: false, squareHighlights: true, evalBar: true,
    threatLayers: { attacked: false, undefended: true, hanging: true, checks: true, pins: true, forks: true, skewers: true, kingSafety: true, defences: false },
  },
  intelligence: { detail: 'standard', autoSummary: true, coachingRecommendations: true },
  review: { depth: 14 },
  general: { startMinimized: false, notifications: true, autoAnalyse: true },
};

export const LIMITS = {
  depth: [1, 30],
  moveTimeMs: [0, 60000],
  // Clamped again by the engine to the `Threads` max it reports (the bundled lite build is single-threaded → 1).
  threads: [1, 8],
  hashMb: [16, 512],
  multiPv: [1, 5],
  overlayOpacity: [0.4, 1],
  overlayScale: [0.75, 1.4],
  animation: [0, 1],
  arrowWidth: [0.5, 2],
  arrowOpacity: [0.2, 1],
  reviewDepth: [8, 22],
} as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};
const int = (v: unknown, r: readonly [number, number], d: number) => Math.round(clamp(v, r, d));
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);

/** Merge arbitrary (possibly corrupt/old) stored data over defaults, validating every field. */
export function validateSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = DEFAULT_SETTINGS;
  const a = r.appearance ?? {}, e = r.engine ?? {}, v = r.visual ?? {}, i = r.intelligence ?? {}, g = r.general ?? {}, rv = r.review ?? {};
  const tl = v.threatLayers ?? {};
  return {
    enabled: bool(r.enabled, d.enabled),
    appearance: {
      theme: oneOf(a.theme, ['dark', 'light', 'system'] as const, d.appearance.theme),
      accent: oneOf(a.accent, ['violet', 'indigo', 'teal', 'rose', 'amber'] as const, d.appearance.accent),
      overlayOpacity: clamp(a.overlayOpacity, LIMITS.overlayOpacity, d.appearance.overlayOpacity),
      overlayScale: clamp(a.overlayScale, LIMITS.overlayScale, d.appearance.overlayScale),
      animation: clamp(a.animation, LIMITS.animation, d.appearance.animation),
    },
    engine: {
      depth: int(e.depth, LIMITS.depth, d.engine.depth),
      moveTimeMs: int(e.moveTimeMs, LIMITS.moveTimeMs, d.engine.moveTimeMs),
      threads: int(e.threads, LIMITS.threads, d.engine.threads),
      hashMb: int(e.hashMb, LIMITS.hashMb, d.engine.hashMb),
      multiPv: int(e.multiPv, LIMITS.multiPv, d.engine.multiPv),
    },
    visual: {
      arrows: bool(v.arrows, d.visual.arrows),
      arrowWidth: clamp(v.arrowWidth, LIMITS.arrowWidth, d.visual.arrowWidth),
      arrowOpacity: clamp(v.arrowOpacity, LIMITS.arrowOpacity, d.visual.arrowOpacity),
      threatVision: bool(v.threatVision, d.visual.threatVision),
      squareHighlights: bool(v.squareHighlights, d.visual.squareHighlights),
      evalBar: bool(v.evalBar, d.visual.evalBar),
      threatLayers: Object.fromEntries(
        Object.entries(d.visual.threatLayers).map(([k, def]) => [k, bool(tl[k], def)]),
      ) as Settings['visual']['threatLayers'],
    },
    intelligence: {
      detail: oneOf(i.detail, ['brief', 'standard', 'detailed'] as const, d.intelligence.detail),
      autoSummary: bool(i.autoSummary, d.intelligence.autoSummary),
      coachingRecommendations: bool(i.coachingRecommendations, d.intelligence.coachingRecommendations),
    },
    review: { depth: int(rv.depth, LIMITS.reviewDepth, d.review.depth) },
    general: {
      startMinimized: bool(g.startMinimized, d.general.startMinimized),
      notifications: bool(g.notifications, d.general.notifications),
      autoAnalyse: bool(g.autoAnalyse, d.general.autoAnalyse),
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type SettingsPatch = DeepPartial<Settings>;

export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const merge = (a: any, b: any): any => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = merge(a?.[k], b[k]);
    return out;
  };
  return validateSettings(merge(base, patch));
}
