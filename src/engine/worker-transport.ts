// Web Worker transports for the bundled engines: Stockfish WASM (public/engines/stockfish.js) and
// MOTH Engine (dist/moth-worker.js + public/moth-engine/). Both speak UCI, one line per message.
import type { EngineTransport, TransportFactory } from './engine';
import { StockfishEngine } from './engine';
import type { EngineConfig, EngineKind } from '@/types';

function extUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) return chrome.runtime.getURL(path);
  return new URL(path, location.href).toString();
}
export function engineUrl(kind: EngineKind = 'stockfish'): string {
  return extUrl(kind === 'moth' ? 'moth-worker.js' : 'engines/stockfish.js');
}

export function makeWorkerTransport(kind: EngineKind): TransportFactory {
  return (): EngineTransport => {
    const w = new Worker(engineUrl(kind));
    const lineCbs: ((l: string) => void)[] = [];
    const errCbs: ((e: unknown) => void)[] = [];
    w.onmessage = (e: MessageEvent) => {
      const data = typeof e.data === 'string' ? e.data : String(e.data ?? '');
      lineCbs.forEach((cb) => cb(data));
    };
    w.onerror = (e) => { e.preventDefault?.(); errCbs.forEach((cb) => cb(new Error(e.message || 'worker error'))); };
    w.onmessageerror = () => errCbs.forEach((cb) => cb(new Error('worker message error')));
    return {
      send: (cmd) => w.postMessage(cmd),
      onLine: (cb) => lineCbs.push(cb),
      onError: (cb) => errCbs.push(cb),
      terminate: () => w.terminate(),
    };
  };
}
export const workerTransport: TransportFactory = makeWorkerTransport('stockfish');

const shared = new Map<EngineKind, StockfishEngine>();
/** One live-analysis engine per kind per page (lazy — the worker is only spawned on first analysis). */
export function getEngine(config?: EngineConfig, kind: EngineKind = 'stockfish'): StockfishEngine {
  let e = shared.get(kind);
  if (!e) {
    e = new StockfishEngine(makeWorkerTransport(kind), config, { idleMs: 90_000, stallTimeoutMs: 30_000 });
    if (kind === 'moth') e.engineName = 'MOTH Engine';
    shared.set(kind, e);
  } else if (config) void e.configure(config);
  // only one live engine runs at a time: switching engines frees the other worker
  for (const [k, other] of shared) if (k !== kind && other.getStatus() !== 'terminated' && other.getStatus() !== 'idle') other.terminate();
  return e;
}

const batch = new Map<EngineKind, StockfishEngine>();
/**
 * Second engine for background jobs (game review, Neural Map growth, What-If comparisons, Coach checks)
 * so they never cancel the live analysis. Small hash; shuts down after 20 s idle.
 */
export function getBatchEngine(kind: EngineKind = 'stockfish', uci?: Record<string, string>): StockfishEngine {
  let e = batch.get(kind);
  if (!e) {
    e = new StockfishEngine(makeWorkerTransport(kind), { threads: 1, hashMb: 16, uci }, { idleMs: 20_000, stallTimeoutMs: 30_000, cacheSize: 2000 });
    if (kind === 'moth') e.engineName = 'MOTH Engine';
    batch.set(kind, e);
  } else if (uci) void e.configure({ uci });
  return e;
}
