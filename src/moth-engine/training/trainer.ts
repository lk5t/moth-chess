// NNUE-style residual network trainer (real gradient descent, no external dependencies).
//
// Model:  eval(pos) = classical(pos) + scale · ( W2ᵀ [ crelu(acc_stm) ; crelu(acc_other) ] + b2 )
//         acc_p = B1 + Σ W1[feature(p, piece, square)]      (sparse 768-input, shared weights)
// Target: t = λ · σ(teacher / K) + (1 − λ) · result          (result from the side to move)
// Loss:   mean squared error between σ(eval / K) and t
//
// Training uses Adam with lazy (row-sparse) updates for W1 so a step only touches the ~30 rows of
// active features per position. Everything is seeded → runs are reproducible.
import type { NetworkWeights } from '../wasm.ts';
import { rng, randomNetwork } from '../model.ts';
import type { TrainingSettings } from '../model.ts';

export interface Sample {
  /** active feature indices from White's and Black's perspective */
  fw: Int16Array;
  fb: Int16Array;
  stmWhite: boolean;
  classical: number; // classical evaluation, side to move, centipawns
  target: number; // 0..1
}

export const DEFAULT_TRAINING: TrainingSettings = {
  seed: 20261104, hidden: 64, epochs: 6, batchSize: 256, learningRate: 0.0015, lambda: 0.75, sigmoidK: 400, weightDecay: 1e-4, valFraction: 0.1,
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** Must match NN_CLAMP in engine/moth/moth.cpp: the network is a bounded residual correction. */
export const NN_CLAMP = 250;

/** Training target. `result` undefined (augmented positions not from a real game) → teacher only. */
export function makeTarget(teacherCp: number | undefined, result: number | undefined, lambda: number, K: number): number {
  if (teacherCp === undefined) return result ?? 0.5;
  if (result === undefined) return sigmoid(Math.max(-2000, Math.min(2000, teacherCp)) / K);
  const t = Math.max(-2000, Math.min(2000, teacherCp));
  return lambda * sigmoid(t / K) + (1 - lambda) * result;
}

/** Network output in centipawns (same arithmetic as eval_nnue in the engine, before the ±NN_CLAMP clamp). */
export function forwardCp(net: NetworkWeights, s: Sample, accA?: Float32Array, accB?: Float32Array): number {
  const H = net.hidden;
  const a = accA ?? new Float32Array(H), b = accB ?? new Float32Array(H);
  a.set(net.b1); b.set(net.b1);
  const fs = s.stmWhite ? s.fw : s.fb, fo = s.stmWhite ? s.fb : s.fw;
  for (let k = 0; k < fs.length; k++) { const o = fs[k] * H; for (let i = 0; i < H; i++) a[i] += net.w1[o + i]; }
  for (let k = 0; k < fo.length; k++) { const o = fo[k] * H; for (let i = 0; i < H; i++) b[i] += net.w1[o + i]; }
  let out = net.b2;
  for (let i = 0; i < H; i++) {
    const x = a[i] < 0 ? 0 : a[i] > 1 ? 1 : a[i];
    const y = b[i] < 0 ? 0 : b[i] > 1 ? 1 : b[i];
    out += x * net.w2[i] + y * net.w2[H + i];
  }
  return out * net.scale;
}

/** Validation loss (MSE on expected score). With `classicalOnly` the network contribution is 0. */
export function evaluateLoss(net: NetworkWeights | null, data: Sample[], K: number, clampCp = NN_CLAMP): number {
  if (!data.length) return NaN;
  const H = net?.hidden ?? 0;
  const a = new Float32Array(H), b = new Float32Array(H);
  let sum = 0;
  for (const s of data) {
    let nn = net ? forwardCp(net, s, a, b) : 0;
    nn = Math.max(-clampCp, Math.min(clampCp, nn));
    const p = sigmoid((s.classical + nn) / K);
    sum += (p - s.target) ** 2;
  }
  return sum / data.length;
}

export interface TrainProgress { epoch: number; step: number; steps: number; trainLoss: number; valLoss?: number }

/**
 * Train a network on `train`, reporting validation loss each epoch. `init` continues from an
 * existing network (fine-tuning); otherwise a seeded random network is created. Returns the
 * network from the best validation epoch (early stopping on validation loss).
 */
export function trainNetwork(train: Sample[], val: Sample[], settings: TrainingSettings, init?: NetworkWeights | null, onProgress?: (p: TrainProgress) => void, shouldStop?: () => boolean): { net: NetworkWeights; history: { epoch: number; trainLoss: number; valLoss: number }[]; bestValLoss: number } {
  const H = settings.hidden, K = settings.sigmoidK;
  const net: NetworkWeights = init && init.hidden === H
    ? { hidden: H, w1: init.w1.slice(), b1: init.b1.slice(), w2: init.w2.slice(), b2: init.b2, scale: init.scale }
    : randomNetwork(H, settings.seed);
  const r = rng(settings.seed ^ 0x5bd1e995);
  // Adam state
  const mW1 = new Float32Array(net.w1.length), vW1 = new Float32Array(net.w1.length), tW1 = new Int32Array(768);
  const mB1 = new Float32Array(H), vB1 = new Float32Array(H), mW2 = new Float32Array(2 * H), vW2 = new Float32Array(2 * H);
  let mB2 = 0, vB2 = 0, t = 0;
  const b1a = 0.9, b2a = 0.999, eps = 1e-8, lr = settings.learningRate, wd = settings.weightDecay;
  // gradient buffers
  const gW1rows = new Map<number, Float32Array>();
  const gB1 = new Float32Array(H), gW2 = new Float32Array(2 * H);
  const accS = new Float32Array(H), accO = new Float32Array(H);
  const order = new Uint32Array(train.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  const history: { epoch: number; trainLoss: number; valLoss: number }[] = [];
  let best = { loss: evaluateLoss(net, val, K), net: cloneNet(net) };
  const steps = Math.ceil(train.length / settings.batchSize);

  for (let epoch = 1; epoch <= settings.epochs; epoch++) {
    // shuffle (Fisher–Yates, seeded)
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
    let lossSum = 0;
    for (let step = 0; step < steps; step++) {
      if (shouldStop?.()) return { net: best.net, history, bestValLoss: best.loss };
      gW1rows.clear(); gB1.fill(0); gW2.fill(0);
      let gB2 = 0;
      const from = step * settings.batchSize, to = Math.min(train.length, from + settings.batchSize), n = to - from;
      for (let bi = from; bi < to; bi++) {
        const s = train[order[bi]];
        const fs = s.stmWhite ? s.fw : s.fb, fo = s.stmWhite ? s.fb : s.fw;
        accS.set(net.b1); accO.set(net.b1);
        for (let k = 0; k < fs.length; k++) { const o = fs[k] * H; for (let i = 0; i < H; i++) accS[i] += net.w1[o + i]; }
        for (let k = 0; k < fo.length; k++) { const o = fo[k] * H; for (let i = 0; i < H; i++) accO[i] += net.w1[o + i]; }
        let out = net.b2;
        for (let i = 0; i < H; i++) {
          const x = accS[i] < 0 ? 0 : accS[i] > 1 ? 1 : accS[i];
          const y = accO[i] < 0 ? 0 : accO[i] > 1 ? 1 : accO[i];
          out += x * net.w2[i] + y * net.w2[H + i];
        }
        const nnCp = out * net.scale;
        const clamped = nnCp > NN_CLAMP || nnCp < -NN_CLAMP; // the engine clamps the network output
        const p = sigmoid((s.classical + Math.max(-NN_CLAMP, Math.min(NN_CLAMP, nnCp))) / K);
        const err = p - s.target;
        lossSum += err * err;
        if (clamped) continue; // no gradient through the clamp
        // dL/dout = 2·err·p(1−p)/K·scale  (averaged over the batch)
        const g = (2 * err * p * (1 - p) * net.scale) / K / n;
        gB2 += g;
        for (let i = 0; i < H; i++) {
          const x = accS[i], y = accO[i];
          gW2[i] += g * (x < 0 ? 0 : x > 1 ? 1 : x);
          gW2[H + i] += g * (y < 0 ? 0 : y > 1 ? 1 : y);
        }
        // backprop into the accumulators (clipped ReLU gradient is 1 inside (0,1))
        for (let side = 0; side < 2; side++) {
          const acc = side === 0 ? accS : accO, feats = side === 0 ? fs : fo, w2o = side === 0 ? 0 : H;
          for (let k = 0; k < feats.length; k++) {
            const f = feats[k];
            let row = gW1rows.get(f);
            if (!row) { row = new Float32Array(H); gW1rows.set(f, row); }
            for (let i = 0; i < H; i++) if (acc[i] > 0 && acc[i] < 1) row[i] += g * net.w2[w2o + i];
          }
          for (let i = 0; i < H; i++) if (acc[i] > 0 && acc[i] < 1) gB1[i] += g * net.w2[w2o + i];
        }
      }
      // Adam update
      t++;
      const c1 = 1 - Math.pow(b1a, t), c2 = 1 - Math.pow(b2a, t);
      const upd = (w: Float32Array, m: Float32Array, v: Float32Array, idx: number, grad: number, decay: boolean) => {
        const gg = grad + (decay ? wd * w[idx] : 0);
        m[idx] = b1a * m[idx] + (1 - b1a) * gg;
        v[idx] = b2a * v[idx] + (1 - b2a) * gg * gg;
        w[idx] -= (lr * (m[idx] / c1)) / (Math.sqrt(v[idx] / c2) + eps);
      };
      for (const [f, row] of gW1rows) {
        tW1[f] = t;
        const o = f * H;
        for (let i = 0; i < H; i++) upd(net.w1, mW1, vW1, o + i, row[i], true);
      }
      for (let i = 0; i < H; i++) upd(net.b1, mB1, vB1, i, gB1[i], false);
      for (let i = 0; i < 2 * H; i++) upd(net.w2, mW2, vW2, i, gW2[i], true);
      {
        mB2 = b1a * mB2 + (1 - b1a) * gB2; vB2 = b2a * vB2 + (1 - b2a) * gB2 * gB2;
        net.b2 -= (lr * (mB2 / c1)) / (Math.sqrt(vB2 / c2) + eps);
      }
      if (onProgress && step % 50 === 0) onProgress({ epoch, step, steps, trainLoss: lossSum / ((step + 1) * settings.batchSize) });
    }
    const trainLoss = lossSum / train.length;
    const valLoss = evaluateLoss(net, val, K);
    history.push({ epoch, trainLoss, valLoss });
    onProgress?.({ epoch, step: steps, steps, trainLoss, valLoss });
    if (valLoss < best.loss) best = { loss: valLoss, net: cloneNet(net) };
  }
  return { net: best.net, history, bestValLoss: best.loss };
}

export function cloneNet(n: NetworkWeights): NetworkWeights {
  return { hidden: n.hidden, w1: n.w1.slice(), b1: n.b1.slice(), w2: n.w2.slice(), b2: n.b2, scale: n.scale };
}

/** Checksum of network parameters — used to prove that training changed the weights. */
export function netChecksum(n: NetworkWeights): string {
  let h = 0x811c9dc5;
  const mix = (f: Float32Array) => { const u = new Uint32Array(f.buffer, f.byteOffset, f.length); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); } };
  mix(n.w1); mix(n.b1); mix(n.w2); mix(new Float32Array([n.b2, n.scale]));
  return (h >>> 0).toString(16).padStart(8, '0');
}
