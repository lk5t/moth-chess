// Exact King + Pawn vs King bitbase, computed locally by retrograde analysis (≈196k positions, a few ms).
// This is MOTH's "local tablebase": complete and exact for KPK. Other endgames use rules (see endgame.ts).
// Squares 0..63 = a1..h8. Strong side = side with the pawn; positions are normalised so that side is
// White and the pawn stands on files a–d.

const UNKNOWN = 0, DRAW = 1, WIN = 2;
const f = (s: number) => s & 7, r = (s: number) => s >> 3;
const dist = (a: number, b: number) => Math.max(Math.abs(f(a) - f(b)), Math.abs(r(a) - r(b)));
const KING_STEPS: number[][] = Array.from({ length: 64 }, (_, s) => {
  const out: number[] = [];
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const nf = f(s) + df, nr = r(s) + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(nr * 8 + nf);
  }
  return out;
});
const pawnAttacks = (p: number) => [f(p) > 0 ? p + 7 : -1, f(p) < 7 ? p + 9 : -1].filter((x) => x >= 0 && x < 64);

// index: stm(2) × wk(64) × bk(64) × pawn(24: files a-d × ranks 2-7)
const pIdx = (p: number) => (r(p) - 1) * 4 + f(p);
const idx = (stm: number, wk: number, bk: number, p: number) => ((stm * 64 + wk) * 64 + bk) * 24 + pIdx(p);
const N = 2 * 64 * 64 * 24;
let table: Uint8Array | null = null;

function build(): Uint8Array {
  const t = new Uint8Array(N);
  const valid = new Uint8Array(N);
  const pawns: number[] = [];
  for (let rr = 1; rr <= 6; rr++) for (let ff = 0; ff < 4; ff++) pawns.push(rr * 8 + ff);
  // initial classification
  for (const p of pawns) for (let wk = 0; wk < 64; wk++) for (let bk = 0; bk < 64; bk++) for (let stm = 0; stm < 2; stm++) {
    if (wk === bk || wk === p || bk === p || dist(wk, bk) <= 1) continue;
    // white to move with black in check from the pawn is illegal
    if (stm === 0 && pawnAttacks(p).includes(bk)) continue;
    const i = idx(stm, wk, bk, p);
    valid[i] = 1;
    if (stm === 0) {
      // promotion that cannot be captured at once wins
      if (r(p) === 6 && wk !== p + 8 && bk !== p + 8 && (dist(bk, p + 8) > 1 || dist(wk, p + 8) === 1)) t[i] = WIN;
    } else {
      const moves = KING_STEPS[bk].filter((s) => (s !== p && dist(s, wk) > 1 && !pawnAttacks(p).includes(s)) || (s === p && dist(p, wk) > 1));
      if (!moves.length) t[i] = pawnAttacks(p).includes(bk) ? WIN : DRAW; // checkmate by the pawn / stalemate
      else if (dist(bk, p) === 1 && dist(wk, p) > 1) t[i] = DRAW; // pawn falls
    }
  }
  // retrograde iteration
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of pawns) for (let wk = 0; wk < 64; wk++) for (let bk = 0; bk < 64; bk++) for (let stm = 0; stm < 2; stm++) {
      const i = idx(stm, wk, bk, p);
      if (!valid[i] || t[i] !== UNKNOWN) continue;
      let res: number;
      if (stm === 0) {
        // white: WIN if any move reaches a WIN, DRAW if all moves DRAW
        let any = false, allDraw = true;
        const succ: number[] = [];
        for (const s of KING_STEPS[wk]) if (s !== p && dist(s, bk) > 1) succ.push(idx(1, s, bk, p));
        if (r(p) < 6 && p + 8 !== wk && p + 8 !== bk) {
          succ.push(idx(1, wk, bk, p + 8));
          if (r(p) === 1 && p + 16 !== wk && p + 16 !== bk && p + 8 !== bk) succ.push(idx(1, wk, bk, p + 16));
        }
        for (const j of succ) { if (t[j] === WIN) { any = true; break; } if (t[j] !== DRAW) allDraw = false; }
        res = any ? WIN : allDraw && succ.length ? DRAW : UNKNOWN;
      } else {
        let anyDraw = false, allWin = true, n = 0;
        for (const s of KING_STEPS[bk]) {
          if (dist(s, wk) <= 1) continue;
          if (s === p) { anyDraw = true; n++; break; } // captures the (undefended) pawn
          if (pawnAttacks(p).includes(s)) continue;
          n++;
          const j = idx(0, wk, s, p);
          if (t[j] === DRAW) { anyDraw = true; break; }
          if (t[j] !== WIN) allWin = false;
        }
        res = anyDraw ? DRAW : n && allWin ? WIN : UNKNOWN;
      }
      if (res !== UNKNOWN) { t[i] = res; changed = true; }
    }
  }
  return t;
}

/**
 * Probe KPK. Squares in 0..63 (a1 = 0). `pawnWhite`: whether the pawn belongs to White.
 * Returns 'win' (for the pawn's side) or 'draw'.
 */
export function probeKPK(wk: number, bk: number, pawn: number, pawnWhite: boolean, whiteToMove: boolean): 'win' | 'draw' {
  table ??= build();
  // normalise: strong side → White, pawn on files a–d
  let sk = pawnWhite ? wk : bk, wkk = pawnWhite ? bk : wk, p = pawn, stm = pawnWhite === whiteToMove ? 0 : 1;
  if (!pawnWhite) { sk ^= 56; wkk ^= 56; p ^= 56; }
  if (f(p) > 3) { sk ^= 7; wkk ^= 7; p ^= 7; }
  if (r(p) < 1 || r(p) > 6) return 'draw';
  return table[idx(stm, sk, wkk, p)] === WIN ? 'win' : 'draw';
}

export const sq = (name: string) => (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
