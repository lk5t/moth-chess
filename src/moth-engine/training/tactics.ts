// Tactical test suites: Lichess puzzles (CC0) grouped by theme — quick mates, sacrifices, forks, pins,
// discovered attacks, defensive resources, exposed kings… plus the classic Win At Chess positions.
import type { MothWasm, NetworkWeights, StyleName } from '../wasm.ts';
import type { TacticsResult } from '../model.ts';

export interface TacticPuzzle {
  id: string;
  /** position the engine must solve (after the opponent's first move has been applied) */
  fen: string;
  solution: string; // first engine move (UCI)
  line: string[]; // full solution line from this position
  themes: string[];
  rating: number;
}

/** Parse the Lichess puzzle CSV (PuzzleId,FEN,Moves,Rating,…,Themes). The first move is the opponent's. */
export function parseLichessPuzzles(csv: string, engine: MothWasm): TacticPuzzle[] {
  const out: TacticPuzzle[] = [];
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 8) continue;
    const [id, fen, moves, rating] = cols;
    const themes = cols[7].split(' ').filter(Boolean);
    const ms = moves.split(' ');
    if (ms.length < 2 || !engine.setFen(fen) || !engine.play(ms[0])) continue;
    out.push({ id, fen: engine.fen(), solution: ms[1], line: ms.slice(1), themes, rating: Number(rating) });
  }
  return out;
}

/** Win At Chess (Reinfeld, 1958) — classic tactical test positions (first ten, widely published test suite). */
export const WAC: { id: string; fen: string; best: string[] }[] = [
  { id: 'WAC.001', fen: '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', best: ['g3g6'] },
  { id: 'WAC.002', fen: '8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1', best: ['b3b2'] },
  { id: 'WAC.003', fen: '5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1', best: ['e3g3'] },
  { id: 'WAC.004', fen: 'r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1', best: ['h6h7'] },
  { id: 'WAC.005', fen: '5k2/6pp/p1qN4/1p1p4/3P4/2PKP2Q/PP3r2/3R4 b - - 0 1', best: ['c6c4'] },
  { id: 'WAC.006', fen: '7k/p7/1R5K/6r1/6p1/6P1/8/8 w - - 0 1', best: ['b6b7'] },
  { id: 'WAC.007', fen: 'rnbqkb1r/pppp1ppp/8/4P3/6n1/7P/PPPNPPP1/R1BQKBNR b KQkq - 0 1', best: ['g4e3'] },
  { id: 'WAC.008', fen: 'r4q1k/p2bR1rp/2p2Q1N/5p2/5p2/2P5/PP3PPP/R5K1 w - - 0 1', best: ['e7f7'] },
  { id: 'WAC.009', fen: '3q1rk1/p4pp1/2pb3p/3p4/6Pr/1PNQ4/P1PB1PP1/4RRK1 b - - 0 1', best: ['d6h2'] },
  { id: 'WAC.010', fen: '2br2k1/2q3rn/p2NppQ1/2p1P3/Pp5R/4P3/1P3PPP/3R2K1 w - - 0 1', best: ['h4h7'] },
];

export interface SolveOptions { movetimeMs?: number; nodes?: number; net?: NetworkWeights | null; style?: StyleName }

/**
 * Solve each puzzle with the engine. A puzzle counts as solved if the engine's move is the puzzle's
 * move, or — for mate themes — if the engine found a forced mate at least as short (any mating move
 * is a correct answer to a "mate in N").
 */
export function runTactics(engine: MothWasm, puzzles: TacticPuzzle[], opts: SolveOptions = {}, onEach?: (p: TacticPuzzle, ok: boolean, move: string | null) => void): TacticsResult {
  if (opts.net !== undefined) engine.loadNetwork(opts.net);
  engine.setStyle(opts.style ?? 'balanced');
  const byTheme: TacticsResult['byTheme'] = {};
  let solved = 0;
  for (const p of puzzles) {
    engine.newGame();
    engine.setFen(p.fen);
    const r = engine.search({ movetimeMs: opts.movetimeMs ?? (opts.nodes ? undefined : 100), nodes: opts.nodes });
    const mv = r.bestMove;
    let ok = mv === p.solution;
    const mateN = Number(/mateIn(\d)/.exec(p.themes.join(' '))?.[1] ?? 0);
    if (!ok && mateN && r.lines[0]) {
      const sc = engine.uciScore(r.lines[0].score);
      ok = sc.type === 'mate' && sc.value > 0 && sc.value <= mateN;
    }
    if (ok) solved++;
    for (const t of p.themes) { const b = (byTheme[t] ??= { solved: 0, total: 0 }); b.total++; if (ok) b.solved++; }
    onEach?.(p, ok, mv);
  }
  return { solved, total: puzzles.length, byTheme, budgetMs: opts.movetimeMs ?? 0 };
}

/** Deterministic subset: `perTheme` puzzles for each listed theme (puzzles can count for several). */
export function pickSuite(all: TacticPuzzle[], themes: string[], perTheme: number): TacticPuzzle[] {
  const chosen = new Map<string, TacticPuzzle>();
  for (const t of themes) {
    const ps = all.filter((p) => p.themes.includes(t)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, perTheme);
    for (const p of ps) chosen.set(p.id, p);
  }
  return [...chosen.values()];
}

export const CORE_THEMES = ['mateIn1', 'mateIn2', 'mateIn3', 'sacrifice', 'queensideAttack', 'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'defensiveMove', 'exposedKing', 'kingsideAttack', 'attraction', 'deflection', 'quietMove', 'hangingPiece', 'trappedPiece', 'endgame', 'smotheredMate', 'backRankMate', 'promotion', 'intermezzo', 'clearance', 'capturingDefender', 'xRayAttack'];
