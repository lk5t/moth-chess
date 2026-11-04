// Integration test against the REAL bundled Stockfish build, run under Node as a child process.
// Skipped (and reported) when the engine has not been installed (npm install → postinstall copies it).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { StockfishEngine, type EngineTransport } from '@/engine/engine';
import { START_FEN, applyMove } from '@/chess/position';

const root = resolve(__dirname, '../..');
const meta = resolve(root, 'public/engines/engine.json');
const enginePath = existsSync(meta) ? resolve(root, 'node_modules/stockfish', JSON.parse(readFileSync(meta, 'utf8')).source) : '';
const available = !!enginePath && existsSync(enginePath);
if (!available) console.warn('[stockfish.test] Stockfish not installed — real-engine tests SKIPPED. Run `npm install` first.');

const nodeTransport = (): EngineTransport => {
  const p = spawn(process.execPath, [enginePath], { cwd: resolve(enginePath, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
  const cbs: ((l: string) => void)[] = [];
  const errs: ((e: unknown) => void)[] = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop() ?? ''; for (const l of lines) cbs.forEach((c) => c(l)); });
  p.on('error', (e) => errs.forEach((c) => c(e)));
  return { send: (c) => p.stdin.write(c + '\n'), onLine: (c) => cbs.push(c), onError: (c) => errs.push(c), terminate: () => p.kill() };
};

describe.skipIf(!available)('real Stockfish WASM', () => {
  it('initialises and reports a name', async () => {
    const e = new StockfishEngine(nodeTransport, { threads: 1, hashMb: 16 }, { idleMs: 0 });
    await e.init();
    expect(e.engineName.toLowerCase()).toContain('stockfish');
    e.terminate();
  });
  it('finds mate in one (back-rank)', async () => {
    const e = new StockfishEngine(nodeTransport, { threads: 1, hashMb: 16 }, { idleMs: 0 });
    const fen = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
    const r = await e.analyse(fen, { depth: 10, multiPv: 1 }).result;
    expect(r.bestMove).toBe('d1d8');
    expect(r.lines[0].whiteScore).toMatchObject({ type: 'mate', value: 1 });
    expect(applyMove(fen, r.bestMove!)?.san).toBe('Rd8#');
    e.terminate();
  });
  it('returns three distinct principal variations with MultiPV 3', async () => {
    const e = new StockfishEngine(nodeTransport, { threads: 1, hashMb: 16 }, { idleMs: 0 });
    const r = await e.analyse(START_FEN, { depth: 10, multiPv: 3 }).result;
    expect(r.lines).toHaveLength(3);
    expect(new Set(r.lines.map((l) => l.pv[0])).size).toBe(3);
    expect(Math.abs(r.lines[0].whiteScore.value)).toBeLessThan(100);
    e.terminate();
  });
  it('sees that a hanging queen should be taken', async () => {
    const e = new StockfishEngine(nodeTransport, { threads: 1, hashMb: 16 }, { idleMs: 0 });
    const r = await e.analyse('rnb1kbnr/pppp1ppp/8/4p1q1/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', { depth: 12, multiPv: 1 }).result;
    expect(r.bestMove).toBe('f3g5');
    expect(r.lines[0].whiteScore.value).toBeGreaterThan(500);
    e.terminate();
  });
});
