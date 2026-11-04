// Web Worker transport for the bundled Stockfish WASM (public/engines/stockfish.js).
import type { EngineTransport, TransportFactory } from './engine';
import { StockfishEngine } from './engine';
import type { EngineConfig } from '@/types';

export function engineUrl(): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) return chrome.runtime.getURL('engines/stockfish.js');
  return new URL('engines/stockfish.js', location.href).toString();
}

export const workerTransport: TransportFactory = (): EngineTransport => {
  const w = new Worker(engineUrl());
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

let shared: StockfishEngine | null = null;
/** One engine per page (lazy — the worker is only spawned on first analysis). */
export function getEngine(config?: EngineConfig): StockfishEngine {
  if (!shared) shared = new StockfishEngine(workerTransport, config, { idleMs: 90_000, stallTimeoutMs: 30_000 });
  else if (config) void shared.configure(config);
  return shared;
}

let batch: StockfishEngine | null = null;
/**
 * Second engine for background jobs (game review, Neural Map growth, What-If comparisons, Coach checks)
 * so they never cancel the live analysis. Small hash; shuts down after 20 s idle.
 */
export function getBatchEngine(): StockfishEngine {
  if (!batch) batch = new StockfishEngine(workerTransport, { threads: 1, hashMb: 16 }, { idleMs: 20_000, stallTimeoutMs: 30_000, cacheSize: 2000 });
  return batch;
}
