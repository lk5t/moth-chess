// Self-play and engine matches between MOTH configurations / model versions.
// Used to (1) generate training positions and (2) benchmark a candidate model against its parent
// before promotion. Openings are varied (book lines), each opening is played twice with colours
// swapped, and games are adjudicated only on clear evidence from both engines.
import type { MothWasm, NetworkWeights, StyleName, RawLine } from '../wasm.ts';
import type { MatchResult } from '../model.ts';

export interface Player {
  name: string;
  engine: MothWasm;
  net: NetworkWeights | null;
  style: StyleName;
  /** search limit per move */
  nodes?: number;
  movetimeMs?: number;
}

export interface PlayedGame {
  opening: string[]; // UCI moves of the forced opening
  moves: string[]; // UCI moves played by the engines (after the opening)
  white: string;
  black: string;
  result: '1-0' | '0-1' | '1/2-1/2';
  reason: string;
  /** positions with the side-to-move evaluation from the engine that moved */
  records: { fen: string; key: string; score: number; stmWhite: boolean }[];
  plies: number;
}

function prepare(p: Player) {
  p.engine.loadNetwork(p.net);
  p.engine.setStyle(p.style);
  p.engine.newGame();
}

/** Play one game. Both players use their own engine instance (so they keep separate hash tables). */
export function playGame(white: Player, black: Player, opening: string[], maxPlies = 300, startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'): PlayedGame {
  prepare(white); prepare(black);
  const moves: string[] = [];
  const records: PlayedGame['records'] = [];
  const all = [...opening];
  const ref = white.engine; // referee: tracks the game state
  const setup = (e: MothWasm) => { e.setFen(startFen); for (const m of all) if (!e.play(m)) return false; return true; };
  if (!setup(ref)) throw new Error(`illegal opening ${opening.join(' ')}`);
  let winStreak = 0, lastWinner = 0, drawStreak = 0;
  let result: PlayedGame['result'] = '1/2-1/2', reason = 'max plies';
  for (let ply = 0; ply < maxPlies; ply++) {
    setup(ref);
    const state = ref.gameState();
    if (state !== 'ongoing') {
      if (state === 'checkmate') { result = ref.sideToMove() === 'w' ? '0-1' : '1-0'; reason = 'checkmate'; }
      else { result = '1/2-1/2'; reason = state; }
      break;
    }
    const stmWhite = ref.sideToMove() === 'w';
    const mover = stmWhite ? white : black;
    const fen = ref.fen(), key = ref.key();
    // the moving engine loads its own network/style (instances may be shared between players)
    if (mover.engine === (stmWhite ? black : white).engine) prepare(mover);
    setup(mover.engine);
    const r = mover.engine.search({ nodes: mover.nodes, movetimeMs: mover.movetimeMs });
    const best = r.bestMove;
    if (!best) break;
    const score = r.lines[0]?.score ?? 0;
    records.push({ fen, key, score, stmWhite });
    moves.push(best); all.push(best);
    // adjudication: decisive score confirmed over several consecutive moves
    const whiteView = stmWhite ? score : -score;
    if (Math.abs(score) >= 1000) { const w = Math.sign(whiteView); winStreak = w === lastWinner ? winStreak + 1 : 1; lastWinner = w; } else winStreak = 0;
    if (winStreak >= 6) { result = lastWinner > 0 ? '1-0' : '0-1'; reason = 'adjudicated (decisive score)'; break; }
    drawStreak = Math.abs(score) <= 10 && all.length > 80 ? drawStreak + 1 : 0;
    if (drawStreak >= 16) { result = '1/2-1/2'; reason = 'adjudicated (dead draw)'; break; }
    if (ply === maxPlies - 1) { result = '1/2-1/2'; reason = 'max plies'; }
  }
  return { opening, moves, white: white.name, black: black.name, result, reason, records, plies: all.length };
}

export function matchStats(wins: number, draws: number, losses: number, vs: string): MatchResult {
  const n = wins + draws + losses;
  const s = n ? (wins + draws / 2) / n : 0.5;
  const elo = (x: number) => (x <= 0 ? -999 : x >= 1 ? 999 : -400 * Math.log10(1 / x - 1));
  const variance = n ? (wins * (1 - s) ** 2 + draws * (0.5 - s) ** 2 + losses * (0 - s) ** 2) / n : 0;
  const se = n ? Math.sqrt(variance / n) : 0;
  const e = elo(s);
  const err = n ? (elo(Math.min(0.999, s + 1.96 * se)) - elo(Math.max(0.001, s - 1.96 * se))) / 2 : 0;
  const los = wins + losses ? 0.5 * (1 + erf((wins - losses) / Math.sqrt(2 * (wins + losses)))) : 0.5;
  return { games: n, wins, draws, losses, score: s, elo: Math.round(e * 10) / 10, eloError: Math.round(err * 10) / 10, los, vs };
}

function erf(x: number) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * Match `cand` vs `base` over `openings` (each played with both colours). Returns stats from the
 * candidate's perspective plus the games (whose positions can feed the next training round).
 */
export function runMatch(cand: Player, base: Player, openings: string[][], onGame?: (g: PlayedGame, i: number, total: number) => void, shouldStop?: () => boolean): { stats: MatchResult; games: PlayedGame[] } {
  let w = 0, d = 0, l = 0;
  const games: PlayedGame[] = [];
  const total = openings.length * 2;
  for (const op of openings) {
    for (const candWhite of [true, false]) {
      if (shouldStop?.()) return { stats: matchStats(w, d, l, base.name), games };
      const g = candWhite ? playGame(cand, base, op) : playGame(base, cand, op);
      games.push(g);
      if (g.result === '1/2-1/2') d++;
      else if ((g.result === '1-0') === candWhite) w++;
      else l++;
      onGame?.(g, games.length, total);
    }
  }
  return { stats: matchStats(w, d, l, base.name), games };
}

export function bestLine(lines: RawLine[]) { return lines[0]; }
