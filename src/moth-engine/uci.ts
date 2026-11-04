// MOTH Engine UCI front end. Environment-neutral: the extension wraps it in a Web Worker, tests and
// the Node tools drive it directly. Speaks standard UCI so the existing engine controller (built for
// Stockfish) can drive MOTH unchanged.
//
// Search modes
//   analysis  `go infinite` / `go depth N` — MultiPV lines, iterations run in time slices so `stop`
//             is honoured within a few hundred milliseconds even though WASM search is synchronous
//   move      `go movetime N` / `go wtime … btime …` — returns the strongest legal move inside the
//             budget: opening book → position cache → time-managed search → legal fallback
//   ponder    `go ponder …` — searches the predicted position until `ponderhit` / `stop`
import { MothWasm, type StyleName, type RawLine } from './wasm.ts';
import { chooseBookMove, lookup, type OpeningBook } from './book.ts';
import type { ModelFile } from './model.ts';

export interface UciIO {
  emit(line: string): void;
  now(): number;
  /** yield to the event loop so `stop` / `ponderhit` messages can be delivered */
  yieldNow(): Promise<void>;
  loadModel(spec: string): Promise<ModelFile | null>;
  loadBook(): Promise<OpeningBook | null>;
  random?: () => number;
}

interface Options {
  hash: number;
  multiPv: number;
  style: StyleName;
  skill: number;
  ownBook: boolean;
  evalFile: string;
  moveOverhead: number;
  slowMover: number;
}

interface GoParams {
  depth?: number; movetime?: number; nodes?: number; infinite: boolean; ponder: boolean;
  wtime?: number; btime?: number; winc?: number; binc?: number; movestogo?: number;
}

interface CacheEntry { lines: RawLine[]; depth: number; multipv: number; style: StyleName; model: string; at: number }

export const ENGINE_NAME = 'MOTH Engine 2.0';

export class MothUci {
  private opts: Options = { hash: 32, multiPv: 1, style: 'balanced', skill: 20, ownBook: true, evalFile: 'builtin', moveOverhead: 10, slowMover: 100 };
  private book: OpeningBook | null = null;
  private model: ModelFile | null = null;
  private modelId = 'classical';
  private ready: Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private searching = false;
  private stopFlag = false;
  private ponderFlag = false;
  private ponderHitAt = 0;
  private positionFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  private positionMoves: string[] = [];
  private cache = new Map<string, CacheEntry>();
  private depthForBudget = new Map<number, number>(); // rolling estimate of the depth a budget reaches
  /** personal opponent preparation: book position key → preferred (sound) move */
  private prepare = new Map<string, string>();
  stats = { searches: 0, bookMoves: 0, cacheHits: 0 };

  private engine: MothWasm;
  private io: UciIO;

  constructor(engine: MothWasm, io: UciIO) {
    this.engine = engine;
    this.io = io;
    this.ready = this.applyEvalFile('builtin').then(() => this.io.loadBook()).then((b) => { this.book = b; }).catch((e) => {
      this.io.emit(`info string init warning ${String((e as Error)?.message ?? e)}`);
    });
  }

  /** Feed one line of UCI input. */
  handle(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    const cmd = line.split(/\s+/)[0];
    // immediate commands (must work while a search is running)
    if (cmd === 'stop') { this.stopFlag = true; return; }
    if (cmd === 'ponderhit') { this.ponderFlag = false; this.ponderHitAt = this.io.now(); return; }
    if (cmd === 'isready') { this.chain = this.chain.then(() => this.ready).then(() => this.io.emit('readyok')); return; }
    if (cmd === 'quit') { this.stopFlag = true; return; }
    this.chain = this.chain.then(() => this.ready).then(() => this.run(line)).catch((e) => this.io.emit(`info string error ${String((e as Error)?.message ?? e)}`));
  }

  private async run(line: string) {
    const t = line.split(/\s+/);
    switch (t[0]) {
      case 'uci':
        this.io.emit(`id name ${ENGINE_NAME}`);
        this.io.emit('id author MOTH Chess');
        this.io.emit('option name Hash type spin default 32 min 1 max 256');
        this.io.emit('option name Threads type spin default 1 min 1 max 1');
        this.io.emit('option name MultiPV type spin default 1 min 1 max 8');
        this.io.emit('option name Style type combo default Balanced var Aggressive var Balanced var Defensive');
        this.io.emit('option name Skill Level type spin default 20 min 0 max 20');
        this.io.emit('option name OwnBook type check default true');
        this.io.emit('option name EvalFile type string default builtin');
        this.io.emit('option name Move Overhead type spin default 10 min 0 max 500');
        this.io.emit('option name Ponder type check default false');
        this.io.emit('option name Prepare type string default <empty>');
        this.io.emit('uciok');
        break;
      case 'ucinewgame':
        this.engine.newGame();
        this.cache.clear();
        break;
      case 'setoption': await this.setOption(line); break;
      case 'position': this.setPosition(t); break;
      case 'go': await this.go(this.parseGo(t)); break;
      case 'eval': {
        this.applyPosition();
        const e = this.engine.evaluate();
        this.io.emit(`info string eval total ${e.total} classical ${e.classical} nnue ${e.nnue} model ${this.modelId}`);
        break;
      }
      case 'd': this.applyPosition(); this.io.emit(`info string fen ${this.engine.fen()} key ${this.engine.key()}`); break;
      default: this.io.emit(`info string unknown command ${t[0]}`);
    }
  }

  private async setOption(line: string) {
    const m = /^setoption name (.+?)(?: value (.*))?$/.exec(line.trim());
    if (!m) return;
    const name = m[1].toLowerCase(), value = (m[2] ?? '').trim();
    const int = (lo: number, hi: number, d: number) => { const v = Number(value); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d; };
    switch (name) {
      case 'hash': this.opts.hash = int(1, 256, 32); this.engine.x.mc_init(this.opts.hash); this.cache.clear(); break;
      case 'multipv': this.opts.multiPv = int(1, 8, 1); break;
      case 'style': {
        const s = value.toLowerCase();
        const next: StyleName = s.startsWith('agg') ? 'aggressive' : s.startsWith('def') ? 'defensive' : 'balanced';
        if (next !== this.opts.style) { this.opts.style = next; this.engine.setStyle(next); this.engine.newGame(); }
        break;
      }
      case 'skill level': this.opts.skill = int(0, 20, 20); break;
      case 'ownbook': this.opts.ownBook = value === 'true'; break;
      case 'move overhead': this.opts.moveOverhead = int(0, 500, 10); break;
      case 'evalfile': await this.applyEvalFile(value || 'builtin'); break;
      case 'prepare': {
        this.prepare.clear();
        for (const pair of value.split(';')) { const [k, mv] = pair.split('='); if (k && mv && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(mv)) this.prepare.set(k.replace(/_/g, ' '), mv); }
        break;
      }
      case 'ponder': case 'threads': break;
    }
  }

  private async applyEvalFile(spec: string) {
    this.opts.evalFile = spec;
    if (spec === 'none' || spec === 'classical') { this.engine.loadNetwork(null); this.model = null; this.modelId = 'classical'; }
    else {
      const f = await this.io.loadModel(spec);
      if (f) { this.engine.loadNetwork(f.weights); this.model = f; this.modelId = f.meta.id; }
      else { this.engine.loadNetwork(null); this.model = null; this.modelId = 'classical'; if (spec !== 'builtin') this.io.emit(`info string model ${spec} not found, using classical evaluation`); }
    }
    this.engine.newGame();
    this.cache.clear();
    this.io.emit(`info string model ${this.modelId}`);
  }

  private setPosition(t: string[]) {
    let i = 1;
    if (t[i] === 'startpos') { this.positionFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'; i++; }
    else if (t[i] === 'fen') { const j = t.indexOf('moves'); this.positionFen = t.slice(i + 1, j < 0 ? undefined : j).join(' '); i = j < 0 ? t.length : j; }
    this.positionMoves = t[i] === 'moves' ? t.slice(i + 1) : [];
  }

  /** Load the position into the engine. Illegal input never reaches the search. */
  private applyPosition(): boolean {
    if (!this.engine.setFen(this.positionFen)) { this.io.emit(`info string invalid position ${this.positionFen}`); return false; }
    for (const mv of this.positionMoves) {
      if (!this.engine.play(mv)) { this.io.emit(`info string illegal move ${mv} ignored (and the rest of the list)`); break; }
    }
    return true;
  }

  private parseGo(t: string[]): GoParams {
    const g: GoParams = { infinite: false, ponder: false };
    for (let i = 1; i < t.length; i++) {
      const k = t[i], v = Number(t[i + 1]);
      if (k === 'infinite') g.infinite = true;
      else if (k === 'ponder') g.ponder = true;
      else if (k === 'depth') { g.depth = v; i++; }
      else if (k === 'movetime') { g.movetime = v; i++; }
      else if (k === 'nodes') { g.nodes = v; i++; }
      else if (k === 'wtime') { g.wtime = v; i++; }
      else if (k === 'btime') { g.btime = v; i++; }
      else if (k === 'winc') { g.winc = v; i++; }
      else if (k === 'binc') { g.binc = v; i++; }
      else if (k === 'movestogo') { g.movestogo = v; i++; }
    }
    return g;
  }

  private cacheKey(multipv: number) { return `${this.engine.key()}|${multipv}|${this.opts.style}|${this.modelId}`; }

  private emitLines(lines: RawLine[], depth: number, t0: number) {
    const ms = Math.max(1, Math.round(this.io.now() - t0));
    const nodes = Math.round(this.engine.nodes());
    lines.forEach((l, i) => {
      const sc = this.engine.uciScore(l.score);
      this.io.emit(`info depth ${l.depth || depth} seldepth ${Math.max(this.engine.seldepth(), l.depth)} multipv ${i + 1} score ${sc.type} ${sc.value} nodes ${nodes} nps ${Math.round((nodes * 1000) / ms)} hashfull ${this.engine.hashfull()} time ${ms} pv ${l.pv.join(' ')}`);
    });
  }

  private async go(g: GoParams) {
    const t0 = this.io.now();
    this.stopFlag = false;
    this.ponderFlag = g.ponder;
    this.searching = true;
    this.stats.searches++;
    try {
      if (!this.applyPosition()) { this.io.emit('bestmove 0000'); return; }
      const legal = this.engine.legalMoves();
      if (!legal.length) { this.io.emit(`info depth 0 score ${this.engine.inCheck() ? 'mate 0' : 'cp 0'}`); this.io.emit('bestmove (none)'); return; }

      const side = this.engine.sideToMove();
      const clock = side === 'w' ? g.wtime : g.btime;
      const inc = (side === 'w' ? g.winc : g.binc) ?? 0;
      const moveMode = !g.infinite && !g.ponder && (g.movetime !== undefined || clock !== undefined);
      let budget = g.movetime ?? 0;
      if (clock !== undefined && g.movetime === undefined) {
        const mtg = g.movestogo ?? 30;
        budget = Math.min(clock / mtg + inc * 0.8, clock * 0.4) - this.opts.moveOverhead;
      }
      budget = Math.max(moveMode ? 2 : 0, budget);
      const ponderBudget = Math.max(2, budget || 100);

      // 1. opening book (move requests only: analysis always shows real engine lines)
      if (moveMode && this.opts.ownBook && this.book) {
        const fenNow = this.engine.fen();
        const pos = lookup(this.book, fenNow);
        const prepMove = this.prepare.get(fenNow.split(' ').slice(0, 4).join(' '));
        const pick = chooseBookMove(pos, this.opts.style, this.io.random ?? Math.random, prepMove ? (m) => (m.uci === prepMove ? 4 : 0) : undefined);
        if (pick && legal.includes(pick.uci)) {
          this.stats.bookMoves++;
          const ms = this.io.now() - t0;
          this.io.emit(`info depth ${pick.depth} multipv 1 score cp ${pick.eval} nodes 0 time ${Math.round(ms)} pv ${pick.uci}`);
          this.io.emit(`info string book ${pick.san}${pick.name ? ` (${pick.name})` : ''}`);
          this.io.emit(`info string latency ${ms.toFixed(2)} book`);
          this.io.emit(`bestmove ${pick.uci}`);
          return;
        }
      }

      const skill = this.opts.skill;
      const multipv = moveMode ? (skill < 20 ? 4 : 1) : Math.min(this.opts.multiPv, legal.length);
      const maxDepth = Math.min(g.depth ?? 64, moveMode && skill < 20 ? 1 + Math.ceil(skill / 2) : 64);

      // 2. position cache (also what makes pondering pay off)
      const key = this.cacheKey(multipv);
      const hit = this.cache.get(key);
      const wantDepth = moveMode ? Math.min(maxDepth, this.depthForBudget.get(Math.round(budget)) ?? 8) : g.depth ?? Infinity;
      if (hit && hit.lines.length && hit.depth >= wantDepth && !g.ponder) {
        this.stats.cacheHits++;
        this.emitLines(hit.lines, hit.depth, t0);
        const ms = this.io.now() - t0;
        this.io.emit(`info string latency ${ms.toFixed(2)} cache`);
        this.io.emit(`bestmove ${this.pickMove(hit.lines, moveMode)}`);
        return;
      }

      // 3. iterative deepening
      this.engine.beginSearch();
      const hardDeadline = moveMode ? t0 + budget : 0;
      const soft = budget * 0.45;
      let completedDepth = 0, lines: RawLine[] = [], stable = 0, lastBest = '';
      let slice = 120;
      for (let d = 1; d <= maxDepth; ) {
        if (this.stopFlag) break;
        if (g.ponder && this.ponderHitAt) {
          // ponderhit: from now on we are on the clock with the budget of the original `go ponder`.
          // If pondering already reached the depth this budget normally buys, answer immediately.
          const since = this.io.now() - this.ponderHitAt;
          const target = this.depthForBudget.get(Math.round(ponderBudget)) ?? 9;
          if (completedDepth >= target || since >= ponderBudget || (since > ponderBudget * 0.45 && stable >= 2)) break;
        }
        const iterStart = this.io.now();
        const pSlice = g.ponder ? Math.min(slice, 30) : slice; // short slices while pondering → fast ponderhit
        const sliceEnd = moveMode ? hardDeadline : g.ponder && this.ponderHitAt ? Math.min(this.ponderHitAt + ponderBudget, this.io.now() + pSlice) : this.io.now() + pSlice;
        const ok = this.engine.iterate(d, multipv, sliceEnd, g.nodes ? Math.max(1, g.nodes - this.engine.nodes()) : 0);
        const got = this.engine.lines();
        if (got.length) lines = got;
        if (ok) {
          completedDepth = d;
          this.emitLines(lines, d, t0);
          const best = lines[0]?.pv[0] ?? '';
          stable = best === lastBest ? stable + 1 : 0;
          lastBest = best;
          d++;
          slice = 120;
          const l0 = lines[0];
          if (l0 && Math.abs(l0.score) > this.engine.MATE_BOUND && d > 2 * (this.engine.MATE - Math.abs(l0.score)) + 2 && !g.infinite) break;
          if (g.nodes && this.engine.nodes() >= g.nodes) break;
          if (moveMode) {
            const nowMs = this.io.now(), el = nowMs - t0, iterMs = nowMs - iterStart;
            if (el >= budget) break;
            // stability-based early answer: the best move survived several deeper iterations
            if (el > soft * 0.5 && stable >= 3 && d > 6) break;
            if (el > soft && stable >= 2) break;
            // the next iteration typically costs ~2-3x the previous one; don't start what can't finish
            if (el + iterMs * 2.2 > budget) break;
          }
        } else {
          if (moveMode) break; // hard deadline reached
          if (g.nodes && this.engine.nodes() >= g.nodes) break;
          slice = Math.min(slice * 2, 1000); // slice expired: resume the same depth (TT keeps the work)
        }
        if (!moveMode) await this.io.yieldNow();
      }
      // `go infinite` / ponder: UCI requires waiting for stop before bestmove
      while ((g.infinite || this.ponderFlag) && !this.stopFlag) await this.io.yieldNow();

      if (!lines.length) lines = [{ score: 0, depth: 0, pv: [legal[0]] }]; // legal fallback
      if (completedDepth > 0) {
        this.cache.set(key, { lines, depth: completedDepth, multipv, style: this.opts.style, model: this.modelId, at: Date.now() });
        if (this.cache.size > 4096) this.cache.delete(this.cache.keys().next().value as string);
        if (moveMode) this.depthForBudget.set(Math.round(budget), completedDepth);
      }
      const ms = this.io.now() - t0;
      if (moveMode) this.io.emit(`info string latency ${ms.toFixed(2)} search`);
      else if (g.ponder && this.ponderHitAt) this.io.emit(`info string latency ${(this.io.now() - this.ponderHitAt).toFixed(2)} ponder`);
      const best = this.pickMove(lines, moveMode);
      this.io.emit(`bestmove ${legal.includes(best) ? best : legal[0]}${lines[0]?.pv[1] ? ` ponder ${lines[0].pv[1]}` : ''}`);
    } finally {
      this.searching = false;
      this.ponderFlag = false;
      this.ponderHitAt = 0;
    }
  }

  /** Skill < 20: choose among the MultiPV candidates with evaluation noise (never an illegal move). */
  private pickMove(lines: RawLine[], moveMode: boolean): string {
    if (!moveMode || this.opts.skill >= 20 || lines.length < 2) return lines[0]?.pv[0] ?? '0000';
    const rnd = this.io.random ?? Math.random;
    const sd = (20 - this.opts.skill) * 14;
    let best = lines[0], bestNoisy = -Infinity;
    for (const l of lines) {
      if (!l.pv[0]) continue;
      // a forced mate for us is never thrown away; noise applies to normal scores only
      const base = Math.abs(l.score) > this.engine.MATE_BOUND ? l.score : l.score + gauss(rnd) * sd;
      if (base > bestNoisy) { bestNoisy = base; best = l; }
    }
    return best.pv[0];
  }

  get isSearching() { return this.searching; }
  get activeModel() { return this.modelId; }
  get options() { return { ...this.opts }; }
}

function gauss(r: () => number) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
