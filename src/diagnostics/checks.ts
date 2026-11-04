// Self-checks run on demand from the Control Center: start each bundled engine in a fresh worker, analyse
// the starting position briefly, measure startup and first-result times, then shut the worker down.
import { StockfishEngine } from '@/engine/engine';
import { makeWorkerTransport } from '@/engine/worker-transport';
import { START_FEN } from '@/chess/position';
import type { EngineKind } from '@/types';

export interface CheckResult { name: string; ok: boolean; detail: string; ms?: number }

export async function engineCheck(kind: EngineKind, timeoutMs = 20000): Promise<CheckResult> {
  const name = kind === 'moth' ? 'MOTH Engine' : 'Stockfish';
  const e = new StockfishEngine(makeWorkerTransport(kind), { threads: 1, hashMb: 16 }, { idleMs: 0, initTimeoutMs: timeoutMs, maxConsecutiveFailures: 1 });
  e.engineName = name;
  const t0 = performance.now();
  try {
    await Promise.race([e.init(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    const tInit = performance.now() - t0;
    const t1 = performance.now();
    const r = await e.analyse(START_FEN, { depth: kind === 'moth' ? 8 : 10, multiPv: 1 }).result;
    const tSearch = performance.now() - t1;
    const ok = r.complete && !!r.bestMove;
    return { name, ok, ms: tInit + tSearch, detail: ok ? `started in ${tInit.toFixed(0)} ms; depth ${r.depth} in ${tSearch.toFixed(0)} ms (best ${r.bestMove})${e.warnings.length ? `; warning: ${e.warnings[0]}` : ''}` : (e.lastError ?? 'no result') };
  } catch (err) {
    return { name, ok: false, detail: e.lastError ?? String((err as Error)?.message ?? err) };
  } finally {
    e.terminate();
  }
}

export async function storageCheck(): Promise<CheckResult> {
  try {
    const k = 'moth.selfcheck';
    await chrome.storage.local.set({ [k]: Date.now() });
    await chrome.storage.local.remove(k);
    const idb = await new Promise<boolean>((res) => { try { const r = indexedDB.open('moth-chess'); r.onsuccess = () => { r.result.close(); res(true); }; r.onerror = () => res(false); } catch { res(false); } });
    return { name: 'Local storage', ok: idb, detail: idb ? 'settings storage and IndexedDB writable' : 'IndexedDB unavailable (private window or blocked site data?)' };
  } catch (err) {
    return { name: 'Local storage', ok: false, detail: String((err as Error)?.message ?? err) };
  }
}
