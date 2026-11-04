// Human-game ingestion: validates PGN games by replaying them through MOTH Engine, extracts training
// positions (deduplicated by Zobrist key, split train/validation *by game* so no game leaks across),
// and mines opening choices, sacrifices, mating patterns and endgame technique.
//
// Game results are only one signal: a move is never labelled "good" because the game was won. Move
// quality comes from the teacher engine's evaluation before and after the move (see teacher.ts /
// labelMoves), and the training target blends teacher evaluation with the result (λ).
import type { MothWasm } from '../wasm.ts';
import { parsePgnGame, splitPgn, type PgnGame } from './pgn.ts';

export interface TrainingPosition {
  fen: string;
  key: string;
  /** game result from the side to move's perspective: 1 win, 0.5 draw, 0 loss (undefined: augmented position) */
  result?: number;
  ply: number;
  gameId: number;
  /** move played by the human from this position */
  played: string;
  /** static exchange value of the played move (negative = material offered) */
  playedSee: number;
  phase: number; // 0 (bare kings) … 24 (all pieces)
  /** teacher evaluation, centipawns from the side to move (filled by labelling) */
  teacher?: number;
  split: 'train' | 'val';
  /** 'human' | 'selfplay' | 'augmented' (human position + random legal moves) */
  origin?: 'human' | 'selfplay' | 'augmented';
}

/**
 * Off-distribution augmentation: from a position, play 1–2 random legal moves. Search evaluates many
 * such unbalanced positions; training on them (teacher-labelled) keeps the network honest there.
 */
export function augment(engine: MothWasm, positions: TrainingPosition[], fraction: number, rnd: () => number, seen: Set<string>): TrainingPosition[] {
  const out: TrainingPosition[] = [];
  for (const p of positions) {
    if (rnd() >= fraction || !engine.setFen(p.fen)) continue;
    const plies = 1 + (rnd() < 0.5 ? 1 : 0);
    let ok = true;
    for (let i = 0; i < plies; i++) {
      const lm = engine.legalMoves();
      if (!lm.length) { ok = false; break; }
      engine.play(lm[Math.floor(rnd() * lm.length)]);
    }
    if (!ok || engine.gameState() !== 'ongoing' || engine.inCheck()) continue;
    const key = engine.key();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fen: engine.fen(), key, ply: p.ply + plies, gameId: p.gameId, played: '', playedSee: 0, phase: p.phase, split: p.split, origin: 'augmented' });
  }
  return out;
}

export interface IngestReport {
  gamesRead: number;
  gamesValid: number;
  gamesRejected: number;
  rejectReasons: Record<string, number>;
  duplicatesSkipped: number;
  positions: number;
  train: number;
  val: number;
  openings: Record<string, { games: number; whiteScore: number }>;
  sacrifices: { offered: number; byPiece: Record<string, number>; examples: { fen: string; move: string; see: number; gameId: number; won: boolean }[] };
  mates: { count: number; byPiece: Record<string, number>; examples: { fen: string; move: string }[] };
  endgames: { positions: number; conversions: number };
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function phaseOf(fen: string): number {
  let ph = 0;
  for (const ch of fen.split(' ')[0]) {
    const c = ch.toLowerCase();
    if (c === 'n' || c === 'b') ph += 1; else if (c === 'r') ph += 2; else if (c === 'q') ph += 4;
  }
  return Math.min(24, ph);
}
function pieceAt(fen: string, sq: string): string | null {
  const rows = fen.split(' ')[0].split('/');
  const r = 8 - Number(sq[1]), f = sq.charCodeAt(0) - 97;
  let c = 0;
  for (const ch of rows[r]) {
    if (/\d/.test(ch)) { c += Number(ch); continue; }
    if (c === f) return ch;
    c++;
  }
  return null;
}
/** 32-bit FNV-1a */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export interface IngestOptions {
  valFraction?: number; // fraction of games held out for validation (default 0.1)
  skipOpeningPlies?: number; // skip the first plies (book) for evaluation training (default 8)
  maxPositionsPerGame?: number; // sample cap per game to avoid long games dominating (default 40)
  seed?: number;
}

/**
 * Ingest PGN text. `seenKeys` carries deduplication across multiple calls (and against previously
 * ingested data); positions whose key was already seen are skipped.
 */
export function ingestPgn(engine: MothWasm, pgnText: string, opts: IngestOptions = {}, seenKeys = new Set<string>(), report?: IngestReport): { positions: TrainingPosition[]; report: IngestReport } {
  const valFraction = opts.valFraction ?? 0.1;
  const skip = opts.skipOpeningPlies ?? 8;
  const cap = opts.maxPositionsPerGame ?? 40;
  const rep: IngestReport = report ?? {
    gamesRead: 0, gamesValid: 0, gamesRejected: 0, rejectReasons: {}, duplicatesSkipped: 0, positions: 0, train: 0, val: 0, openings: {},
    sacrifices: { offered: 0, byPiece: {}, examples: [] }, mates: { count: 0, byPiece: {}, examples: [] }, endgames: { positions: 0, conversions: 0 },
  };
  const reject = (why: string) => { rep.gamesRejected++; rep.rejectReasons[why] = (rep.rejectReasons[why] ?? 0) + 1; };
  const positions: TrainingPosition[] = [];
  for (const text of splitPgn(pgnText)) {
    rep.gamesRead++;
    const g = parsePgnGame(text);
    if (!g) { reject('unparseable'); continue; }
    const v = replay(engine, g);
    if (!v.ok) { reject(v.reason); continue; }
    if (g.result === '*') { reject('no result'); continue; }
    rep.gamesValid++;
    const gameId = hash32(text);
    const split: 'train' | 'val' = (gameId % 1000) / 1000 < valFraction ? 'val' : 'train';
    const white = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
    // openings: first 8 plies of SAN, named by ECO header when present
    const opening = g.headers.Opening ?? g.sans.slice(0, 6).join(' ');
    const o = (rep.openings[opening] ??= { games: 0, whiteScore: 0 });
    o.games++; o.whiteScore += white;
    // stride sampling so long games do not dominate
    const usable = v.steps.length - skip;
    const stride = usable > cap ? usable / cap : 1;
    let nextPick = skip;
    for (let i = 0; i < v.steps.length; i++) {
      const st = v.steps[i];
      const stmWhite = st.fen.split(' ')[1] === 'w';
      const res = stmWhite ? white : 1 - white;
      // sacrifices: a move that offers material by static exchange (SEE <= -200)
      if (st.see <= -200) {
        rep.sacrifices.offered++;
        const piece = (pieceAt(st.fen, st.uci.slice(0, 2)) ?? '?').toLowerCase();
        rep.sacrifices.byPiece[piece] = (rep.sacrifices.byPiece[piece] ?? 0) + 1;
        if (rep.sacrifices.examples.length < 400) rep.sacrifices.examples.push({ fen: st.fen, move: st.uci, see: st.see, gameId, won: res === 1 });
      }
      if (st.phase <= 6) rep.endgames.positions++;
      if (i < nextPick || st.inCheck) continue;
      nextPick = Math.max(i + 1, Math.round(nextPick + stride));
      if (seenKeys.has(st.key)) { rep.duplicatesSkipped++; continue; }
      seenKeys.add(st.key);
      positions.push({ fen: st.fen, key: st.key, result: res, ply: i, gameId, played: st.uci, playedSee: st.see, phase: st.phase, split });
      if (split === 'train') rep.train++; else rep.val++;
    }
    if (v.mate) {
      rep.mates.count++;
      const piece = (pieceAt(v.mate.fen, v.mate.uci.slice(0, 2)) ?? '?').toLowerCase();
      rep.mates.byPiece[piece] = (rep.mates.byPiece[piece] ?? 0) + 1;
      if (rep.mates.examples.length < 200) rep.mates.examples.push({ fen: v.mate.fen, move: v.mate.uci });
    }
    if (v.steps.length && v.steps[v.steps.length - 1].phase <= 6 && white !== 0.5) rep.endgames.conversions++;
  }
  rep.positions += positions.length;
  return { positions, report: rep };
}

interface Step { fen: string; key: string; uci: string; see: number; phase: number; inCheck: boolean }
function replay(engine: MothWasm, g: PgnGame): { ok: true; steps: Step[]; mate?: { fen: string; uci: string } } | { ok: false; reason: string } {
  const start = g.headers.FEN && g.headers.SetUp === '1' ? g.headers.FEN : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  if (g.headers.Variant && g.headers.Variant !== 'Standard') return { ok: false, reason: 'variant' };
  if (!engine.setFen(start)) return { ok: false, reason: 'invalid start FEN' };
  if (g.sans.length < 10) return { ok: false, reason: 'too short' };
  const steps: Step[] = [];
  for (const san of g.sans) {
    const fen = engine.fen();
    const key = engine.key();
    const inCheck = engine.inCheck();
    const uci = engine.sanToUci(san);
    if (!uci) return { ok: false, reason: 'illegal move' };
    const see = engine.see(uci);
    steps.push({ fen, key, uci, see, phase: phaseOf(fen), inCheck });
    if (!engine.play(uci)) return { ok: false, reason: 'illegal move' };
  }
  const st = engine.gameState();
  const last = steps[steps.length - 1];
  if (st === 'checkmate') {
    if ((g.result === '1-0') !== (engine.sideToMove() === 'b')) return { ok: false, reason: 'result contradicts checkmate' };
    return { ok: true, steps, mate: { fen: last.fen, uci: last.uci } };
  }
  return { ok: true, steps };
}

/** Move quality from the teacher's evaluation before the move and after it (both from the mover's view). */
export function moveQuality(evalBefore: number, evalAfterFromMover: number): 'good' | 'inaccuracy' | 'mistake' | 'blunder' {
  const drop = evalBefore - evalAfterFromMover;
  if (drop >= 300) return 'blunder';
  if (drop >= 120) return 'mistake';
  if (drop >= 50) return 'inaccuracy';
  return 'good';
}

export { PIECE_VALUE };
