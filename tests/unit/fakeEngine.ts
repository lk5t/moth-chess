// Scripted UCI engine for testing the controller logic deterministically (no WASM).
import type { EngineTransport } from '@/engine/engine';
import { legalMoves } from '@/chess/position';

export interface FakeOptions { stepMs?: number; mute?: boolean; threadsMax?: number; scoreFor?: (fen: string, multipv: number) => number }

export class FakeEngine implements EngineTransport {
  sent: string[] = [];
  terminated = false;
  private lineCbs: ((l: string) => void)[] = [];
  private errCbs: ((e: unknown) => void)[] = [];
  private fen = '';
  private multiPv = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private searching = false;
  private lateLines: string[] = [];
  constructor(private o: FakeOptions = {}) {}
  onLine(cb: (l: string) => void) { this.lineCbs.push(cb); }
  onError(cb: (e: unknown) => void) { this.errCbs.push(cb); }
  emit(l: string) { if (!this.terminated) this.lineCbs.forEach((c) => c(l)); }
  crash() { this.errCbs.forEach((c) => c(new Error('boom'))); }
  terminate() { this.terminated = true; if (this.timer) clearTimeout(this.timer); }
  /** Lines to emit right after a `stop` (simulates output already in flight for the old search). */
  injectAfterStop(lines: string[]) { this.lateLines = lines; }
  send(cmd: string) {
    this.sent.push(cmd);
    if (this.o.mute && cmd.startsWith('go')) return;
    const later = (f: () => void) => setTimeout(f, 0);
    if (cmd === 'uci') later(() => {
      this.emit('id name FakeFish 1.0');
      this.emit(`option name Threads type spin default 1 min 1 max ${this.o.threadsMax ?? 1}`);
      this.emit('option name Hash type spin default 16 min 1 max 512');
      this.emit('option name MultiPV type spin default 1 min 1 max 500');
      this.emit('uciok');
    });
    else if (cmd === 'isready') later(() => this.emit('readyok'));
    else if (cmd.startsWith('setoption name MultiPV value ')) this.multiPv = Number(cmd.split(' ').pop());
    else if (cmd.startsWith('position fen ')) this.fen = cmd.slice(13);
    else if (cmd.startsWith('go')) {
      const depth = Number(/depth (\d+)/.exec(cmd)?.[1] ?? 10);
      this.searching = true;
      const fen = this.fen;
      const moves = legalMoves(fen);
      let d = 1;
      const tick = () => {
        if (!this.searching) return;
        if (!moves.length) { this.emit('info depth 0 score mate 0'); this.emit('bestmove (none)'); this.searching = false; return; }
        for (let k = 1; k <= Math.min(this.multiPv, moves.length); k++) {
          const m = moves[(k - 1) % moves.length];
          const cp = this.o.scoreFor ? this.o.scoreFor(fen, k) : 50 - k * 20;
          this.emit(`info depth ${d} seldepth ${d + 2} multipv ${k} score cp ${cp} nodes ${d * 1000} nps 100000 time ${d} pv ${m.uci}`);
        }
        if (d >= depth) { this.searching = false; this.emit(`bestmove ${moves[0].uci}`); return; }
        d++;
        this.timer = setTimeout(tick, this.o.stepMs ?? 1);
      };
      this.timer = setTimeout(tick, this.o.stepMs ?? 1);
    } else if (cmd === 'stop') {
      later(() => {
        if (!this.searching) return;
        this.searching = false;
        if (this.timer) clearTimeout(this.timer);
        for (const l of this.lateLines) this.emit(l);
        this.lateLines = [];
        this.emit(`bestmove ${legalMoves(this.fen)[0]?.uci ?? '(none)'}`);
      });
    }
  }
}
