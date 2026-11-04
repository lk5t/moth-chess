// Settings schema, defaults and validation. Lightweight → chrome.storage.local.

export type Theme = 'dark' | 'light' | 'system';
export type Accent = 'violet' | 'indigo' | 'teal' | 'rose' | 'amber';
export type DetailLevel = 'brief' | 'standard' | 'detailed';
export type EngineChoice = 'moth' | 'stockfish';
export type MothStyle = 'aggressive' | 'balanced' | 'defensive';
export type ProfileId = 'eco' | 'standard' | 'performance' | 'custom';
export type HudLayout = 'full' | 'compact';
export type EvalBarSide = 'left' | 'right' | 'off';
export type UiMode = 'simple' | 'full';

/** Bumped whenever stored settings need a migration step (see migrateSettings). v2.0 data had no version → 2. */
export const SETTINGS_VERSION = 4;

export interface Settings {
  settingsVersion: number;
  enabled: boolean;
  /** Performance profile; 'custom' once the user changes an engine resource by hand. */
  performance: { profile: ProfileId; debounceMs: number; idleSec: number };
  /** In-page analysis HUD on permitted analysis pages. */
  hud: { layout: HudLayout; evalBar: EvalBarSide; bestMoveSquares: boolean; arrowCount: number; showPv: boolean; showStatus: boolean; avoidBoard: boolean;
    /** stableArrow: draw the arrow once, when the search reaches depthCap, and keep it until the position changes */
    stableArrow: boolean; depthCap: number };
  /** First-run setup. `completed` is the app version that finished onboarding ('' = never). */
  onboarding: { completed: string };
  /** Workspace layout. 'simple' = beginner mode: advanced tools and Engine Lab stay out of the way. */
  ui: { mode: UiMode; lastTab: string; tips: boolean };
  /** Daily check of GitHub Releases for a newer version (notice only; never installs anything). */
  updates: { auto: boolean };
  appearance: { theme: Theme; accent: Accent; overlayOpacity: number; overlayScale: number; animation: number };
  engine: { depth: number; moveTimeMs: number; threads: number; hashMb: number; multiPv: number; kind: EngineChoice; reviewKind: EngineChoice };
  /** MOTH Engine: style shared by analysis, play and on-board suggestions; model = 'builtin' or idb:<id>. */
  moth: { style: MothStyle; model: string; ownBook: boolean; moveTimeMs: number; learning: boolean; ponder: boolean };
  /** On-board suggestions on supported analysis pages. */
  board: { autoOverlay: boolean; autoAnalyse: boolean; compactPanel: boolean };
  visual: { arrows: boolean; arrowWidth: number; arrowOpacity: number; threatVision: boolean; squareHighlights: boolean; evalBar: boolean;
    threatLayers: { attacked: boolean; undefended: boolean; hanging: boolean; checks: boolean; pins: boolean; forks: boolean; skewers: boolean; kingSafety: boolean; defences: boolean } };
  intelligence: { detail: DetailLevel; autoSummary: boolean; coachingRecommendations: boolean };
  review: { depth: number };
  general: { startMinimized: boolean; notifications: boolean; autoAnalyse: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  enabled: true,
  performance: { profile: 'standard', debounceMs: 140, idleSec: 90 },
  hud: { layout: 'full', evalBar: 'left', bestMoveSquares: true, arrowCount: 1, showPv: true, showStatus: true, avoidBoard: true, stableArrow: true, depthCap: 14 },
  onboarding: { completed: '' },
  ui: { mode: 'simple', lastTab: 'home', tips: true },
  updates: { auto: true },
  appearance: { theme: 'dark', accent: 'violet', overlayOpacity: 0.97, overlayScale: 1, animation: 1 },
  engine: { depth: 18, moveTimeMs: 0, threads: 1, hashMb: 64, multiPv: 3, kind: 'moth', reviewKind: 'stockfish' },
  moth: { style: 'balanced', model: 'builtin', ownBook: true, moveTimeMs: 100, learning: true, ponder: true },
  board: { autoOverlay: true, autoAnalyse: true, compactPanel: true },
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
  mothMoveTime: [5, 5000],
  debounceMs: [30, 1000],
  idleSec: [10, 600],
  arrowCount: [0, 3],
  depthCap: [6, 24],
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
  const a = r.appearance ?? {}, e = r.engine ?? {}, v = r.visual ?? {}, i = r.intelligence ?? {}, g = r.general ?? {}, rv = r.review ?? {}, mo = r.moth ?? {}, bo = r.board ?? {};
  const tl = v.threatLayers ?? {};
  const pf = r.performance ?? {}, hu = r.hud ?? {}, ob = r.onboarding ?? {};
  return {
    settingsVersion: SETTINGS_VERSION,
    enabled: bool(r.enabled, d.enabled),
    performance: {
      profile: oneOf(pf.profile, ['eco', 'standard', 'performance', 'custom'] as const, d.performance.profile),
      debounceMs: int(pf.debounceMs, LIMITS.debounceMs, d.performance.debounceMs),
      idleSec: int(pf.idleSec, LIMITS.idleSec, d.performance.idleSec),
    },
    hud: {
      layout: oneOf(hu.layout, ['full', 'compact'] as const, d.hud.layout),
      evalBar: oneOf(hu.evalBar, ['left', 'right', 'off'] as const, d.hud.evalBar),
      bestMoveSquares: bool(hu.bestMoveSquares, d.hud.bestMoveSquares),
      arrowCount: int(hu.arrowCount, LIMITS.arrowCount, d.hud.arrowCount),
      showPv: bool(hu.showPv, d.hud.showPv),
      showStatus: bool(hu.showStatus, d.hud.showStatus),
      avoidBoard: bool(hu.avoidBoard, d.hud.avoidBoard),
      stableArrow: bool(hu.stableArrow, d.hud.stableArrow),
      depthCap: int(hu.depthCap, LIMITS.depthCap, d.hud.depthCap),
    },
    ui: {
      mode: oneOf((r.ui ?? {}).mode, ['simple', 'full'] as const, d.ui.mode),
      lastTab: typeof (r.ui ?? {}).lastTab === 'string' && /^[a-z]{2,16}$/.test(r.ui.lastTab) ? r.ui.lastTab : d.ui.lastTab,
      tips: bool((r.ui ?? {}).tips, d.ui.tips),
    },
    updates: { auto: bool((r.updates ?? {}).auto, d.updates.auto) },
    onboarding: { completed: typeof ob.completed === 'string' && ob.completed.length <= 20 ? ob.completed : d.onboarding.completed },
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
      kind: oneOf(e.kind, ['moth', 'stockfish'] as const, d.engine.kind),
      reviewKind: oneOf(e.reviewKind, ['moth', 'stockfish'] as const, d.engine.reviewKind),
    },
    moth: {
      style: oneOf(mo.style, ['aggressive', 'balanced', 'defensive'] as const, d.moth.style),
      model: typeof mo.model === 'string' && /^(builtin|classical|idb:[\w.-]+|file:[\w.-]+)$/.test(mo.model) ? mo.model : d.moth.model,
      ownBook: bool(mo.ownBook, d.moth.ownBook),
      moveTimeMs: int(mo.moveTimeMs, LIMITS.mothMoveTime, d.moth.moveTimeMs),
      learning: bool(mo.learning, d.moth.learning),
      ponder: bool(mo.ponder, d.moth.ponder),
    },
    board: {
      autoOverlay: bool(bo.autoOverlay, d.board.autoOverlay),
      autoAnalyse: bool(bo.autoAnalyse, d.board.autoAnalyse),
      compactPanel: bool(bo.compactPanel, d.board.compactPanel),
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

export interface MigrationResult { settings: Settings; from: number; changed: string[]; corrupt: boolean }

/**
 * Upgrade stored settings to the current schema without losing user choices.
 * - v2.0 and earlier (no settingsVersion): every existing value is kept. Engine resources that differ from
 *   the old defaults mean the user tuned them, so the profile becomes 'custom' instead of overwriting them.
 *   Users who had already used 2.0 are not shown first-run onboarding again (they get a "what's new" link).
 * - Corrupt input (not an object) falls back to defaults and is reported so the UI can explain it.
 */
export function migrateSettings(raw: unknown): MigrationResult {
  const corrupt = raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw));
  const r = (!corrupt && raw ? raw : {}) as Record<string, any>;
  const from = typeof r.settingsVersion === 'number' ? r.settingsVersion : raw ? 2 : SETTINGS_VERSION;
  const changed: string[] = [];
  const next: Record<string, any> = { ...r };
  if (from < 3) {
    const e = r.engine ?? {}, mo = r.moth ?? {};
    const tuned = (e.hashMb !== undefined && e.hashMb !== 64) || (e.depth !== undefined && e.depth !== 18) || (mo.moveTimeMs !== undefined && mo.moveTimeMs !== 100);
    next.performance = { profile: tuned ? 'custom' : 'standard', debounceMs: 140, idleSec: 90 };
    changed.push(`performance profile → ${next.performance.profile}`);
    // carry the v2.0 eval-bar switch into the HUD
    next.hud = { evalBar: r.visual?.evalBar === false ? 'off' : 'left', layout: 'full' };
    next.onboarding = { completed: raw ? 'pre-2.1' : '' };
    // people upgrading from 2.0 already know every tool: keep the full workspace for them
    next.ui = { mode: raw ? 'full' : 'simple', lastTab: 'analysis', tips: !raw };
    changed.push('HUD settings added', 'onboarding marked as seen (existing install)');
  }
  if (from === 3) {
    // 3.0.1: one steady best-move arrow by default (3.0 showed three arrows that changed while the engine deepened)
    if (r.hud?.arrowCount === 3) { next.hud = { ...r.hud, arrowCount: 1 }; changed.push('arrows: best move only'); }
  }
  const settings = validateSettings(next);
  if (corrupt) changed.push('stored settings were unreadable; defaults restored');
  return { settings, from, changed, corrupt };
}
