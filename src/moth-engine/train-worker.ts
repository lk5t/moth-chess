// Learning Lab worker (dist/moth-train-worker.js): in-extension evolution run on the user's own games.
// Same pipeline as the offline trainer — ingest → augment → label → train → gate — but sized for a
// browser and using a deeper MOTH search as the teacher (the offline pipeline uses Stockfish).
// Runs in its own worker, completely separate from analysis and play.
import { MothWasm } from './wasm.ts';
import { decodeModel, encodeModel, rng, type ModelMeta } from './model.ts';
import { ingestPgn, augment, hash32, type TrainingPosition } from './training/ingest.ts';
import { DEFAULT_TRAINING, evaluateLoss, makeTarget, netChecksum, trainNetwork, type Sample } from './training/trainer.ts';
import { runMatch, playGame, type Player } from './training/selfplay.ts';
import { runTactics, type TacticPuzzle } from './training/tactics.ts';
import { decideCandidate } from './training/gate.ts';
import type { OpeningBook } from './book.ts';
import { bookKey } from './book.ts';

declare const self: DedicatedWorkerGlobalScope;
const asset = (p: string) => new URL(`moth-engine/${p}`, self.location.href).toString();
let stop = false;
const log = (msg: string) => self.postMessage({ type: 'log', msg });

export interface LabParams { pgns: string[]; parentBytes?: ArrayBuffer | null; parentId: string; teacherDepth: number; selfPlayGames: number; matchOpenings: number; epochs: number; seed: number }

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: 'start'; params: LabParams } | { type: 'stop' };
  if (m.type === 'stop') { stop = true; return; }
  try {
    const out = await run(m.params);
    if (out) self.postMessage({ type: 'done', meta: out.meta, bytes: out.bytes }, [out.bytes]);
    else self.postMessage({ type: 'cancelled' });
  } catch (err) {
    self.postMessage({ type: 'error', msg: String((err as Error)?.message ?? err) });
  }
};

async function run(p: LabParams): Promise<{ meta: ModelMeta; bytes: ArrayBuffer } | null> {
  const wasm = await (await fetch(asset('moth.wasm'))).arrayBuffer();
  const mod = await WebAssembly.compile(wasm);
  const eng = await MothWasm.create(mod, 16);
  const parent = p.parentBytes ? decodeModel(p.parentBytes) : null;
  const parentNet = parent?.weights ?? null;
  const settings = { ...DEFAULT_TRAINING, hidden: parentNet?.hidden ?? 64, epochs: p.epochs, seed: p.seed };
  const book = (await (await fetch(asset('book.json'))).json()) as OpeningBook;
  const puzzles = (await (await fetch(asset('tactics.json'))).json()) as { puzzles: TacticPuzzle[] };

  // 1. user's games
  const seen = new Set<string>();
  const { positions, report } = ingestPgn(eng, p.pgns.join('\n\n'), { maxPositionsPerGame: 30 }, seen);
  log(`Games: ${report.gamesValid} valid of ${report.gamesRead} (${report.gamesRejected} rejected), ${positions.length} positions, ${report.duplicatesSkipped} duplicates skipped`);
  if (report.gamesValid < 5 || positions.length < 150) throw new Error(`Not enough data to train responsibly (${report.gamesValid} games, ${positions.length} positions) — import or play more games first.`);
  if (stop) return null;

  // 2. self-play with the parent from book openings
  const openings = bookOpenings(eng, book, Math.max(p.selfPlayGames, p.matchOpenings), p.seed);
  const self1 = await MothWasm.create(mod, 8), self2 = await MothWasm.create(mod, 8);
  const sp: TrainingPosition[] = [];
  for (let i = 0; i < p.selfPlayGames && !stop; i++) {
    const a: Player = { name: p.parentId, engine: self1, net: parentNet, style: 'balanced', nodes: 2500 };
    const b: Player = { ...a, engine: self2 };
    const g = playGame(i % 2 ? b : a, i % 2 ? a : b, openings[i % openings.length]);
    const white = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
    const gid = hash32(`lab|${i}|${g.moves.join('')}`);
    g.records.forEach((r, j) => { if (j >= 4 && j % 3 === 0 && !seen.has(r.key)) { seen.add(r.key); sp.push({ fen: r.fen, key: r.key, result: r.stmWhite ? white : 1 - white, ply: j, gameId: gid, played: '', playedSee: 0, phase: 0, split: gid % 10 === 0 ? 'val' : 'train', origin: 'selfplay' }); } });
    if ((i + 1) % 5 === 0) log(`Self-play ${i + 1}/${p.selfPlayGames}`);
  }
  const aug = augment(eng, positions, 0.4, rng(p.seed ^ 0xa5a5), seen);
  const all = [...positions, ...sp, ...aug];
  log(`Self-play positions ${sp.length}, augmented ${aug.length}; labelling ${all.length} positions with MOTH depth ${p.teacherDepth}…`);

  // 3. teacher labels: a deeper MOTH search (stronger than the static evaluation being trained)
  eng.loadNetwork(parentNet); eng.setStyle('balanced');
  for (let i = 0; i < all.length && !stop; i++) {
    eng.setFen(all[i].fen);
    const r = eng.search({ depth: p.teacherDepth, nodes: 60000 });
    const s = r.lines[0]?.score ?? 0;
    all[i].teacher = Math.abs(s) > eng.MATE_BOUND ? Math.sign(s) * 2000 : s;
    if ((i + 1) % 500 === 0) log(`Labelled ${i + 1}/${all.length}`);
  }
  if (stop) return null;

  // 4. train (fine-tune from the parent when shapes match)
  eng.loadNetwork(null);
  const toSample = (q: TrainingPosition): Sample | null => {
    if (!eng.setFen(q.fen) || !eng.isQuiet()) return null; // quiet positions only
    const f = eng.features();
    return { fw: Int16Array.from(f.white), fb: Int16Array.from(f.black), stmWhite: eng.sideToMove() === 'w', classical: eng.evaluate().classical, target: makeTarget(q.teacher, q.result, settings.lambda, settings.sigmoidK) };
  };
  const train: Sample[] = [], val: Sample[] = [];
  for (const q of all) { const s = toSample(q); if (s) (q.split === 'val' ? val : train).push(s); }
  const valLossClassical = evaluateLoss(null, val, settings.sigmoidK);
  const valLossParent = parentNet ? evaluateLoss(parentNet, val, settings.sigmoidK) : valLossClassical;
  log(`Training on ${train.length} positions (validation ${val.length}); parent validation loss ${valLossParent.toFixed(5)}`);
  const { net, history, bestValLoss } = trainNetwork(train, val, settings, parentNet, (pr) => { if (pr.valLoss !== undefined) log(`Epoch ${pr.epoch}: train ${pr.trainLoss.toFixed(5)} · validation ${pr.valLoss.toFixed(5)}`); }, () => stop);
  if (stop) return null;

  // 5. gate: match vs parent + tactics vs parent + validation loss
  const ca = await MothWasm.create(mod, 8), cb = await MothWasm.create(mod, 8);
  const id = `lab-${new Date().toISOString().slice(0, 10)}-${netChecksum(net)}`;
  log(`Benchmark match vs ${p.parentId} (${p.matchOpenings * 2} games)…`);
  const { stats } = runMatch({ name: id, engine: ca, net, style: 'balanced', nodes: 3000 }, { name: p.parentId, engine: cb, net: parentNet, style: 'balanced', nodes: 3000 }, openings.slice(0, p.matchOpenings), (_g, i, n) => { if (i % 10 === 0) log(`Match ${i}/${n}`); }, () => stop);
  if (stop) return null;
  const suite = puzzles.puzzles.slice(0, 120);
  const tc = runTactics(eng, suite, { nodes: 30000, net });
  const tp = runTactics(eng, suite, { nodes: 30000, net: parentNet });
  const meta: ModelMeta = {
    id, version: `lab-${history.length}e`, parent: p.parentId, createdAt: Date.now(), hidden: net.hidden, scale: net.scale, status: 'awaiting-validation', settings,
    data: { humanGames: report.gamesValid, selfPlayGames: p.selfPlayGames, trainPositions: train.length, valPositions: val.length, datasetHash: hash32(all.map((q) => q.key).join('')).toString(16), teacher: `MOTH Engine depth ${p.teacherDepth}` },
    metrics: { valLossClassical, valLossParent, valLoss: bestValLoss, trainLoss: history[history.length - 1]?.trainLoss, epochs: history, match: { ...stats, nodes: 3000 }, tactics: tc, parentTactics: tp },
  };
  const d = decideCandidate(meta);
  meta.status = d.promoted ? 'approved' : 'rejected';
  meta.decision = { ...d, at: Date.now() };
  log(`${d.promoted ? 'APPROVED' : 'REJECTED'}: ${d.reasons.join('; ')}`);
  const bytes = encodeModel(meta, net);
  return { meta, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
}

function bookOpenings(eng: MothWasm, book: OpeningBook, n: number, seed: number): string[][] {
  const r = rng(seed);
  const out: string[][] = [];
  const seenLines = new Set<string>();
  for (let t = 0; out.length < n && t < n * 20; t++) {
    eng.setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const line: string[] = [];
    const ply = 4 + Math.floor(r() * 6);
    for (let i = 0; i < ply; i++) {
      const pos = book.positions[bookKey(eng.fen())];
      const sound = pos?.moves.filter((m) => !m.tags.includes('mistake') && m.eval >= (pos.moves[0]?.eval ?? 0) - 40) ?? [];
      if (!sound.length) break;
      const mv = sound[Math.floor(r() * sound.length)];
      line.push(mv.uci); eng.play(mv.uci);
    }
    const k = line.join(' ');
    if (line.length >= 4 && !seenLines.has(k)) { seenLines.add(k); out.push(line); }
  }
  return out;
}
