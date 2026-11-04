// MOTH Engine Web Worker: hosts the WASM engine and speaks UCI over postMessage (one line per message),
// exactly like the bundled Stockfish worker, so the same controller drives both engines.
// Built as dist/moth-worker.js; assets live under dist/moth-engine/.
import { MothWasm } from './wasm.ts';
import { MothUci } from './uci.ts';
import { decodeModel, type ModelFile } from './model.ts';
import type { OpeningBook } from './book.ts';

declare const self: DedicatedWorkerGlobalScope;

const asset = (p: string) => new URL(`moth-engine/${p}`, self.location.href).toString();

async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Models trained in the extension live in IndexedDB (database `moth-chess`, table `models`). */
function idbModel(id: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open('moth-chess'); } catch { resolve(null); return; }
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const dbh = req.result;
      if (!dbh.objectStoreNames.contains('models')) { dbh.close(); resolve(null); return; }
      const idx = dbh.transaction('models', 'readonly').objectStore('models');
      const q = idx.index ? (() => { try { return idx.index('modelId').get(id); } catch { return idx.get(id); } })() : idx.get(id);
      q.onsuccess = () => { const rec = q.result as { bytes?: ArrayBuffer } | undefined; dbh.close(); resolve(rec?.bytes ?? null); };
      q.onerror = () => { dbh.close(); resolve(null); };
    };
  });
}

async function loadModel(spec: string): Promise<ModelFile | null> {
  let bytes: ArrayBuffer | null = null;
  if (spec === 'builtin') {
    const reg = await fetchBytes(asset('models/registry.json'));
    if (!reg) return null;
    const registry = JSON.parse(new TextDecoder().decode(reg)) as { active?: string; models?: { id: string; file: string }[] };
    const active = registry.models?.find((m) => m.id === registry.active);
    if (!active) return null;
    bytes = await fetchBytes(asset(`models/${active.file}`));
  } else if (spec.startsWith('idb:')) bytes = await idbModel(spec.slice(4));
  else if (spec.startsWith('file:')) bytes = await fetchBytes(asset(`models/${spec.slice(5)}`));
  if (!bytes) return null;
  return decodeModel(bytes);
}

async function loadBook(): Promise<OpeningBook | null> {
  const b = await fetchBytes(asset('book.json'));
  return b ? (JSON.parse(new TextDecoder().decode(b)) as OpeningBook) : null;
}

// Yield to the worker's task queue so `stop` / `ponderhit` posted by the page are processed.
const channel = new MessageChannel();
const resolvers: (() => void)[] = [];
channel.port1.onmessage = () => resolvers.shift()?.();
const yieldNow = () => new Promise<void>((r) => { resolvers.push(r); channel.port2.postMessage(0); });

let uci: MothUci | null = null;
const early: string[] = [];
self.onmessage = (e: MessageEvent) => {
  const text = String(e.data ?? '');
  for (const line of text.split('\n')) {
    if (uci) uci.handle(line);
    else early.push(line);
  }
};

(async () => {
  const wasmBytes = await fetchBytes(asset('moth.wasm'));
  if (!wasmBytes) throw new Error('moth.wasm could not be loaded');
  const engine = await MothWasm.create(wasmBytes, 32);
  uci = new MothUci(engine, {
    emit: (l) => self.postMessage(l),
    now: () => performance.now(),
    yieldNow,
    loadModel,
    loadBook,
  });
  for (const l of early.splice(0)) uci.handle(l);
})().catch((err) => {
  // The controller turns this line into a clear "files are missing or damaged" error and stops (no restart
  // loop). Not rethrown: an uncaught rejection here would surface as a page error.
  self.postMessage(`info string fatal ${String((err as Error)?.message ?? err)}`);
});
