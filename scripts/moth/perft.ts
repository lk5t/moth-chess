// Perft correctness against the standard reference positions (chessprogramming.org/Perft_Results).
import { readFileSync } from 'node:fs';
import { MothWasm } from '../../src/moth-engine/wasm.ts';

export const PERFT_SUITE: { name: string; fen: string; depths: number[] }[] = [
  { name: 'startpos', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', depths: [20, 400, 8902, 197281, 4865609] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', depths: [48, 2039, 97862, 4085603] },
  { name: 'position3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', depths: [14, 191, 2812, 43238, 674624] },
  { name: 'position4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', depths: [6, 264, 9467, 422333] },
  { name: 'position5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', depths: [44, 1486, 62379, 2103487] },
  { name: 'position6', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', depths: [46, 2079, 89890, 3894594] },
];

const wasm = await MothWasm.create(readFileSync(new URL('../../public/moth-engine/moth.wasm', import.meta.url)), 1);
let fail = 0, total = 0;
const t0 = performance.now();
for (const p of PERFT_SUITE) {
  for (let d = 1; d <= p.depths.length; d++) {
    if (!wasm.setFen(p.fen)) { console.log('bad fen', p.name); fail++; break; }
    const n = wasm.perft(d); total += n;
    const ok = n === p.depths[d - 1];
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.name} d${d} ${n}${ok ? '' : ` expected ${p.depths[d - 1]}`}`);
  }
}
const ms = performance.now() - t0;
console.log(`${fail ? 'FAILED' : 'all perft counts correct'} — ${total} nodes in ${ms.toFixed(0)} ms (${(total / ms / 1000).toFixed(1)} Mnps)`);
process.exit(fail ? 1 : 0);
