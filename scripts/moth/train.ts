// MOTH evolution pipeline (offline, Node). Separate from gameplay: produces versioned candidate
// models and promotes them only on measured improvement.
//
//   1. ingest human games (validated, deduplicated, train/val split by game)
//   2. self-play games with the current active model → more positions
//   3. label every position with the teacher (Stockfish) — cached on disk
//   4. train a candidate network (seeded, reproducible settings recorded in the model file)
//   5. gate: validation loss vs parent, engine match vs parent, tactical suite vs parent
//   6. write the model (approved or rejected) + registry; previous models are kept for rollback
//
// Usage: node --experimental-strip-types scripts/moth/train.ts --games <pgn.gz> --puzzles <csv.gz>
//          [--selfplay 200] [--match 100] [--hidden 64] [--epochs 6] [--per-game 7] [--label-depth 8]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MothWasm, type NetworkWeights } from '../../src/moth-engine/wasm.ts';
import { encodeModel, decodeModel, type ModelMeta, type TrainingSettings } from '../../src/moth-engine/model.ts';
import { ingestPgn, augment, hash32, type TrainingPosition } from '../../src/moth-engine/training/ingest.ts';
import { rng } from '../../src/moth-engine/model.ts';
import { DEFAULT_TRAINING, trainNetwork, evaluateLoss, makeTarget, netChecksum, type Sample } from '../../src/moth-engine/training/trainer.ts';
import { runMatch, playGame, type Player } from '../../src/moth-engine/training/selfplay.ts';
import { parseLichessPuzzles, pickSuite, runTactics, CORE_THEMES } from '../../src/moth-engine/training/tactics.ts';
import { bookKey, type OpeningBook } from '../../src/moth-engine/book.ts';
import { TeacherPool } from './teacher.ts';
import { decideCandidate, type Registry, type RegistryEntry } from '../../src/moth-engine/training/gate.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const MODELS = new URL('../../public/moth-engine/models/', import.meta.url);
const CACHE = new URL('../../.cache/moth-train/', import.meta.url);
mkdirSync(MODELS, { recursive: true }); mkdirSync(CACHE, { recursive: true });
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const wasmBytes = readFileSync(new URL('../../public/moth-engine/moth.wasm', import.meta.url));
const mk = (hash = 8) => MothWasm.create(wasmBytes, hash);
const engine = await mk(16);

// registry ------------------------------------------------------------------------------------
const regUrl = new URL('registry.json', MODELS);
const registry: Registry = existsSync(regUrl) ? JSON.parse(readFileSync(regUrl, 'utf8')) : { format: 'moth-registry-1', active: null, models: [] };
const active = registry.models.find((m) => m.id === registry.active) ?? null;
const parentNet: NetworkWeights | null = active ? decodeModel(readFileSync(new URL(active.file, MODELS))).weights : null;
const parentId = active?.id ?? 'classical';
log(`parent: ${parentId}`);

const settings: TrainingSettings = { ...DEFAULT_TRAINING, hidden: num('hidden', 64), epochs: num('epochs', 6), seed: num('seed', DEFAULT_TRAINING.seed + registry.models.length) };

// 1. human games -------------------------------------------------------------------------------
const seen = new Set<string>();
const pgn = gunzipSync(readFileSync(args.get('games')!)).toString('utf8');
const { positions: human, report } = ingestPgn(engine, pgn, { maxPositionsPerGame: num('per-game', 7), valFraction: settings.valFraction }, seen);
log(`human games: ${report.gamesValid}/${report.gamesRead} valid (${report.gamesRejected} rejected ${JSON.stringify(report.rejectReasons)}), ${human.length} positions, ${report.duplicatesSkipped} duplicates skipped`);
log(`  sacrifices offered: ${report.sacrifices.offered} ${JSON.stringify(report.sacrifices.byPiece)}; mates: ${report.mates.count} ${JSON.stringify(report.mates.byPiece)}`);

// 2. self-play with the parent ------------------------------------------------------------------
const book: OpeningBook | null = existsSync(new URL('../../public/moth-engine/book.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('../../public/moth-engine/book.json', import.meta.url), 'utf8')) : null;
const openings = openingSet(book, num('openings', 120), settings.seed);
const nSelf = num('selfplay', 200);
const selfPositions: TrainingPosition[] = [];
if (nSelf > 0) {
  const a = await mk(), b = await mk();
  const pa: Player = { name: parentId, engine: a, net: parentNet, style: 'balanced', nodes: num('sp-nodes', 5000) };
  const pb: Player = { ...pa, engine: b };
  const t0 = Date.now();
  for (let i = 0; i < nSelf; i++) {
    const op = openings[i % openings.length];
    const g = playGame(i % 2 ? pb : pa, i % 2 ? pa : pb, op);
    const white = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
    const gameId = hash32(`selfplay|${parentId}|${i}|${g.moves.join('')}`);
    const split: 'train' | 'val' = (gameId % 1000) / 1000 < settings.valFraction ? 'val' : 'train';
    g.records.forEach((r, j) => {
      if (j < 4 || j % 3 || seen.has(r.key)) return;
      seen.add(r.key);
      selfPositions.push({ fen: r.fen, key: r.key, result: r.stmWhite ? white : 1 - white, ply: j, gameId, played: g.moves[j], playedSee: 0, phase: 0, split });
    });
    if ((i + 1) % 50 === 0) log(`  self-play ${i + 1}/${nSelf} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  log(`self-play: ${nSelf} games, ${selfPositions.length} new positions`);
}

// 2b. off-distribution augmentation (random legal moves from human positions, teacher-labelled) ---------
const augmented = augment(engine, human, num('augment', 0.4), rng(settings.seed ^ 0xa5a5), seen);
log(`augmented positions: ${augmented.length}`);

// 3. teacher labels (cached by position key) ---------------------------------------------------------
const depth = num('label-depth', 8);
const labelFile = new URL(`labels-sf-d${depth}.json.gz`, CACHE);
const labels: Record<string, number> = existsSync(labelFile) ? JSON.parse(gunzipSync(readFileSync(labelFile)).toString()) : {};
const all = [...human, ...selfPositions, ...augmented];
const todo = all.filter((p) => labels[p.key] === undefined);
log(`labels cached: ${all.length - todo.length}, to label: ${todo.length} (Stockfish depth ${depth})`);
if (todo.length) {
  const pool = new TeacherPool(num('teachers', 2), depth);
  await pool.start();
  const t0 = Date.now();
  const CH = 20000;
  for (let s = 0; s < todo.length; s += CH) {
    const chunk = todo.slice(s, s + CH);
    const ev = await pool.label(chunk.map((p) => p.fen));
    chunk.forEach((p, i) => (labels[p.key] = ev[i]));
    writeFileSync(labelFile, gzipSync(JSON.stringify(labels)));
    log(`  labelled ${Math.min(todo.length, s + CH)}/${todo.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  pool.stop();
}
for (const p of all) p.teacher = labels[p.key];

// 4. samples: features + classical evaluation (balanced style, network off) ------------------------
engine.loadNetwork(null); engine.setStyle('balanced');
const toSample = (p: TrainingPosition): Sample | null => {
  if (!engine.setFen(p.fen) || !engine.isQuiet()) return null; // quiet positions only
  const f = engine.features();
  return { fw: Int16Array.from(f.white), fb: Int16Array.from(f.black), stmWhite: engine.sideToMove() === 'w', classical: engine.evaluate().classical, target: makeTarget(p.teacher, p.result, settings.lambda, settings.sigmoidK) };
};
const train: Sample[] = [], val: Sample[] = [];
for (const p of all) { const s = toSample(p); if (s) (p.split === 'val' ? val : train).push(s); }
const datasetHash = hash32(all.map((p) => p.key).sort().join('')).toString(16);
const valLossClassical = evaluateLoss(null, val, settings.sigmoidK);
const valLossParent = parentNet ? evaluateLoss(parentNet, val, settings.sigmoidK) : valLossClassical;
log(`samples: train ${train.length}, val ${val.length}; val loss classical ${valLossClassical.toFixed(5)}, parent ${valLossParent.toFixed(5)}`);

// 5. train -------------------------------------------------------------------------------------
const t0 = Date.now();
const init = parentNet && parentNet.hidden === settings.hidden ? parentNet : null;
const { net, history, bestValLoss } = trainNetwork(train, val, settings, init, (p) => { if (p.valLoss !== undefined) log(`  epoch ${p.epoch}: train ${p.trainLoss.toFixed(5)} val ${p.valLoss.toFixed(5)}`); });
log(`trained in ${((Date.now() - t0) / 1000).toFixed(0)}s; best val ${bestValLoss.toFixed(5)}; checksum ${init ? netChecksum(init) : 'random-init'} → ${netChecksum(net)}`);

// 6. gate --------------------------------------------------------------------------------------
const version = nextVersion(registry);
const id = `moth-nn-${version}-${netChecksum(net)}`;
const ca = await mk(), cb = await mk();
const cand: Player = { name: id, engine: ca, net, style: 'balanced', nodes: num('match-nodes', 6000) };
const base: Player = { name: parentId, engine: cb, net: parentNet, style: 'balanced', nodes: num('match-nodes', 6000) };
const nMatch = num('match', 100);
const tm = Date.now();
const { stats } = runMatch(cand, base, openings.slice(0, nMatch), (g, i, n) => { if (i % 40 === 0) log(`  match ${i}/${n}`); });
log(`match vs ${parentId}: +${stats.wins} =${stats.draws} -${stats.losses}  score ${(stats.score * 100).toFixed(1)}%  Elo ${stats.elo} ± ${stats.eloError}  LOS ${(stats.los * 100).toFixed(1)}%  (${((Date.now() - tm) / 1000).toFixed(0)}s)`);
const puzzles = parseLichessPuzzles(gunzipSync(readFileSync(args.get('puzzles')!)).toString('utf8'), engine);
const suite = pickSuite(puzzles, CORE_THEMES, num('per-theme', 12));
const tacticsCand = runTactics(engine, suite, { nodes: num('tactics-nodes', 60000), net });
const tacticsParent = runTactics(engine, suite, { nodes: num('tactics-nodes', 60000), net: parentNet });
log(`tactics (${suite.length} puzzles, 60k nodes): candidate ${tacticsCand.solved}, parent ${tacticsParent.solved}`);

const meta: ModelMeta = {
  id, version, parent: parentId, createdAt: Date.now(), hidden: settings.hidden, scale: net.scale, status: 'awaiting-validation', settings,
  data: { humanGames: report.gamesValid, selfPlayGames: nSelf, trainPositions: train.length, valPositions: val.length, datasetHash, teacher: `Stockfish 17.1 lite depth ${depth}` },
  metrics: { valLossClassical, valLossParent, valLoss: bestValLoss, trainLoss: history[history.length - 1]?.trainLoss, epochs: history, match: { ...stats, nodes: cand.nodes }, tactics: tacticsCand, parentTactics: tacticsParent },
};
const decision = decideCandidate(meta);
meta.status = decision.promoted ? 'approved' : 'rejected';
meta.decision = { ...decision, at: Date.now() };
const file = `${id}.mothnn`;
writeFileSync(new URL(file, MODELS), encodeModel(meta, net));
const entry: RegistryEntry = { id, version, file, status: meta.status, parent: parentId, createdAt: meta.createdAt, summary: { valLoss: bestValLoss, valLossParent, match: stats, tactics: { solved: tacticsCand.solved, total: tacticsCand.total }, parentTactics: { solved: tacticsParent.solved, total: tacticsParent.total } }, reasons: decision.reasons };
registry.models.push(entry);
if (decision.promoted) {
  for (const m of registry.models) if (m.id === registry.active) m.status = 'retired';
  registry.active = id;
  entry.status = 'approved';
}
writeFileSync(regUrl, JSON.stringify(registry, null, 2));
log(`${decision.promoted ? 'PROMOTED' : 'REJECTED'} ${id}: ${decision.reasons.join('; ')}`);
writeFileSync(new URL(`report-${id}.json`, CACHE), JSON.stringify({ meta, ingest: { ...report, sacrifices: { ...report.sacrifices, examples: report.sacrifices.examples.slice(0, 20) }, mates: { ...report.mates, examples: report.mates.examples.slice(0, 20) } } }, null, 2));

function nextVersion(reg: Registry): string {
  const n = reg.models.length + 1;
  return `2.0.${n}`;
}

/** Opening start lines: book positions reached by sound named lines (4–10 plies), deterministic. */
function openingSet(bk: OpeningBook | null, n: number, seed: number): string[][] {
  const lines: string[][] = [];
  if (!bk) return Array.from({ length: n }, () => []);
  // walk the book from the start position following sound moves
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const seenLines = new Set<string>();
  for (let tries = 0; lines.length < n && tries < n * 20; tries++) {
    engine.setFen(START);
    const ply = 4 + Math.floor(rnd() * 7);
    const line: string[] = [];
    for (let i = 0; i < ply; i++) {
      const p = bk.positions[bookKey(engine.fen())];
      const sound = p?.moves.filter((m) => !m.tags.includes('mistake') && m.eval >= (p.moves[0]?.eval ?? 0) - 40) ?? [];
      if (!sound.length) break;
      const m = sound[Math.floor(rnd() * sound.length)];
      line.push(m.uci); engine.play(m.uci);
    }
    const k = line.join(' ');
    if (line.length >= 4 && !seenLines.has(k)) { seenLines.add(k); lines.push(line); }
  }
  return lines;
}
