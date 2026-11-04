// React binding for the engine: debounced analysis, start/stop, stale-result rejection, idle shutdown.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Arrow, EngineResult, EngineStatus, Square } from '@/types';
import { getEngine } from '@/engine/worker-transport';
import type { Settings } from '@/settings/schema';
import type { EngineConfig } from '@/types';
import { ARROW_COLORS } from '@/content/arrows/geometry';
import { parseUci, validateFen } from '@/chess/position';
import { logError } from '@/diagnostics/log';

// one error-log subscription per engine instance (several components may share an engine)
const logged = new WeakSet<object>();

export interface AnalysisState {
  result: EngineResult | null;
  status: EngineStatus;
  statusDetail?: string;
  running: boolean;
  start(): void;
  stop(): void;
  reanalyse(): void;
  /** restart an engine that stopped after repeated failures */
  retry(): void;
  engineName: string;
  warnings: string[];
}

/**
 * `enabled` gates automatic analysis (e.g. off when the overlay is minimised, the tab is hidden, or the page is blocked).
 */
export function useAnalysis(fen: string | null, settings: Settings, opts: { enabled?: boolean; depth?: number; multiPv?: number } = {}): AnalysisState {
  const cfg = engineConfigFor(settings);
  const engine = getEngine(cfg, settings.engine.kind);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [status, setStatus] = useState<EngineStatus>(engine.getStatus());
  const [detail, setDetail] = useState<string>();
  const [running, setRunning] = useState(settings.general.autoAnalyse);
  const [nonce, setNonce] = useState(0);
  const searchRef = useRef<number | null>(null);
  const enabled = opts.enabled ?? true;
  const [visible, setVisible] = useState(typeof document === 'undefined' || document.visibilityState === 'visible');

  useEffect(() => {
    const off = engine.onStatus((s, d) => { setStatus(s); setDetail(d); });
    if (!logged.has(engine)) { logged.add(engine); engine.onError((m, fatal) => { void logError(`${engine.engineName}${fatal ? ' (fatal)' : ''}`, m).catch(() => {}); }); }
    return () => { off(); };
  }, [engine]);
  const idleMs = settings.performance.idleSec * 1000;
  useEffect(() => { engine.setIdleMs(idleMs); }, [engine, idleMs]);
  const debounceMs = settings.performance.debounceMs;
  const cfgKey = JSON.stringify(cfg);
  useEffect(() => { void engine.configure(cfg); }, [engine, cfgKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const depth = opts.depth ?? settings.engine.depth;
  const multiPv = opts.multiPv ?? settings.engine.multiPv;
  const moveTimeMs = settings.engine.moveTimeMs;

  useEffect(() => {
    setResult((r) => (r && r.fen === fen ? r : null));
    if (!fen || !running || !enabled || !visible || !validateFen(fen).ok) {
      if (searchRef.current !== null) { engine.cancel(searchRef.current); searchRef.current = null; }
      return;
    }
    // debounce rapid position changes (scrolling through a game, dragging)
    const t = setTimeout(() => {
      // A cache hit calls back synchronously, before `analyse` returns a handle: accept it (it is this request).
      let h: ReturnType<typeof engine.analyse> | null = null;
      h = engine.analyse(fen, { depth, multiPv, moveTimeMs }, (r) => {
        if (!h || searchRef.current === h.searchId) setResult(r);
      });
      searchRef.current = h.searchId;
      const handle = h;
      handle.result.then((r) => { if (searchRef.current === handle.searchId) setResult(r); }).catch(() => {});
    }, debounceMs);
    return () => { clearTimeout(t); if (searchRef.current !== null) { engine.cancel(searchRef.current); searchRef.current = null; } };
  }, [fen, running, enabled, visible, depth, multiPv, moveTimeMs, nonce, engine, debounceMs]);

  const start = useCallback(() => setRunning(true), []);
  const stop = useCallback(() => { setRunning(false); engine.stop(); }, [engine]);
  const reanalyse = useCallback(() => { engine.clearCache(); setRunning(true); setNonce((n) => n + 1); }, [engine]);
  const retry = useCallback(() => { engine.retry(); setRunning(true); setNonce((n) => n + 1); }, [engine]);

  return { result: result && result.fen === fen ? result : null, status, statusDetail: detail, running, start, stop, reanalyse, retry, engineName: engine.engineName, warnings: engine.warnings };
}

export function arrowsFromResult(result: EngineResult | null, settings: Settings, max = 3): Arrow[] {
  if (!result || !settings.visual.arrows) return [];
  const out: Arrow[] = [];
  result.lines.slice(0, Math.max(0, Math.min(3, max))).forEach((l, i) => {
    const u = l.pv[0] && parseUci(l.pv[0]);
    if (!u) return;
    out.push({ from: u.from as Square, to: u.to as Square, color: ARROW_COLORS[i], width: settings.visual.arrowWidth * (i === 0 ? 1.15 : 0.9), opacity: settings.visual.arrowOpacity * (i === 0 ? 1 : 0.8), rank: i });
  });
  return out;
}

/** Engine configuration from settings. MOTH receives its style / model; Stockfish ignores unknown options. */
export function engineConfigFor(settings: Settings): EngineConfig {
  const base = { threads: settings.engine.threads, hashMb: Math.min(settings.engine.hashMb, settings.engine.kind === 'moth' ? 128 : 512) };
  if (settings.engine.kind !== 'moth') return base;
  const style = settings.moth.style[0].toUpperCase() + settings.moth.style.slice(1);
  return { ...base, uci: { Style: style, EvalFile: settings.moth.model, OwnBook: 'false' } };
}
