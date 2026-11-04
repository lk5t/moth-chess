// Stockfish teacher pool (Node only): labels positions with a stronger engine's evaluation, runs
// Stockfish matches and multi-move evaluations for book validation. One child process per core.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';

export function stockfishPath(): string {
  for (const p of [process.env.STOCKFISH_JS, 'node_modules/stockfish/src/stockfish-17.1-lite-single-03e3232.js', 'public/engines/stockfish.js', '/home/claude/data/sf/stockfish.js']) if (p && existsSync(p)) return p;
  throw new Error('Stockfish JS build not found (set STOCKFISH_JS)');
}

export class UciProcess {
  private p: ChildProcessWithoutNullStreams;
  private buf = '';
  private waiters: { test: (l: string) => boolean; resolve: (lines: string[]) => void; lines: string[] }[] = [];
  constructor(file = stockfishPath()) {
    this.p = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d: string) => {
      this.buf += d;
      const parts = this.buf.split('\n');
      this.buf = parts.pop() ?? '';
      for (const raw of parts) {
        const l = raw.trim();
        if (!l) continue;
        const w = this.waiters[0];
        if (!w) continue;
        w.lines.push(l);
        if (w.test(l)) { this.waiters.shift(); w.resolve(w.lines); }
      }
    });
  }
  send(cmd: string) { this.p.stdin.write(cmd + '\n'); }
  until(test: (l: string) => boolean): Promise<string[]> { return new Promise((resolve) => this.waiters.push({ test, resolve, lines: [] })); }
  async init(opts: Record<string, string> = {}) {
    this.send('uci'); await this.until((l) => l === 'uciok');
    for (const [k, v] of Object.entries(opts)) this.send(`setoption name ${k} value ${v}`);
    this.send('isready'); await this.until((l) => l === 'readyok');
  }
  kill() { this.p.kill(); }
}

export function parseScore(lines: string[], multipv = 1): Map<number, { cp: number; pv: string[]; depth: number }> {
  const out = new Map<number, { cp: number; pv: string[]; depth: number }>();
  for (const l of lines) {
    if (!l.startsWith('info ') || !l.includes(' score ')) continue;
    const mp = Number(/ multipv (\d+)/.exec(l)?.[1] ?? 1);
    if (mp > multipv) continue;
    if (/ (lowerbound|upperbound)/.test(l)) continue;
    const m = / score (cp|mate) (-?\d+)/.exec(l);
    if (!m) continue;
    const v = Number(m[2]);
    const cp = m[1] === 'cp' ? v : v > 0 ? 2000 - 10 * v : v < 0 ? -2000 - 10 * v : -2000;
    const depth = Number(/ depth (\d+)/.exec(l)?.[1] ?? 0);
    const pv = (/ pv (.*)$/.exec(l)?.[1] ?? '').split(' ').filter(Boolean);
    out.set(mp, { cp, pv, depth });
  }
  return out;
}

export class TeacherPool {
  procs: UciProcess[] = [];
  size: number;
  depth: number;
  constructor(size = 2, depth = 8) { this.size = size; this.depth = depth; }
  async start() {
    for (let i = 0; i < this.size; i++) { const p = new UciProcess(); await p.init({ Hash: '16' }); this.procs.push(p); }
  }
  /** Evaluate side-to-move centipawns for every FEN (mates mapped to ±(2000 − 10·n)). */
  async label(fens: string[], onProgress?: (done: number) => void): Promise<number[]> {
    const out = new Array<number>(fens.length);
    let next = 0, done = 0;
    await Promise.all(this.procs.map(async (p) => {
      while (next < fens.length) {
        const i = next++;
        p.send(`position fen ${fens[i]}`);
        p.send(`go depth ${this.depth}`);
        const lines = await p.until((l) => l.startsWith('bestmove'));
        out[i] = parseScore(lines).get(1)?.cp ?? 0;
        if (++done % 2000 === 0) onProgress?.(done);
      }
    }));
    return out;
  }
  /** Evaluate specific candidate moves of a position (score from the side to move before the move). */
  async evalMoves(fen: string, moves: string[], depth: number): Promise<Map<string, number>> {
    const p = this.procs[0];
    p.send(`setoption name MultiPV value ${moves.length}`);
    p.send(`position fen ${fen}`);
    p.send(`go depth ${depth} searchmoves ${moves.join(' ')}`);
    const lines = await p.until((l) => l.startsWith('bestmove'));
    p.send('setoption name MultiPV value 1');
    const res = new Map<string, number>();
    for (const [, v] of parseScore(lines, moves.length)) if (v.pv[0]) res.set(v.pv[0], v.cp);
    return res;
  }
  /** Parallel version over many positions. */
  async evalMovesMany(items: { fen: string; moves: string[] }[], depth: number, onProgress?: (done: number) => void): Promise<Map<string, number>[]> {
    const out: Map<string, number>[] = new Array(items.length);
    let next = 0, done = 0;
    await Promise.all(this.procs.map(async (p) => {
      while (next < items.length) {
        const i = next++;
        const it = items[i];
        p.send(`setoption name MultiPV value ${it.moves.length}`);
        p.send(`position fen ${it.fen}`);
        p.send(`go depth ${depth} searchmoves ${it.moves.join(' ')}`);
        const lines = await p.until((l) => l.startsWith('bestmove'));
        const res = new Map<string, number>();
        for (const [, v] of parseScore(lines, it.moves.length)) if (v.pv[0]) res.set(v.pv[0], v.cp);
        out[i] = res;
        if (++done % 500 === 0) onProgress?.(done);
      }
    }));
    for (const p of this.procs) p.send('setoption name MultiPV value 1');
    return out;
  }
  stop() { for (const p of this.procs) p.kill(); }
}
