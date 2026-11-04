// Tactical suite for two MOTH builds (same network): puzzles solved, nodes/s and depth at a fixed time per puzzle.
//   node --experimental-strip-types scripts/moth/tactics-ab.ts [--ms 100]
import { readFileSync } from 'node:fs';
import { MothWasm } from '../../src/moth-engine/wasm.ts';
import { decodeModel } from '../../src/moth-engine/model.ts';
const ms = Number(/--ms (\d+)/.exec(process.argv.join(' '))?.[1] ?? 100);
const builds = { '2.0': 'engine/moth/baseline/moth-2.0.wasm', '3.0': 'public/moth-engine/moth.wasm' };
const reg = JSON.parse(readFileSync('public/moth-engine/models/registry.json', 'utf8'));
const act = reg.models.find((m: { id: string }) => m.id === reg.active);
const net = decodeModel(readFileSync(`public/moth-engine/models/${act.file}`)).weights;
const suite = JSON.parse(readFileSync('public/moth-engine/tactics.json', 'utf8')).puzzles as { fen: string; solution: string; line: string[] }[];
const out: Record<string, unknown> = {};
for (const [name, file] of Object.entries(builds)) {
  const e = await MothWasm.create(readFileSync(file), 16);
  e.loadNetwork(net); e.setStyle('balanced');
  let solved = 0, nodes = 0, t = 0, depth = 0;
  for (const p of suite) { e.newGame(); e.setFen(p.fen); const r = e.search({ movetimeMs: ms }); if (r.bestMove === p.solution) solved++; nodes += r.nodes; t += r.timeMs; depth += r.depth; }
  // fixed-depth node count on 20 middlegame positions: search efficiency independent of speed
  let nd = 0; for (const p of suite.slice(0, 40)) { e.newGame(); e.setFen(p.fen); nd += e.search({ depth: 8 }).nodes; }
  out[name] = { solved, of: suite.length, knps: Math.round(nodes / t), avgDepth: +(depth / suite.length).toFixed(2), nodesToDepth8: nd };
}
console.log(JSON.stringify({ msPerPuzzle: ms, ...out }, null, 1));
