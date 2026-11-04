// Engine Lab worker (dist/moth-lab-worker.js): local MOTH-vs-MOTH self-play matches and test suites.
// Runs entirely in its own worker; never touches websites. Each game is posted as it finishes (PGN +
// positions), so an interrupted match keeps everything played so far and can be resumed from that point.
import { MothWasm, type StyleName } from './wasm.ts';
import { decodeModel } from './model.ts';
import { matchStats, playGame, type Player, type PlayedGame } from './training/selfplay.ts';
import { bookKey, type OpeningBook } from './book.ts';

declare const self: DedicatedWorkerGlobalScope;
const asset = (p: string) => new URL(`moth-engine/${p}`, self.location.href).toString();
let stop = false;

export interface SideConfig { name: string; style: StyleName; model: 'builtin' | 'classical'; nodes?: number; movetimeMs?: number }
export interface MatchParams { a: SideConfig; b: SideConfig; openings: number; seed: number; startAt?: number }
export interface SuiteParams { positions: { fen: string; best: string[] }[]; movetimeMs: number; style: StyleName; model: 'builtin' | 'classical' }

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: 'match'; params: MatchParams } | { type: 'suite'; params: SuiteParams } | { type: 'stop' };
  if (m.type === 'stop') { stop = true; return; }
  stop = false;
  try {
    if (m.type === 'match') await match(m.params);
    else await suite(m.params);
  } catch (err) { self.postMessage({ type: 'error', msg: String((err as Error)?.message ?? err) }); }
};

async function engine(): Promise<MothWasm> {
  const r = await fetch(asset('moth.wasm'));
  if (!r.ok) throw new Error('moth.wasm could not be loaded');
  return MothWasm.create(await r.arrayBuffer(), 16);
}
async function builtinNet() {
  const reg = await (await fetch(asset('models/registry.json'))).json() as { active?: string; models: { id: string; file: string }[] };
  const act = reg.models.find((x) => x.id === reg.active);
  if (!act) return null;
  return decodeModel(await (await fetch(asset(`models/${act.file}`))).arrayBuffer()).weights;
}

function openingLines(e: MothWasm, book: OpeningBook, n: number, seed: number): string[][] {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const seen = new Set<string>(), lines: string[][] = [];
  for (let t = 0; lines.length < n && t < n * 30; t++) {
    e.setFen(START); const ply = 4 + Math.floor(rnd() * 7); const line: string[] = [];
    for (let i = 0; i < ply; i++) {
      const p = book.positions[bookKey(e.fen())];
      const sound = p?.moves.filter((m) => !m.tags.includes('mistake') && m.eval >= (p.moves[0]?.eval ?? 0) - 40) ?? [];
      if (!sound.length) break;
      const mv = sound[Math.floor(rnd() * sound.length)]; line.push(mv.uci); e.play(mv.uci);
    }
    const k = line.join(' '); if (line.length >= 4 && !seen.has(k)) { seen.add(k); lines.push(line); }
  }
  return lines;
}

function pgnOf(g: PlayedGame, e: MothWasm): string {
  e.setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const san: string[] = [];
  for (const u of [...g.opening, ...g.moves]) { san.push(e.uciToSan(u) ?? u); e.play(u); }
  const body = san.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');
  return `[Event "MOTH self-play"]\n[Site "MOTH Engine Lab (local)"]\n[White "${g.white}"]\n[Black "${g.black}"]\n[Result "${g.result}"]\n[Termination "${g.reason}"]\n\n${body} ${g.result}`;
}

async function match(p: MatchParams) {
  const [ea, eb, scratch] = await Promise.all([engine(), engine(), engine()]);
  const book = await (await fetch(asset('book.json'))).json() as OpeningBook;
  const net = p.a.model === 'builtin' || p.b.model === 'builtin' ? await builtinNet() : null;
  const ops = openingLines(scratch, book, p.openings, p.seed);
  const pa: Player = { name: p.a.name, engine: ea, net: p.a.model === 'builtin' ? net : null, style: p.a.style, nodes: p.a.nodes, movetimeMs: p.a.movetimeMs };
  const pb: Player = { name: p.b.name, engine: eb, net: p.b.model === 'builtin' ? net : null, style: p.b.style, nodes: p.b.nodes, movetimeMs: p.b.movetimeMs };
  let w = 0, d = 0, l = 0, i = 0;
  const total = ops.length * 2;
  for (const op of ops) for (const aWhite of [true, false]) {
    if (i++ < (p.startAt ?? 0)) continue; // resume after an interruption
    if (stop) { self.postMessage({ type: 'stopped', done: i - 1, stats: matchStats(w, d, l, pb.name) }); return; }
    const g = aWhite ? playGame(pa, pb, op) : playGame(pb, pa, op);
    if (g.result === '1/2-1/2') d++; else if ((g.result === '1-0') === aWhite) w++; else l++;
    self.postMessage({ type: 'game', index: i, total, result: g.result, reason: g.reason, pgn: pgnOf(g, scratch), positions: g.records.length, stats: matchStats(w, d, l, pb.name) });
    await new Promise((r) => setTimeout(r, 0)); // let `stop` arrive
  }
  self.postMessage({ type: 'done', stats: matchStats(w, d, l, pb.name) });
}

async function suite(p: SuiteParams) {
  const e = await engine();
  e.loadNetwork(p.model === 'builtin' ? await builtinNet() : null);
  e.setStyle(p.style);
  let solved = 0, nodes = 0, ms = 0, depth = 0;
  for (let i = 0; i < p.positions.length; i++) {
    if (stop) break;
    const pos = p.positions[i];
    e.newGame(); e.setFen(pos.fen);
    const r = e.search({ movetimeMs: p.movetimeMs });
    const ok = !!r.bestMove && pos.best.includes(r.bestMove);
    if (ok) solved++;
    nodes += r.nodes; ms += r.timeMs; depth += r.depth;
    if (i % 5 === 0 || i === p.positions.length - 1) self.postMessage({ type: 'suite-progress', done: i + 1, total: p.positions.length, solved });
    await new Promise((r2) => setTimeout(r2, 0));
  }
  const n = p.positions.length;
  self.postMessage({ type: 'suite-done', solved, total: n, nps: ms ? Math.round((nodes / ms) * 1000) : 0, avgDepth: n ? depth / n : 0 });
}
