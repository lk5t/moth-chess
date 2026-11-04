// Strongly typed domain model for MOTH Chess.

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Square = `${'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h'}${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export type Orientation = 'white' | 'black';

export interface Piece { type: PieceType; color: Color }

/** A validated position. `key` = first four FEN fields (placement, side, castling, ep) — identity for transpositions. */
export interface Position {
  fen: string;
  key: string;
  turn: Color;
}

export interface MoveRecord {
  san: string;
  uci: string;
  from: Square;
  to: Square;
  promotion?: PieceType;
  fenBefore: string;
  fenAfter: string;
  color: Color;
  piece: PieceType;
  captured?: PieceType;
}

export type ScoreType = 'cp' | 'mate';
/** Raw engine score, always from the SIDE TO MOVE's perspective (UCI convention). */
export interface EngineScore { type: ScoreType; value: number }
/** Score converted to WHITE's perspective. `mate 0` (checkmate on the board) carries the winner explicitly. */
export interface WhiteScore { type: ScoreType; value: number; perspective: 'white'; winner?: Color }

export interface EngineLine {
  multipv: number;
  depth: number;
  seldepth?: number;
  score: EngineScore;
  whiteScore: WhiteScore;
  bound?: 'lower' | 'upper';
  pv: string[]; // UCI moves
  pvSan: string[];
  nodes?: number;
  nps?: number;
  timeMs?: number;
}

export interface EngineResult {
  fen: string;
  searchId: number;
  depth: number;
  lines: EngineLine[];
  bestMove?: string;
  ponder?: string;
  complete: boolean;
  fromCache?: boolean;
}

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'thinking' | 'stopping' | 'error' | 'restarting' | 'terminated';

export interface AnalysisOptions {
  depth: number;
  multiPv: number;
  moveTimeMs?: number; // 0/undefined = depth-limited only
}

export interface EngineConfig { threads: number; hashMb: number }

export interface Variation {
  id: string;
  rootFen: string;
  moves: string[]; // UCI
  san: string[];
  evalWhite?: WhiteScore;
  note?: string;
}

export interface AnalysisSession {
  id?: number;
  title: string;
  rootFen: string;
  createdAt: number;
  updatedAt: number;
  variations: Variation[];
  lastResult?: EngineResult;
  source: 'board' | 'overlay' | 'whatif' | 'review';
  tags: string[];
  folderId?: number;
  favorite?: boolean;
}

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

export interface SavedGame {
  id?: number;
  pgn: string;
  headers: Record<string, string>;
  white: string;
  black: string;
  result: GameResult;
  date?: string;
  eco?: string;
  openingName?: string;
  plyCount: number;
  contentHash: string;
  importedAt: number;
  userColor?: Color; // which side the user played, if known
  tags: string[];
  folderId?: number;
  favorite?: boolean;
  reviewId?: number;
}

export type MoveClass = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'book' | 'forced';

export interface ReviewedMove {
  ply: number;
  san: string;
  uci: string;
  color: Color;
  fenBefore: string;
  fenAfter: string;
  evalBefore: WhiteScore;
  evalAfter: WhiteScore;
  bestMoveUci?: string;
  bestMoveSan?: string;
  winBefore: number; // mover's win% before
  winAfter: number; // mover's win% after
  accuracy: number;
  classification: MoveClass;
  phase: GamePhase;
}

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

export interface GameReview {
  id?: number;
  gameId: number;
  depth: number;
  status: 'running' | 'paused' | 'complete' | 'cancelled';
  progressPly: number;
  totalPly: number;
  moves: ReviewedMove[];
  accuracyWhite?: number;
  accuracyBlack?: number;
  summary?: string[];
  /** raw per-position evaluations, kept so a paused/cancelled review can resume */
  evals?: { fen: string; score: WhiteScore; bestUci?: string; depth: number }[];
  createdAt: number;
  updatedAt: number;
}

export type ExerciseCategory = 'tactic' | 'opening' | 'middlegame' | 'endgame' | 'missed-win' | 'defence';
export type TacticalMotif = 'fork' | 'pin' | 'skewer' | 'hanging-piece' | 'check' | 'mate-threat' | 'material-gain' | 'positional' | 'promotion' | 'defensive';

export interface TrainingExercise {
  id?: number;
  fen: string;
  solutionUci: string;
  solutionSan: string;
  playedUci?: string;
  playedSan?: string;
  category: ExerciseCategory;
  motifs: TacticalMotif[];
  phase: GamePhase;
  evalLossWin: number; // win% the user lost in the game
  sourceGameId?: number;
  sourcePly?: number;
  explanation: string;
  createdAt: number;
  box: number; // Leitner box 0..4
  dueAt: number;
  contentHash: string;
}

export interface ExerciseAttempt {
  id?: number;
  exerciseId: number;
  at: number;
  correct: boolean;
  movePlayedUci: string;
  timeMs: number;
  category: ExerciseCategory;
  motifs: TacticalMotif[];
}

export interface SavedPosition {
  id?: number;
  fen: string;
  key: string;
  title: string;
  note?: string;
  createdAt: number;
  tags: string[];
  folderId?: number;
  favorite?: boolean;
  linkedGameIds: number[];
  lastEval?: WhiteScore;
}

export interface FavouriteOpening { id?: number; eco: string; name: string; moves: string; createdAt: number }

export interface Annotation { id?: number; positionKey: string; text: string; createdAt: number; updatedAt: number }

export interface Folder { id?: number; name: string; parentId?: number; createdAt: number }

export interface NeuralNode {
  key: string; // position key (shared across transpositions)
  fen: string;
  eval?: WhiteScore;
  depth?: number;
  collapsed?: boolean;
}
export interface NeuralEdge { id: string; from: string; to: string; uci: string; san: string; source: 'engine' | 'user' | 'whatif' }
export interface NeuralTree {
  id?: number;
  title: string;
  rootKey: string;
  nodes: Record<string, NeuralNode>;
  edges: NeuralEdge[];
  createdAt: number;
  updatedAt: number;
  tags: string[];
  favorite?: boolean;
}

export interface Simulation {
  id?: number;
  title: string;
  baseFen: string;
  moves: string[];
  san: string[];
  evalBefore?: WhiteScore;
  evalAfter?: WhiteScore;
  createdAt: number;
}

export interface Arrow { from: Square; to: Square; color: string; width: number; opacity: number; rank: number }
