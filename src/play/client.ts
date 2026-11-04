// Play-vs-MOTH engine client: a dedicated MOTH worker driven with real UCI move requests
// (`go wtime … btime …` / `go movetime …`), including predictive pondering on the user's time.
// Every move response is timed from the user's move to `bestmove` and recorded as a latency sample.
import { engineUrl } from '@/engine/worker-transport';
import { db, type LatencySample } from '@/memory/db';

export interface Clock { wtime: number; btime: number; winc: number; binc: number }
export interface MoveReply { best: string; ponder?: string; ms: number; source: LatencySample['source']; book?: string; scoreCp?: number; mate?: number; depth?: number }
export interface PlayEngineOptions { style: 'aggressive' | 'balanced' | 'defensive'; skill: number; model: string; ownBook: boolean; prepare?: string }

type LineCb = (l: string) => void;

export class MothPlayClient {
  private w: Worker | null = null;
  private subs = new Set<LineCb>();
  private ready: Promise<void> | null = null;
  private ponder: { key: string; move: string } | null = null;
  private pondering: Promise<string[]> | null = null;
  private busy = false;
  private opts: PlayEngineOptions;
  constructor(opts: PlayEngineOptions) { this.opts = opts; }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.w = new Worker(engineUrl('moth'));
    this.w.onmessage = (e) => { const l = String(e.data ?? ''); this.subs.forEach((cb) => cb(l)); };
    this.ready = (async () => {
      this.send('uci'); await this.until((l) => l === 'uciok');
      this.applyOptions();
      this.send('ucinewgame');
      this.send('isready'); await this.until((l) => l === 'readyok');
    })();
    return this.ready;
  }

  private applyOptions() {
    const o = this.opts;
    this.send(`setoption name Style value ${o.style[0].toUpperCase()}${o.style.slice(1)}`);
    this.send(`setoption name Skill Level value ${o.skill}`);
    this.send(`setoption name EvalFile value ${o.model}`);
    this.send(`setoption name OwnBook value ${o.ownBook}`);
    this.send(`setoption name Prepare value ${o.prepare ?? ''}`);
  }

  async configure(opts: Partial<PlayEngineOptions>) {
    this.opts = { ...this.opts, ...opts };
    if (!this.w) return;
    await this.cancelPonder();
    this.applyOptions();
    this.send('isready'); await this.until((l) => l === 'readyok');
  }

  private send(cmd: string) { this.w?.postMessage(cmd); }
  /** Collect lines until `test` matches (inclusive). */
  private until(test: (l: string) => boolean): Promise<string[]> {
    return new Promise((resolve) => {
      const acc: string[] = [];
      const cb: LineCb = (l) => { acc.push(l); if (test(l)) { this.subs.delete(cb); resolve(acc); } };
      this.subs.add(cb);
    });
  }

  async newGame() {
    await this.start();
    await this.cancelPonder();
    this.send('ucinewgame');
    this.send('isready'); await this.until((l) => l === 'readyok');
  }

  private posCmd(rootFen: string, moves: string[]) { return `position fen ${rootFen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`; }
  private goCmd(clock: Clock | null, movetimeMs: number) {
    return clock ? `go wtime ${Math.max(1, Math.round(clock.wtime))} btime ${Math.max(1, Math.round(clock.btime))} winc ${clock.winc} binc ${clock.binc}` : `go movetime ${movetimeMs}`;
  }

  private parse(lines: string[], t0: number, fallbackSource: LatencySample['source']): MoveReply {
    const bm = lines[lines.length - 1].split(/\s+/);
    let source = fallbackSource, book: string | undefined, scoreCp: number | undefined, mate: number | undefined, depth: number | undefined;
    for (const l of lines) {
      const lat = /^info string latency [\d.]+ (\w+)/.exec(l);
      if (lat && fallbackSource !== 'ponder') source = lat[1] as LatencySample['source'];
      const b = /^info string book (.+)$/.exec(l); if (b) book = b[1];
      const sc = / multipv 1 score (cp|mate) (-?\d+)/.exec(l);
      if (sc) { if (sc[1] === 'cp') { scoreCp = Number(sc[2]); mate = undefined; } else { mate = Number(sc[2]); scoreCp = undefined; } depth = Number(/ depth (\d+)/.exec(l)?.[1] ?? depth); }
    }
    return { best: bm[1], ponder: bm[2] === 'ponder' ? bm[3] : undefined, ms: performance.now() - t0, source, book, scoreCp, mate, depth };
  }

  /**
   * Ask MOTH for its move. If MOTH was pondering on exactly this position, `ponderhit` is sent and the
   * prepared search answers (usually within a few milliseconds); otherwise the ponder search is stopped.
   */
  async requestMove(rootFen: string, moves: string[], clock: Clock | null, movetimeMs: number): Promise<MoveReply> {
    await this.start();
    this.busy = true;
    const t0 = performance.now();
    try {
      const key = `${rootFen}|${moves.join(' ')}`;
      if (this.ponder && this.pondering && this.ponder.key === key) {
        const p = this.pondering;
        this.ponder = null; this.pondering = null;
        this.send('ponderhit');
        const lines = await p;
        const r = this.parse(lines, t0, 'ponder');
        void record({ at: Date.now(), ms: r.ms, source: 'ponder', engine: 'moth', context: 'play' });
        return r;
      }
      await this.cancelPonder();
      this.send(this.posCmd(rootFen, moves));
      const wait = this.until((l) => l.startsWith('bestmove'));
      this.send(this.goCmd(clock, movetimeMs));
      const r = this.parse(await wait, t0, 'search');
      void record({ at: Date.now(), ms: r.ms, source: r.source, engine: 'moth', context: 'play' });
      return r;
    } finally {
      this.busy = false;
    }
  }

  /** Start pondering on the position after `predicted` (MOTH's expected reply by the user). */
  startPonder(rootFen: string, movesIncludingPredicted: string[], clock: Clock | null, movetimeMs: number) {
    if (!this.w || this.busy) return;
    const key = `${rootFen}|${movesIncludingPredicted.join(' ')}`;
    this.ponder = { key, move: movesIncludingPredicted[movesIncludingPredicted.length - 1] };
    this.send(this.posCmd(rootFen, movesIncludingPredicted));
    this.pondering = this.until((l) => l.startsWith('bestmove'));
    this.send(`${this.goCmd(clock, movetimeMs).replace(/^go /, 'go ponder ')}${clock ? '' : ''}`);
  }

  /** Stop a ponder search and discard its result. */
  async cancelPonder() {
    if (!this.pondering) return;
    const p = this.pondering;
    this.ponder = null; this.pondering = null;
    this.send('stop');
    await p;
  }

  terminate() { this.w?.terminate(); this.w = null; this.ready = null; this.pondering = null; this.ponder = null; }
}

async function record(s: LatencySample) {
  try {
    await db().latency.add(s);
    // keep the table bounded
    const n = await db().latency.count();
    if (n > 5000) { const old = await db().latency.orderBy('at').limit(n - 5000).primaryKeys(); await db().latency.bulkDelete(old); }
  } catch { /* storage unavailable: latency is best-effort */ }
}

export { latencyStats } from './stats';
