// Thin typed wrapper around the MOTH Engine WebAssembly module. Environment-neutral: used by the
// extension's engine worker and by the Node training / benchmark scripts.
// (Written with erasable TypeScript only, so Node can run it directly with --experimental-strip-types.)

export interface MothExports {
  memory: WebAssembly.Memory;
  mc_io(): number;
  mc_init(hashMb: number): number;
  mc_new_game(): void;
  mc_set_fen(): number;
  mc_play_uci(): number;
  mc_undo(): number;
  mc_get_fen(): number;
  mc_legal_uci(): number;
  mc_uci_to_san(): number;
  mc_san_to_uci(): number;
  mc_side(): number;
  mc_in_check(): number;
  mc_game_state(): number;
  mc_key_lo(): number;
  mc_key_hi(): number;
  mc_perft(depth: number): number;
  mc_eval(): number;
  mc_eval_classical(): number;
  mc_eval_nnue(): number;
  mc_see_uci(): number;
  mc_set_style(s: number): void;
  mc_get_style(): number;
  mc_hashfull(): number;
  mc_nn_buffer(): number;
  mc_nn_b1(): number;
  mc_nn_w2(): number;
  mc_nn_max_hidden(): number;
  mc_nn_set(h: number, b2: number, scale: number): number;
  mc_nn_hidden(): number;
  mc_features(): number;
  mc_search_begin(): void;
  mc_search_iteration(depth: number, multipv: number, deadlineMs: number, nodeBudget: number): number;
  mc_lines(): number;
  mc_line_score(i: number): number;
  mc_line_depth(i: number): number;
  mc_line_pv(i: number): number;
  mc_nodes(): number;
  mc_seldepth(): number;
  mc_mate_value(): number;
  mc_mate_bound(): number;
}

export type GameState = 'ongoing' | 'checkmate' | 'stalemate' | 'fifty-move' | 'repetition' | 'insufficient';
const STATES: GameState[] = ['ongoing', 'checkmate', 'stalemate', 'fifty-move', 'repetition', 'insufficient'];
export type StyleName = 'aggressive' | 'balanced' | 'defensive';
export const STYLE_IDS: Record<StyleName, number> = { aggressive: 0, balanced: 1, defensive: 2 };

export interface NetworkWeights {
  hidden: number;
  w1: Float32Array; // [768][hidden]
  b1: Float32Array; // [hidden]
  w2: Float32Array; // [2*hidden]
  b2: number;
  scale: number; // output units → centipawns
}

export interface RawLine { score: number; depth: number; pv: string[] }

const enc = new TextEncoder();
const dec = new TextDecoder();
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class MothWasm {
  readonly x: MothExports;
  readonly MATE: number;
  readonly MATE_BOUND: number;
  private io: number;

  private constructor(instance: WebAssembly.Instance, hashMb: number) {
    this.x = instance.exports as unknown as MothExports;
    this.x.mc_init(hashMb);
    this.io = this.x.mc_io();
    this.MATE = this.x.mc_mate_value();
    this.MATE_BOUND = this.x.mc_mate_bound();
  }

  static async create(source: BufferSource | WebAssembly.Module, hashMb = 16): Promise<MothWasm> {
    const imports = { env: { now_ms: now } };
    const mod = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    const inst = await WebAssembly.instantiate(mod, imports);
    return new MothWasm(inst, hashMb);
  }

  private write(s: string): void {
    const bytes = enc.encode(s);
    const mem = new Uint8Array(this.x.memory.buffer, this.io, 65536);
    mem.set(bytes.subarray(0, 65535));
    mem[Math.min(bytes.length, 65535)] = 0;
  }
  private read(len: number): string {
    return dec.decode(new Uint8Array(this.x.memory.buffer, this.io, len));
  }

  setFen(fen: string): boolean { this.write(fen); return this.x.mc_set_fen() === 1; }
  play(uci: string): boolean { this.write(uci); return this.x.mc_play_uci() === 1; }
  undo(): boolean { return this.x.mc_undo() === 1; }
  fen(): string { return this.read(this.x.mc_get_fen()); }
  legalMoves(): string[] { this.x.mc_legal_uci(); const s = this.readZ(); return s ? s.trim().split(' ') : []; }
  uciToSan(uci: string): string | null { this.write(uci); const n = this.x.mc_uci_to_san(); return n ? this.read(n) : null; }
  sanToUci(san: string): string | null { this.write(san); const n = this.x.mc_san_to_uci(); return n ? this.read(n) : null; }
  sideToMove(): 'w' | 'b' { return this.x.mc_side() === 0 ? 'w' : 'b'; }
  inCheck(): boolean { return this.x.mc_in_check() === 1; }
  gameState(): GameState { return STATES[this.x.mc_game_state()] ?? 'ongoing'; }
  /** 64-bit Zobrist key as a 16-char hex string. */
  key(): string { return (this.x.mc_key_hi() >>> 0).toString(16).padStart(8, '0') + (this.x.mc_key_lo() >>> 0).toString(16).padStart(8, '0'); }
  perft(depth: number): number { return this.x.mc_perft(depth); }
  evaluate(): { total: number; classical: number; nnue: number } { return { total: this.x.mc_eval(), classical: this.x.mc_eval_classical(), nnue: this.x.mc_eval_nnue() }; }
  see(uci: string): number { this.write(uci); return this.x.mc_see_uci(); }
  setStyle(style: StyleName): void { this.x.mc_set_style(STYLE_IDS[style]); }
  newGame(): void { this.x.mc_new_game(); }
  hashfull(): number { return this.x.mc_hashfull(); }

  /** Active NNUE input features of the current position for both perspectives. */
  features(): { white: Int32Array; black: Int32Array } {
    const n = this.x.mc_features();
    const v = new Int32Array(this.x.memory.buffer, this.io, 1 + 2 * n);
    return { white: v.slice(1, 1 + n), black: v.slice(1 + n, 1 + 2 * n) };
  }

  loadNetwork(w: NetworkWeights | null): void {
    if (!w) { this.x.mc_nn_set(0, 0, 100); return; }
    if (w.hidden > this.x.mc_nn_max_hidden()) throw new Error(`network too wide (${w.hidden} > ${this.x.mc_nn_max_hidden()})`);
    if (w.w1.length !== 768 * w.hidden || w.b1.length !== w.hidden || w.w2.length !== 2 * w.hidden) throw new Error('network shape mismatch');
    const buf = this.x.memory.buffer;
    new Float32Array(buf, this.x.mc_nn_buffer(), w.w1.length).set(w.w1);
    new Float32Array(buf, this.x.mc_nn_b1(), w.hidden).set(w.b1);
    new Float32Array(buf, this.x.mc_nn_w2(), 2 * w.hidden).set(w.w2);
    this.x.mc_nn_set(w.hidden, w.b2, w.scale);
  }
  networkHidden(): number { return this.x.mc_nn_hidden(); }

  beginSearch(): void { this.x.mc_search_begin(); }
  /** One iterative-deepening iteration. Returns true if it completed before the deadline / node budget. */
  iterate(depth: number, multipv: number, deadlineMs: number, nodeBudget = 0): boolean {
    return this.x.mc_search_iteration(depth, multipv, deadlineMs, nodeBudget) === 1;
  }
  lines(): RawLine[] {
    const out: RawLine[] = [];
    for (let i = 0; i < this.x.mc_lines(); i++) {
      const n = this.x.mc_line_pv(i);
      out.push({ score: this.x.mc_line_score(i), depth: this.x.mc_line_depth(i), pv: n ? this.read(n).split(' ') : [] });
    }
    return out;
  }
  nodes(): number { return this.x.mc_nodes(); }
  seldepth(): number { return this.x.mc_seldepth(); }

  /** Convert an internal score to UCI {cp|mate} from the side to move's perspective. */
  uciScore(score: number): { type: 'cp' | 'mate'; value: number } {
    if (score > this.MATE_BOUND) return { type: 'mate', value: Math.ceil((this.MATE - score) / 2) };
    if (score < -this.MATE_BOUND) return { type: 'mate', value: -Math.ceil((this.MATE + score) / 2) };
    return { type: 'cp', value: score };
  }

  /**
   * Synchronous time/depth-limited search (used by Node scripts and for move requests).
   * Always returns a legal move when one exists, even if the very first iteration times out.
   */
  search(opts: { depth?: number; movetimeMs?: number; nodes?: number; multipv?: number }): { lines: RawLine[]; depth: number; nodes: number; timeMs: number; bestMove: string | null } {
    const t0 = now();
    const maxDepth = opts.depth ?? 64;
    const deadline = opts.movetimeMs ? t0 + opts.movetimeMs : 0;
    this.beginSearch();
    let completed = 0;
    for (let d = 1; d <= maxDepth; d++) {
      const ok = this.iterate(d, opts.multipv ?? 1, deadline, opts.nodes ? Math.max(0, opts.nodes - this.nodes()) : 0);
      if (!ok) break;
      completed = d;
      if (deadline && now() >= deadline) break;
      if (opts.nodes && this.nodes() >= opts.nodes) break;
      const l0 = this.lines()[0];
      if (l0 && Math.abs(l0.score) > this.MATE_BOUND && d >= 2 * (this.MATE - Math.abs(l0.score)) + 2) break; // shortest mate proven
    }
    const lines = this.lines();
    let bestMove = lines[0]?.pv[0] ?? null;
    if (!bestMove) bestMove = this.legalMoves()[0] ?? null; // legal fallback
    return { lines, depth: completed, nodes: this.nodes(), timeMs: now() - t0, bestMove };
  }

  private readZ(): string {
    const mem = new Uint8Array(this.x.memory.buffer, this.io, 65536);
    let n = 0; while (n < 65536 && mem[n] !== 0) n++;
    return dec.decode(mem.subarray(0, n));
  }
}
