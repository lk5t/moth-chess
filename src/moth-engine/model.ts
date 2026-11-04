// MOTH evaluation-model file format (.mothnn) and registry types. Environment-neutral.
//
// Layout: "MOTHNN02" | u32 metaJsonLength | meta JSON (UTF-8) | zero padding to 4 bytes |
//         float32 W1[768*H] | B1[H] | W2[2H] | B2 | scale
import type { NetworkWeights } from './wasm.ts';

export type ModelStatus = 'training' | 'awaiting-validation' | 'approved' | 'rejected' | 'retired';

export interface TrainingSettings {
  seed: number;
  hidden: number;
  epochs: number;
  batchSize: number;
  learningRate: number;
  /** blend between teacher evaluation (1) and game result (0) in the training target */
  lambda: number;
  /** sigmoid scale K used to map centipawns to expected score */
  sigmoidK: number;
  weightDecay: number;
  valFraction: number;
}

export interface MatchResult { games: number; wins: number; draws: number; losses: number; score: number; elo: number; eloError: number; los: number; vs: string; movetimeMs?: number; nodes?: number }
export interface TacticsResult { solved: number; total: number; byTheme: Record<string, { solved: number; total: number }>; budgetMs: number }

export interface ModelMeta {
  id: string; // e.g. moth-nn-2.0.0-a1b2c3
  version: string; // semver
  parent?: string; // id of the model it was trained from / compared against
  createdAt: number;
  hidden: number;
  scale: number;
  status: ModelStatus;
  settings: TrainingSettings;
  data: {
    humanGames: number;
    selfPlayGames: number;
    trainPositions: number;
    valPositions: number;
    datasetHash: string;
    teacher: string; // which engine labelled the positions
  };
  metrics: {
    valLossClassical?: number; // validation loss of the classical evaluation alone (network output 0)
    valLossParent?: number;
    valLoss?: number;
    trainLoss?: number;
    epochs?: { epoch: number; trainLoss: number; valLoss: number }[];
    match?: MatchResult;
    tactics?: TacticsResult;
    parentTactics?: TacticsResult;
  };
  decision?: { promoted: boolean; reasons: string[]; at: number };
  notes?: string[];
}

export interface ModelFile { meta: ModelMeta; weights: NetworkWeights }

const MAGIC = 'MOTHNN02';

export function encodeModel(meta: ModelMeta, w: NetworkWeights): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const head = 8 + 4 + json.length;
  const pad = (4 - (head % 4)) % 4;
  const floats = w.w1.length + w.b1.length + w.w2.length + 2;
  const out = new Uint8Array(head + pad + floats * 4);
  for (let i = 0; i < 8; i++) out[i] = MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  const f = new Float32Array(out.buffer, head + pad, floats);
  f.set(w.w1, 0);
  f.set(w.b1, w.w1.length);
  f.set(w.w2, w.w1.length + w.b1.length);
  f[floats - 2] = w.b2;
  f[floats - 1] = w.scale;
  return out;
}

export function decodeModel(bytes: ArrayBuffer | Uint8Array): ModelFile {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(u8[i]);
  if (magic !== MAGIC) throw new Error('not a MOTH model file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jl = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + jl))) as ModelMeta;
  const head = 12 + jl;
  const pad = (4 - (head % 4)) % 4;
  const h = meta.hidden;
  const floats = 768 * h + h + 2 * h + 2;
  // explicit copy: aligned, and independent of the source (Node Buffers are views into a shared pool)
  const raw = u8.subarray(head + pad, head + pad + floats * 4);
  if (raw.length !== floats * 4) throw new Error('truncated model file');
  const copy = new Uint8Array(floats * 4);
  copy.set(raw);
  const f = new Float32Array(copy.buffer);
  if (f.length !== floats) throw new Error('truncated model file');
  return {
    meta,
    weights: {
      hidden: h,
      w1: f.slice(0, 768 * h),
      b1: f.slice(768 * h, 768 * h + h),
      w2: f.slice(768 * h + h, 768 * h + 3 * h),
      b2: f[floats - 2],
      scale: f[floats - 1],
    },
  };
}

/** Deterministic PRNG (mulberry32) — reproducible training runs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zero-initialised network of the given width (output is exactly 0 → pure classical evaluation). */
export function zeroNetwork(hidden: number, scale = 100): NetworkWeights {
  return { hidden, w1: new Float32Array(768 * hidden), b1: new Float32Array(hidden), w2: new Float32Array(2 * hidden), b2: 0, scale };
}

export function randomNetwork(hidden: number, seed: number, scale = 100): NetworkWeights {
  const r = rng(seed);
  const n = zeroNetwork(hidden, scale);
  const s1 = 0.08;
  for (let i = 0; i < n.w1.length; i++) n.w1[i] = (r() * 2 - 1) * s1;
  for (let i = 0; i < hidden; i++) n.b1[i] = 0.25 + r() * 0.25;
  // small output weights: the residual starts close to the classical evaluation
  for (let i = 0; i < n.w2.length; i++) n.w2[i] = (r() * 2 - 1) * 0.01;
  return n;
}
