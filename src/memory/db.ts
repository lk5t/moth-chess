// Personal Chess Memory — IndexedDB via Dexie. All data stays on this device.
import Dexie, { type Table } from 'dexie';
import type {
  SavedGame, GameReview, SavedPosition, FavouriteOpening, AnalysisSession, NeuralTree, TrainingExercise, ExerciseAttempt, Annotation, Folder, Simulation,
} from '@/types';
import { fnv1a } from '@/utils/hash';
import { parsePgn, positionKey } from '@/chess/position';

export type StoredGame = SavedGame & { posHashes?: string[] };

/** A finished game against MOTH plus the per-move analysis used for personal adaptation. */
export interface PracticeGame {
  id?: number;
  gameId?: number; // id in `games` when saved to Memory
  at: number;
  userColor: 'w' | 'b';
  style: 'aggressive' | 'balanced' | 'defensive';
  level: number;
  timeControl: string;
  result: '1-0' | '0-1' | '1/2-1/2';
  reason: string;
  uci: string[];
  openingKey: string; // first moves (up to 8 plies) in UCI
  openingName?: string;
  eco?: string;
  /** user moves classified by MOTH's evaluation drop */
  userMoves: { ply: number; uci: string; before: number; after: number; best?: string; tags: string[] }[];
}

/** Engine models trained inside the extension (Learning Lab). */
export interface StoredModel { id?: number; modelId: string; meta: import('@/moth-engine/model').ModelMeta; bytes: ArrayBuffer; createdAt: number }

/** Measured engine move latencies (move requests, not analysis). */
export interface LatencySample { id?: number; at: number; ms: number; source: 'book' | 'cache' | 'search' | 'ponder'; engine: string; context: 'play' | 'board' | 'bench' }

export interface TrainingRun { id?: number; at: number; status: 'running' | 'done' | 'failed' | 'cancelled'; log: string[]; candidateId?: string; promoted?: boolean; params: Record<string, unknown> }

export class MothDB extends Dexie {
  games!: Table<StoredGame, number>;
  reviews!: Table<GameReview, number>;
  positions!: Table<SavedPosition, number>;
  openings!: Table<FavouriteOpening, number>;
  sessions!: Table<AnalysisSession, number>;
  trees!: Table<NeuralTree, number>;
  exercises!: Table<TrainingExercise, number>;
  attempts!: Table<ExerciseAttempt, number>;
  annotations!: Table<Annotation, number>;
  folders!: Table<Folder, number>;
  simulations!: Table<Simulation, number>;
  practice!: Table<PracticeGame, number>;
  models!: Table<StoredModel, number>;
  latency!: Table<LatencySample, number>;
  runs!: Table<TrainingRun, number>;

  constructor(name = 'moth-chess') {
    super(name);
    // v1 — initial schema
    this.version(1).stores({
      games: '++id, contentHash, white, black, eco, result, importedAt, *tags, folderId',
      positions: '++id, key, createdAt, *tags, folderId',
      openings: '++id, eco, name',
      sessions: '++id, updatedAt, source, *tags, folderId',
      exercises: '++id, contentHash, category, sourceGameId',
      annotations: '++id, positionKey',
      folders: '++id, parentId, name',
    });
    // v2 — reviews, neural trees, attempts, simulations; spaced repetition; position linking index.
    this.version(2)
      .stores({
        games: '++id, contentHash, white, black, eco, result, importedAt, *tags, folderId, *posHashes',
        reviews: '++id, gameId, status, updatedAt',
        trees: '++id, rootKey, updatedAt, *tags',
        attempts: '++id, exerciseId, at, category',
        simulations: '++id, createdAt',
        exercises: '++id, contentHash, category, sourceGameId, dueAt, box',
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        await tx.table('exercises').toCollection().modify((e: TrainingExercise) => {
          if (typeof e.box !== 'number') e.box = 0;
          if (typeof e.dueAt !== 'number') e.dueAt = now;
          if (!Array.isArray(e.motifs)) e.motifs = [];
        });
        await tx.table('games').toCollection().modify((g: StoredGame) => {
          if (!Array.isArray(g.tags)) g.tags = [];
          if (!g.posHashes) g.posHashes = positionHashesForPgn(g.pgn);
        });
        await tx.table('positions').toCollection().modify((p: SavedPosition) => {
          if (!Array.isArray(p.linkedGameIds)) p.linkedGameIds = [];
          if (!Array.isArray(p.tags)) p.tags = [];
        });
      });
    // v3 — MOTH Engine: practice games (personal adaptation), trained models, latency samples, training runs
    this.version(3).stores({
      practice: '++id, at, userColor, openingKey, result, gameId',
      models: '++id, &modelId, createdAt',
      latency: '++id, at, source, context',
      runs: '++id, at, status',
    });
  }
}

/** Short hashes of every position in a game — indexed for fast "which games reached this position?". */
export function positionHashesForPgn(pgn: string): string[] {
  try {
    const g = parsePgn(pgn);
    const set = new Set<string>([fnv1a(positionKey(g.startFen))]);
    for (const m of g.moves) set.add(fnv1a(positionKey(m.fenAfter)));
    return [...set];
  } catch {
    return [];
  }
}

let instance: MothDB | null = null;
export function db(): MothDB {
  if (!instance) instance = new MothDB();
  return instance;
}
/** Tests use isolated databases. */
export function setDb(d: MothDB | null) { instance = d; }

export const TABLES = ['games', 'reviews', 'positions', 'openings', 'sessions', 'trees', 'exercises', 'attempts', 'annotations', 'folders', 'simulations', 'practice', 'models', 'latency', 'runs'] as const;
export type TableName = (typeof TABLES)[number];
