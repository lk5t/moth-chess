// React binding for the engine: debounced analysis, start/stop, stale-result rejection, idle shutdown.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Arrow, EngineResult, EngineStatus, Square } from '@/types';
import { getEngine } from '@/engine/worker-transport';
import type { Settings } from '@/settings/schema';
import { ARROW_COLORS } from '@/content/arrows/geometry';
import { parseUci, validateFen } from '@/chess/position';

export interface AnalysisState {
  result: EngineResult | null;
  status: EngineStatus;
  statusDetail?: string;
  running: boolean;
  start(): void;
  stop(): void;
  reanalyse(): void;
  engineName: string;
}

/**
 * `enabled` gates automatic analysis (e.g. off when the overlay is minimised, the tab is hidden, or the page is blocked).
 */
export function useAnalysis(fen: string | null, settings: Settings, opts: { enabled?: boolean; depth?: number; multiPv?: number } = {}): AnalysisState {
  const engine = getEngine({ threads: settings.engine.threads, hashMb: settings.engine.hashMb });
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
    return () => { off(); };
  }, [engine]);
  useEffect(() => { void engine.configure({ threads: settings.engine.threads, hashMb: settings.engine.hashMb }); }, [engine, settings.engine.threads, settings.engine.hashMb]);
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
      const h = engine.analyse(fen, { depth, multiPv, moveTimeMs }, (r) => {
        if (searchRef.current === h.searchId) setResult(r);
      });
      searchRef.current = h.searchId;
      h.result.then((r) => { if (searchRef.current === h.searchId) setResult(r); }).catch(() => {});
    }, 140);
    return () => { clearTimeout(t); if (searchRef.current !== null) { engine.cancel(searchRef.current); searchRef.current = null; } };
  }, [fen, running, enabled, visible, depth, multiPv, moveTimeMs, nonce, engine]);

  const start = useCallback(() => setRunning(true), []);
  const stop = useCallback(() => { setRunning(false); engine.stop(); }, [engine]);
  const reanalyse = useCallback(() => { engine.clearCache(); setRunning(true); setNonce((n) => n + 1); }, [engine]);

  return { result: result && result.fen === fen ? result : null, status, statusDetail: detail, running, start, stop, reanalyse, engineName: engine.engineName };
}

export function arrowsFromResult(result: EngineResult | null, settings: Settings): Arrow[] {
  if (!result || !settings.visual.arrows) return [];
  const out: Arrow[] = [];
  result.lines.slice(0, 3).forEach((l, i) => {
    const u = l.pv[0] && parseUci(l.pv[0]);
    if (!u) return;
    out.push({ from: u.from as Square, to: u.to as Square, color: ARROW_COLORS[i], width: settings.visual.arrowWidth * (i === 0 ? 1.15 : 0.9), opacity: settings.visual.arrowOpacity * (i === 0 ? 1 : 0.8), rank: i });
  });
  return out;
}
