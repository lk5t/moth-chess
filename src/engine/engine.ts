// Stockfish controller: lifecycle, search queue, stale-result rejection, recovery, idle shutdown.
// Transport-agnostic so the same logic runs against a Web Worker (extension) or a child process (tests).
import type { AnalysisOptions, EngineConfig, EngineLine, EngineResult, EngineStatus } from '@/types';
import { parseBestMove, parseInfo, parseOption, goCommand, type UciOption } from './uci';
import { toWhite } from './normalize';
import { positionKey, turnOf, uciLineToSan, validateFen } from '@/chess/position';
import { LruCache } from '@/utils/lru';

export interface EngineTransport {
  send(cmd: string): void;
  onLine(cb: (line: string) => void): void;
  onError(cb: (err: unknown) => void): void;
  terminate(): void;
}
export type TransportFactory = () => EngineTransport;

export interface EngineOptions {
  idleMs?: number; // terminate the engine after this long without work (0 = never)
  initTimeoutMs?: number;
  stallTimeoutMs?: number; // restart if a running search produces no output for this long
  cacheSize?: number;
  updateIntervalMs?: number;
}

export interface AnalysisHandle {
  searchId: number;
  result: Promise<EngineResult>;
  cancel(): void;
}

interface Search {
  id: number;
  fen: string;
  opts: AnalysisOptions;
  lines: Map<number, EngineLine>;
  depth: number;
  stopped: boolean;
  started: boolean;
  onUpdate?: (r: EngineResult) => void;
  resolve: (r: EngineResult) => void;
  lastEmit: number;
}

type Listener = (s: EngineStatus, detail?: string) => void;
type StringListener = (text: string) => void;

/**
 * UCI engine controller. Originally written for Stockfish; MOTH Engine speaks the same protocol, so
 * both engines share this lifecycle / queue / stale-result / recovery logic.
 */
export class StockfishEngine {
  private transport: EngineTransport | null = null;
  private ready: Promise<void> | null = null;
  private status: EngineStatus = 'idle';
  private listeners = new Set<Listener>();
  private stringListeners = new Set<StringListener>();
  private lineWaiters: { test: (l: string) => boolean; resolve: () => void }[] = [];
  private current: Search | null = null;
  private pending: Search | null = null;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private cache: LruCache<string, EngineResult>;
  private appliedMultiPv = -1;
  private configDirty = false;
  private generation = 0; // bumps on every (re)start so lines from a dead transport are ignored
  engineName = 'Stockfish';
  options = new Map<string, UciOption>();
  restarts = 0;
  lastError?: string;

  constructor(private factory: TransportFactory, private config: EngineConfig = { threads: 1, hashMb: 64 }, private opts: EngineOptions = {}) {
    this.cache = new LruCache(opts.cacheSize ?? 300);
  }

  getStatus() { return this.status; }
  /** `info string …` lines (MOTH reports book moves, cache hits and move latency this way). */
  onInfoString(l: StringListener) { this.stringListeners.add(l); return () => this.stringListeners.delete(l); }
  private optionsTag() { return JSON.stringify(this.config.uci ?? {}); }
  onStatus(l: Listener) { this.listeners.add(l); l(this.status); return () => this.listeners.delete(l); }
  private setStatus(s: EngineStatus, detail?: string) {
    this.status = s;
    this.listeners.forEach((l) => l(s, detail));
  }

  /** Spawn and handshake. Idempotent. */
  init(): Promise<void> {
    if (this.ready) return this.ready;
    const gen = ++this.generation;
    this.setStatus('loading');
    this.ready = new Promise<void>((resolve, reject) => {
      let t: EngineTransport;
      try {
        t = this.factory();
      } catch (e) {
        this.ready = null;
        this.fail(`Engine could not start: ${(e as Error).message}`);
        reject(e);
        return;
      }
      this.transport = t;
      this.appliedMultiPv = -1;
      t.onLine((raw) => { if (gen === this.generation) String(raw).split('\n').forEach((l) => l.trim() && this.handleLine(l.trim())); });
      t.onError((err) => { if (gen === this.generation) this.recover(`Engine crashed: ${String((err as Error)?.message ?? err)}`); });
      const timeout = setTimeout(() => {
        this.ready = null;
        this.fail('Engine did not respond to the UCI handshake');
        reject(new Error('UCI handshake timeout'));
      }, this.opts.initTimeoutMs ?? 20000);
      this.waitFor((l) => l === 'uciok')
        .then(() => {
          this.sendConfig(t);
          t.send('isready');
          return this.waitFor((l) => l === 'readyok');
        })
        .then(() => {
          clearTimeout(timeout);
          this.setStatus('ready');
          resolve();
        });
      t.send('uci');
    });
    return this.ready;
  }

  /** Threads/Hash clamped to what the engine advertises (the lite WASM build reports Threads max 1). */
  private sendConfig(t: EngineTransport) {
    const th = this.options.get('Threads');
    const hs = this.options.get('Hash');
    const threads = Math.max(th?.min ?? 1, Math.min(th?.max ?? this.config.threads, this.config.threads));
    const hash = Math.max(hs?.min ?? 1, Math.min(hs?.max ?? this.config.hashMb, this.config.hashMb));
    if (th) t.send(`setoption name Threads value ${threads}`);
    t.send(`setoption name Hash value ${hash}`);
    for (const [k, v] of Object.entries(this.config.uci ?? {})) if (this.options.has(k)) t.send(`setoption name ${k} value ${v}`);
  }

  effectiveConfig(): EngineConfig {
    const th = this.options.get('Threads');
    return { threads: Math.min(th?.max ?? this.config.threads, this.config.threads), hashMb: this.config.hashMb, uci: this.config.uci };
  }

  private waitFor(test: (l: string) => boolean): Promise<void> {
    return new Promise((resolve) => this.lineWaiters.push({ test, resolve }));
  }

  /** Update threads/hash. Applied immediately if idle, otherwise after the current search. */
  async configure(cfg: Partial<EngineConfig>) {
    const next = { ...this.config, ...cfg };
    const changed = next.threads !== this.config.threads || next.hashMb !== this.config.hashMb || JSON.stringify(next.uci ?? {}) !== JSON.stringify(this.config.uci ?? {});
    this.config = next;
    if (changed) this.cache.clear();
    if (!changed || !this.transport || this.status !== 'ready') { if (changed) this.configDirty = true; return; }
    this.configDirty = false;
    this.sendConfig(this.transport);
    this.transport.send('isready');
    await this.waitFor((l) => l === 'readyok');
  }

  analyse(fen: string, opts: AnalysisOptions, onUpdate?: (r: EngineResult) => void): AnalysisHandle {
    const v = validateFen(fen);
    const id = this.nextId++;
    if (!v.ok || !v.fen) {
      return { searchId: id, result: Promise.reject(new Error(v.error ?? 'Invalid FEN')), cancel() {} };
    }
    const cfen = v.fen;
    const cacheKey = `${positionKey(cfen)}|${opts.multiPv}|${this.optionsTag()}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.depth >= opts.depth && hit.complete) {
      const r = { ...hit, searchId: id, fromCache: true, fen: cfen };
      onUpdate?.(r);
      return { searchId: id, result: Promise.resolve(r), cancel() {} };
    }
    let resolve!: (r: EngineResult) => void;
    const result = new Promise<EngineResult>((res) => (resolve = res));
    const s: Search = { id, fen: cfen, opts, lines: new Map(), depth: 0, stopped: false, started: false, onUpdate, resolve, lastEmit: 0 };
    this.clearIdle();
    if (this.pending) this.finish(this.pending, false); // superseded before it ever started
    if (this.current) {
      this.pending = s;
      this.stopCurrent();
    } else {
      this.pending = s;
      this.startPending();
    }
    return { searchId: id, result, cancel: () => this.cancel(id) };
  }

  /** Cancel a specific search (no-op if it is no longer active). */
  cancel(searchId: number) {
    if (this.pending?.id === searchId) { this.finish(this.pending, false); this.pending = null; }
    if (this.current?.id === searchId) this.stopCurrent();
  }

  /** Stop whatever is running and drop queued work. */
  stop() {
    if (this.pending) { this.finish(this.pending, false); this.pending = null; }
    if (this.current) this.stopCurrent();
  }

  private stopCurrent() {
    const c = this.current;
    if (!c || c.stopped) return;
    c.stopped = true;
    if (c.started && this.transport) {
      this.setStatus('stopping');
      this.transport.send('stop');
    }
  }

  private async startPending() {
    if (this.current || !this.pending) return;
    const s = this.pending;
    this.pending = null;
    this.current = s;
    try {
      await this.init();
    } catch {
      this.finish(s, false);
      this.current = null;
      return;
    }
    if (this.current !== s) return; // replaced while initialising
    if (s.stopped) { this.finish(s, false); this.current = null; this.startPending(); return; }
    const t = this.transport!;
    if (this.configDirty) { this.configDirty = false; this.sendConfig(t); }
    if (this.appliedMultiPv !== s.opts.multiPv) {
      t.send(`setoption name MultiPV value ${s.opts.multiPv}`);
      this.appliedMultiPv = s.opts.multiPv;
    }
    t.send(`position fen ${s.fen}`);
    t.send(goCommand({ depth: s.opts.depth, moveTimeMs: s.opts.moveTimeMs || undefined }));
    s.started = true;
    this.setStatus('thinking');
    this.armStall();
  }

  private handleLine(line: string) {
    if (this.stallTimer) this.armStall();
    if (line.startsWith('id name ')) this.engineName = line.slice(8);
    else if (line.startsWith('info string ')) { const txt = line.slice(12); this.stringListeners.forEach((l) => l(txt)); }
    else if (line.startsWith('option name ')) { const o = parseOption(line); if (o) this.options.set(o.name, o); }
    for (let i = 0; i < this.lineWaiters.length; i++) {
      if (this.lineWaiters[i].test(line)) {
        const w = this.lineWaiters.splice(i, 1)[0];
        w.resolve();
        i--;
      }
    }
    const s = this.current;
    if (!s || !s.started) return;
    if (line.startsWith('info ')) {
      if (s.stopped) return; // stale: search was cancelled, ignore remaining output
      const info = parseInfo(line);
      if (!info || !info.score || info.depth === undefined) return;
      const turn = turnOf(s.fen);
      const { san } = uciLineToSan(s.fen, info.pv);
      if (info.pv.length && san.length === 0) return; // PV not legal in this position → belongs to another search
      const prev = s.lines.get(info.multipv);
      if (info.bound && prev && prev.depth >= info.depth) return; // keep exact scores over bounds at same depth
      s.lines.set(info.multipv, {
        multipv: info.multipv,
        depth: info.depth,
        seldepth: info.seldepth,
        score: info.score,
        whiteScore: toWhite(info.score, turn),
        bound: info.bound,
        pv: info.pv.slice(0, san.length || info.pv.length),
        pvSan: san,
        nodes: info.nodes,
        nps: info.nps,
        timeMs: info.timeMs,
      });
      if (info.multipv === 1) s.depth = info.depth;
      const now = Date.now();
      if (now - s.lastEmit >= (this.opts.updateIntervalMs ?? 120)) {
        s.lastEmit = now;
        s.onUpdate?.(this.snapshot(s, false));
      }
      return;
    }
    const bm = parseBestMove(line);
    if (bm) {
      this.clearStall();
      const complete = !s.stopped;
      const r = this.finish(s, complete, bm.bestMove ?? undefined, bm.ponder);
      if (complete && r.lines.length) this.cache.set(`${positionKey(s.fen)}|${s.opts.multiPv}|${this.optionsTag()}`, r);
      this.current = null;
      this.setStatus('ready');
      if (this.pending) this.startPending();
      else this.armIdle();
    }
  }

  private snapshot(s: Search, complete: boolean, bestMove?: string, ponder?: string): EngineResult {
    const lines = [...s.lines.values()].filter((l) => l.multipv <= s.opts.multiPv).sort((a, b) => a.multipv - b.multipv);
    return { fen: s.fen, searchId: s.id, depth: s.depth, lines, bestMove: bestMove ?? lines[0]?.pv[0], ponder, complete };
  }

  private finish(s: Search, complete: boolean, bestMove?: string, ponder?: string): EngineResult {
    const r = this.snapshot(s, complete, bestMove, ponder);
    s.onUpdate?.(r);
    s.resolve(r);
    s.onUpdate = undefined;
    return r;
  }

  private armStall() {
    this.clearStall();
    const ms = this.opts.stallTimeoutMs ?? 30000;
    if (ms > 0) this.stallTimer = setTimeout(() => this.recover('Engine stopped responding — restarted'), ms);
  }
  private clearStall() { if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; } }

  private armIdle() {
    this.clearIdle();
    const ms = this.opts.idleMs ?? 60000;
    if (ms > 0) this.idleTimer = setTimeout(() => this.terminate('terminated'), ms);
  }
  private clearIdle() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }

  /** Crash/stall recovery: kill transport, resolve the running search as incomplete, restart for queued work. */
  private recover(reason: string) {
    this.lastError = reason;
    this.restarts++;
    const cur = this.current;
    this.killTransport();
    this.setStatus('restarting', reason);
    if (cur) this.finish(cur, false);
    this.current = null;
    if (this.restarts > 5) { this.fail('Engine failed repeatedly; analysis disabled until reload'); return; }
    if (this.pending) this.startPending();
    else this.setStatus('idle', reason);
  }

  private fail(reason: string) {
    this.lastError = reason;
    this.killTransport();
    this.setStatus('error', reason);
  }

  private killTransport() {
    this.generation++;
    this.clearStall();
    this.clearIdle();
    try { this.transport?.terminate(); } catch { /* already gone */ }
    this.transport = null;
    this.ready = null;
    this.lineWaiters = [];
  }

  /** Terminate the engine process (e.g. when idle or the overlay closes). Re-inits lazily. */
  terminate(status: EngineStatus = 'terminated') {
    this.stop();
    if (this.current) { this.finish(this.current, false); this.current = null; }
    this.killTransport();
    this.setStatus(status);
  }

  clearCache() { this.cache.clear(); }
}
