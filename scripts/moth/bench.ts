// Phase 17 benchmarks → public/moth-engine/benchmarks.json (shown on the MOTH Engine dashboard).
// Everything is measured on this machine; nothing is estimated except where labelled.
//   latency     move requests through the real UCI front end (book → cache → search), by category
//   vsStockfish tactical suite with identical hardware and per-move budget; raw search speed
//   strength    matches against Stockfish's own calibrated UCI_Elo levels (max-likelihood estimate)
//   styles      how often each style chooses checks / captures; forced wins found by all styles
// Usage: node --experimental-strip-types scripts/moth/bench.ts <games.pgn.gz> <puzzles.csv.gz> [--strength-games 16]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { cpus } from 'node:os';
import { MothWasm } from '../../src/moth-engine/wasm.ts';
import { MothUci } from '../../src/moth-engine/uci.ts';
import { decodeModel, type ModelFile } from '../../src/moth-engine/model.ts';
import type { OpeningBook } from '../../src/moth-engine/book.ts';
import { ingestPgn } from '../../src/moth-engine/training/ingest.ts';
import { splitPgn } from '../../src/moth-engine/training/pgn.ts';
import { parseLichessPuzzles, pickSuite, runTactics, CORE_THEMES, type TacticPuzzle } from '../../src/moth-engine/training/tactics.ts';
import { latencyStats } from '../../src/play/stats.ts';
import { UciProcess, parseScore } from './teacher.ts';

const [gamesFile, puzzlesFile] = process.argv.slice(2);
const argv = process.argv.join(' ');
const strengthGames = Number(/--strength-games (\d+)/.exec(argv)?.[1] ?? 16);
const latencyOnly = argv.includes('--latency-only'); // re-measure latency, keep the other sections
const strengthOnly = argv.includes('--strength-only'); // extend the strength ladder, merge with existing results
const levelArg = /--levels ([\d,]+)/.exec(argv)?.[1];
const BUDGET = 100;
const root = new URL('../../public/moth-engine/', import.meta.url);
const W = readFileSync(new URL('moth.wasm', root));
const book: OpeningBook = JSON.parse(readFileSync(new URL('book.json', root), 'utf8'));
const registry = JSON.parse(readFileSync(new URL('models/registry.json', root), 'utf8'));
const active = registry.models.find((m: { id: string }) => m.id === registry.active);
const model: ModelFile | null = active ? decodeModel(readFileSync(new URL(`models/${active.file}`, root))) : null;
const prevBench = existsSync(new URL('benchmarks.json', root)) ? JSON.parse(readFileSync(new URL('benchmarks.json', root), 'utf8')) : null;
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
log(`model: ${model?.meta.id ?? 'classical'}`);

// ---- latency through the UCI front end ------------------------------------------------------------
async function uciHarness() {
  const eng = await MothWasm.create(W, 32);
  let waiters: [(l: string) => boolean, (l: string) => void][] = [];
  const lines: string[] = [];
  const u = new MothUci(eng, { emit: (l) => { lines.push(l); waiters = waiters.filter(([t, r]) => (t(l) ? (r(l), false) : true)); }, now: () => performance.now(), yieldNow: () => new Promise((r) => setImmediate(r)), loadModel: async () => model, loadBook: async () => book });
  const wait = (t: (l: string) => boolean) => new Promise<string>((r) => waiters.push([t, r]));
  u.handle('uci'); await wait((l) => l === 'uciok'); u.handle('isready'); await wait((l) => l === 'readyok');
  const request = async (fen: string) => {
    u.handle(`position fen ${fen}`);
    const t0 = performance.now();
    const done = wait((l) => l.startsWith('bestmove'));
    u.handle(`go movetime ${BUDGET}`);
    await done;
    const ms = performance.now() - t0;
    const src = [...lines].reverse().find((l) => l.startsWith('info string latency'))?.split(' ').pop() ?? 'search';
    return { ms, src };
  };
  return { u, request, eng };
}
const H = strengthOnly ? null as unknown as Awaited<ReturnType<typeof uciHarness>> : await uciHarness();
const sample = <T,>(a: T[], n: number) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
const ref = await MothWasm.create(W, 1);
const games = splitPgn(gunzipSync(readFileSync(gamesFile)).toString('utf8'));
const { positions } = ingestPgn(ref, games.slice(-800).join('\n\n'), { maxPositionsPerGame: 40, skipOpeningPlies: 0 });
const inBook = (fen: string) => !!book.positions[fen.split(' ').slice(0, 4).join(' ')];
const cats: Record<string, string[]> = {
  'book (known openings)': sample(Object.keys(book.positions).map((k) => `${k} 0 1`).filter((f) => ref.setFen(f) && ref.legalMoves().length), 80),
  'opening, out of book': sample(positions.filter((p) => p.ply >= 8 && p.ply <= 16 && !inBook(p.fen)).map((p) => p.fen), 60),
  middlegame: sample(positions.filter((p) => p.ply >= 24 && p.ply <= 60 && p.phase >= 12).map((p) => p.fen), 80),
  endgame: sample(positions.filter((p) => p.phase <= 6).map((p) => p.fen), 60),
};
const puzzles = parseLichessPuzzles(gunzipSync(readFileSync(puzzlesFile)).toString('utf8'), ref);
cats['tactical (puzzles)'] = sample(puzzles.map((p) => p.fen), 80);
const latency: Record<string, ReturnType<typeof latencyStats> & { target: string }> = {};
const TARGET: Record<string, string> = { 'book (known openings)': '1–10 ms', 'opening, out of book': '10–50 ms', middlegame: '10–50 ms', endgame: '10–50 ms', 'tactical (puzzles)': '20–100 ms', cached: '1–5 ms' };
const cachedMs: number[] = [];
for (const [cat, fens] of strengthOnly ? [] : Object.entries(cats)) {
  const ms: number[] = [];
  for (const f of fens) {
    H.u.handle('ucinewgame');
    const r = await H.request(f);
    ms.push(r.ms);
    if (cat !== 'book (known openings)') { const again = await H.request(f); cachedMs.push(again.ms); }
  }
  latency[cat] = { ...latencyStats(ms)!, target: TARGET[cat] };
  log(`latency ${cat}: ${JSON.stringify(latency[cat])}`);
}
if (!strengthOnly) latency.cached = { ...latencyStats(cachedMs)!, target: TARGET.cached };
log(`latency cached: ${JSON.stringify(latency.cached)}`);

if (latencyOnly) {
  const prev = JSON.parse(readFileSync(new URL('benchmarks.json', root), 'utf8'));
  writeFileSync(new URL('benchmarks.json', root), JSON.stringify({ ...prev, generatedAt: new Date().toISOString(), latency }, null, 1));
  log('updated latency in benchmarks.json');
  process.exit(0);
}

// ---- tactics: MOTH vs Stockfish, identical budget ----------------------------------------------------
const suite: TacticPuzzle[] = pickSuite(puzzles, CORE_THEMES, 12);
const eng = await MothWasm.create(W, 32);
const mothT = strengthOnly ? prevBench.tactics : runTactics(eng, suite, { movetimeMs: BUDGET, net: model?.weights ?? null });
log(`tactics MOTH @${BUDGET}ms: ${mothT.solved}/${mothT.total}`);
const sf = new UciProcess(); await sf.init({ Hash: '32' });
let sfSolved = 0;
if (strengthOnly) sfSolved = prevBench.vsStockfish.tactics.stockfish.solved;
for (const p of strengthOnly ? [] : suite) {
  sf.send('ucinewgame'); sf.send(`position fen ${p.fen}`); sf.send(`go movetime ${BUDGET}`);
  const ls = await sf.until((l) => l.startsWith('bestmove'));
  const mv = ls[ls.length - 1].split(' ')[1];
  const mateN = Number(/mateIn(\d)/.exec(p.themes.join(' '))?.[1] ?? 0);
  const sc = [...ls].reverse().find((l) => / score mate (\d+)/.test(l));
  if (mv === p.solution || (mateN && sc && Number(/ score mate (\d+)/.exec(sc)![1]) <= mateN)) sfSolved++;
}
log(`tactics Stockfish @${BUDGET}ms: ${sfSolved}/${suite.length}`);
// raw speed
eng.setFen('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'); eng.newGame();
const sp = eng.search({ movetimeMs: strengthOnly ? 10 : 2000 });
sf.send('ucinewgame'); sf.send('position fen r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'); sf.send('go movetime 2000');
const sfl = await sf.until((l) => l.startsWith('bestmove'));
const sfNps = Number([...sfl].reverse().find((l) => / nps /.test(l))?.match(/ nps (\d+)/)?.[1] ?? 0);
const nps = strengthOnly ? prevBench.vsStockfish.nps : { moth: Math.round((sp.nodes / sp.timeMs) * 1000), stockfish: sfNps };
log(`nps MOTH ${nps.moth} Stockfish ${nps.stockfish}`);

// ---- strength vs Stockfish UCI_Elo ladder -------------------------------------------------------------
const LEVELS = levelArg ? levelArg.split(',').map(Number) : [1350, 1600, 1850, 2100, 2400, 2700, 3000];
const results: { opponent: string; elo: number; games: number; score: number }[] = strengthOnly ? (prevBench?.strength?.results ?? []).filter((r: { elo: number }) => !LEVELS.includes(r.elo)) : [];
const OPEN = [['e2e4', 'e7e5'], ['d2d4', 'd7d5'], ['e2e4', 'c7c5'], ['c2c4', 'e7e5'], ['d2d4', 'g8f6'], ['e2e4', 'e7e6'], ['g1f3', 'd7d5'], ['e2e4', 'c7c6']];
for (const elo of LEVELS) {
  if (!strengthGames) break;
  const opp = new UciProcess(); await opp.init({ Hash: '16', UCI_LimitStrength: 'true', UCI_Elo: String(elo) });
  const me = await MothWasm.create(W, 16); me.loadNetwork(model?.weights ?? null);
  let pts = 0, n = 0;
  for (let g = 0; g < strengthGames; g++) {
    const mothWhite = g % 2 === 0;
    const moves = [...OPEN[Math.floor(g / 2) % OPEN.length]];
    me.newGame(); opp.send('ucinewgame');
    let result = 0.5;
    for (let ply = 0; ply < 260; ply++) {
      ref.setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'); for (const m of moves) ref.play(m);
      const st = ref.gameState();
      if (st !== 'ongoing') { result = st === 'checkmate' ? ((ref.sideToMove() === 'w') === mothWhite ? 0 : 1) : 0.5; break; }
      const mothToMove = (ref.sideToMove() === 'w') === mothWhite;
      let mv: string;
      if (mothToMove) { me.setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'); for (const m of moves) me.play(m); mv = me.search({ movetimeMs: 50 }).bestMove!; }
      else { opp.send(`position startpos moves ${moves.join(' ')}`); opp.send('go movetime 50'); const ls = await opp.until((l) => l.startsWith('bestmove')); mv = ls[ls.length - 1].split(' ')[1]; }
      if (!mv || mv === '(none)') break;
      moves.push(mv);
      if (ply === 259) result = 0.5;
    }
    pts += result; n++;
  }
  opp.kill();
  results.push({ opponent: `Stockfish UCI_Elo ${elo}`, elo, games: n, score: pts / n });
  results.sort((a, b) => a.elo - b.elo);
  log(`vs Stockfish UCI_Elo ${elo}: ${pts}/${n}`);
}
// maximum likelihood Elo over the ladder (logistic model), with a likelihood-ratio 95% interval
const ll = (R: number) => results.reduce((a, r) => { const p = 1 / (1 + Math.pow(10, (r.elo - R) / 400)); const s = r.score * r.games; return a + s * Math.log(Math.max(1e-9, p)) + (r.games - s) * Math.log(Math.max(1e-9, 1 - p)); }, 0);
let best = 0, bestLL = -Infinity;
for (let R = 600; R <= 3200; R += 5) { const v = ll(R); if (v > bestLL) { bestLL = v; best = R; } }
const inCI: number[] = [];
for (let R = 600; R <= 3200; R += 5) if (2 * (bestLL - ll(R)) <= 3.84) inCI.push(R);
const strength = !strengthGames && prevBench?.strength ? prevBench.strength : results.length ? { method: `Maximum-likelihood fit of ${results.reduce((a, r) => a + r.games, 0)} games (50 ms/move, single thread) against Stockfish 17.1 lite at fixed UCI_Elo levels. Stockfish's UCI_Elo is its own calibration, not FIDE or CCRL — treat this as a rough scale.`, estimateElo: best, ci95: [inCI[0], inCI[inCI.length - 1]] as [number, number], results } : undefined;

// ---- styles ---------------------------------------------------------------------------------------------
const stylePositions = sample(positions.filter((p) => p.ply >= 12 && p.ply <= 50 && p.phase >= 10).map((p) => p.fen), 60);
const checkRate: Record<string, number> = {}, captureRate: Record<string, number> = {};
const picks: Record<string, string[]> = {};
for (const s of ['aggressive', 'balanced', 'defensive'] as const) {
  eng.setStyle(s); let checks = 0, caps = 0; picks[s] = [];
  for (const f of stylePositions) {
    eng.newGame(); eng.setFen(f); const mv = eng.search({ nodes: 40000 }).bestMove!; picks[s].push(mv);
    const san = eng.uciToSan(mv) ?? '';
    if (san.includes('+') || san.includes('#')) checks++; if (san.includes('x')) caps++;
  }
  checkRate[s] = checks / stylePositions.length; captureRate[s] = caps / stylePositions.length;
}
const mates = suite.filter((p) => p.themes.some((t) => /^mateIn[12]$/.test(t)));
let agree = 0;
for (const p of mates) { const r = ['aggressive', 'balanced', 'defensive'].map((s) => { eng.setStyle(s as 'balanced'); eng.newGame(); eng.setFen(p.fen); const x = eng.search({ nodes: 60000 }); return eng.uciScore(x.lines[0]?.score ?? 0); }); if (r.every((x) => x.type === 'mate' && x.value > 0)) agree++; }
eng.setStyle('balanced');
sf.kill();

const out = {
  generatedAt: new Date().toISOString(),
  machine: `${cpus()[0]?.model ?? 'cpu'} × ${cpus().length}, Node ${process.version} (WebAssembly)`,
  model: model?.meta.id ?? 'classical',
  latency: strengthOnly ? prevBench.latency : latency,
  vsStockfish: { movetimeMs: BUDGET, tactics: { moth: { solved: mothT.solved, total: mothT.total }, stockfish: { solved: sfSolved, total: suite.length } }, nps },
  tactics: { budgetMs: BUDGET, solved: mothT.solved, total: mothT.total, byTheme: mothT.byTheme },
  strength,
  styles: { positions: stylePositions.length, checkRate, captureRate, forcedWinsAgree: agree, mates: mates.length,
    differentFromBalanced: { aggressive: picks.aggressive.filter((m, i) => m !== picks.balanced[i]).length / stylePositions.length, defensive: picks.defensive.filter((m, i) => m !== picks.balanced[i]).length / stylePositions.length } },
  book: book.stats,
};
writeFileSync(new URL('benchmarks.json', root), JSON.stringify(out, null, 1));
log('wrote benchmarks.json');
process.exit(0);
