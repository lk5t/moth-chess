// A/B match between two MOTH Engine builds (same network, same style): measures whether an engine change
// helps. Each book opening is played twice with colours swapped. Reports W/D/L, Elo ± 95% and LOS.
//   node --experimental-strip-types scripts/moth/ab.ts --a engine/moth/baseline/moth-2.0.wasm --b public/moth-engine/moth.wasm --games 200 --nodes 20000
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { MothWasm } from '../../src/moth-engine/wasm.ts';
import { decodeModel } from '../../src/moth-engine/model.ts';
import { runMatch, type Player } from '../../src/moth-engine/training/selfplay.ts';
import { bookKey, type OpeningBook } from '../../src/moth-engine/book.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const A = arg('a', 'engine/moth/baseline/moth-2.0.wasm'), B = arg('b', 'public/moth-engine/moth.wasm');
const games = Number(arg('games', '100')), nodes = Number(arg('nodes', '0')), movetime = Number(arg('ms', '0')) || undefined, seed = Number(arg('seed', '7'));
const out = arg('out', '');

const reg = JSON.parse(readFileSync('public/moth-engine/models/registry.json', 'utf8'));
const act = reg.models.find((m: { id: string }) => m.id === reg.active);
const net = act ? decodeModel(readFileSync(`public/moth-engine/models/${act.file}`)).weights : null;
const book: OpeningBook = JSON.parse(readFileSync('public/moth-engine/book.json', 'utf8'));

const ea = await MothWasm.create(readFileSync(A), 16), eb = await MothWasm.create(readFileSync(B), 16);
function openings(n: number): string[][] {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const seen = new Set<string>(), lines: string[][] = [];
  for (let t = 0; lines.length < n && t < n * 30; t++) {
    ea.setFen(START); const ply = 4 + Math.floor(rnd() * 7); const line: string[] = [];
    for (let i = 0; i < ply; i++) {
      const p = book.positions[bookKey(ea.fen())];
      const sound = p?.moves.filter((m) => !m.tags.includes('mistake') && m.eval >= (p.moves[0]?.eval ?? 0) - 40) ?? [];
      if (!sound.length) break;
      const m = sound[Math.floor(rnd() * sound.length)]; line.push(m.uci); ea.play(m.uci);
    }
    const k = line.join(' '); if (line.length >= 4 && !seen.has(k)) { seen.add(k); lines.push(line); }
  }
  return lines;
}
const ops = openings(Math.ceil(games / 2));
const pa: Player = { name: 'A', engine: ea, net, style: 'balanced', nodes: nodes || undefined, movetimeMs: movetime };
const pb: Player = { name: 'B', engine: eb, net, style: 'balanced', nodes: nodes || undefined, movetimeMs: movetime };
const t0 = Date.now();
const { stats, games: played } = runMatch(pb, pa, ops, (_g, i, n) => { if (i % 20 === 0) process.stderr.write(`  ${i}/${n}\n`); });
const res = { a: A, b: B, games: played.length, limit: nodes ? `${nodes} nodes` : `${movetime} ms`, ...stats, seconds: Math.round((Date.now() - t0) / 1000) };
console.log(JSON.stringify(res, null, 1));
if (out) { const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []; prev.push({ at: new Date().toISOString(), ...res }); writeFileSync(out, JSON.stringify(prev, null, 1)); }
