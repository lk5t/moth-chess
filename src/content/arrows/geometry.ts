// Square ↔ pixel mapping and arrow shapes. Shared by the built-in board and on-page overlays.
import type { Orientation, Square } from '@/types';

const FILES = 'abcdefgh';

/** Top-left corner of a square in a board of `size` px. */
export function squareOrigin(sq: Square, size: number, orientation: Orientation): { x: number; y: number } {
  const s = size / 8;
  const f = FILES.indexOf(sq[0]);
  const r = Number(sq[1]) - 1;
  const col = orientation === 'white' ? f : 7 - f;
  const row = orientation === 'white' ? 7 - r : r;
  return { x: col * s, y: row * s };
}

export function squareCenter(sq: Square, size: number, orientation: Orientation): { x: number; y: number } {
  const o = squareOrigin(sq, size, orientation);
  return { x: o.x + size / 16, y: o.y + size / 16 };
}

/** Inverse mapping: pixel → square (null outside the board). */
export function pointToSquare(x: number, y: number, size: number, orientation: Orientation): Square | null {
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  const s = size / 8;
  const col = Math.floor(x / s), row = Math.floor(y / s);
  const f = orientation === 'white' ? col : 7 - col;
  const r = orientation === 'white' ? 7 - row : row;
  return `${FILES[f]}${r + 1}` as Square;
}

export function isKnightMove(from: Square, to: Square): boolean {
  const df = Math.abs(FILES.indexOf(from[0]) - FILES.indexOf(to[0]));
  const dr = Math.abs(Number(from[1]) - Number(to[1]));
  return (df === 1 && dr === 2) || (df === 2 && dr === 1);
}

/**
 * Closed SVG path for an arrow (shaft + head). Knight moves are drawn as an L (long leg first).
 * `width` is relative (1 = default ≈ 1/6 of a square).
 */
export function arrowPath(from: Square, to: Square, size: number, orientation: Orientation, width = 1): string {
  const s = size / 8;
  const a = squareCenter(from, size, orientation);
  const b = squareCenter(to, size, orientation);
  const shaft = (s / 6) * width;
  const headW = shaft * 2.6;
  const headL = shaft * 2.4;
  const pts: { x: number; y: number }[] = [a];
  if (isKnightMove(from, to)) {
    const dx = b.x - a.x, dy = b.y - a.y;
    pts.push(Math.abs(dx) > Math.abs(dy) ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
  }
  pts.push(b);
  // shorten start so the arrow begins near the piece edge, and the end so the head tip sits at the centre
  const segs = pts.length - 1;
  const last = { x: pts[segs].x - pts[segs - 1].x, y: pts[segs].y - pts[segs - 1].y };
  const lastLen = Math.hypot(last.x, last.y) || 1;
  const ux = last.x / lastLen, uy = last.y / lastLen;
  const tip = { x: b.x, y: b.y };
  const headBase = { x: tip.x - ux * headL, y: tip.y - uy * headL };
  const first = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
  const fl = Math.hypot(first.x, first.y) || 1;
  const start = { x: a.x + (first.x / fl) * s * 0.18, y: a.y + (first.y / fl) * s * 0.18 };
  const line = [start, ...pts.slice(1, -1), headBase];
  // Build outline by offsetting each segment
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const p = line[i], q = line[i + 1];
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (shaft / 2), ny = (dx / len) * (shaft / 2);
    left.push({ x: p.x + nx, y: p.y + ny }, { x: q.x + nx, y: q.y + ny });
    right.push({ x: p.x - nx, y: p.y - ny }, { x: q.x - nx, y: q.y - ny });
  }
  const nx = -uy * (headW / 2), ny = ux * (headW / 2);
  const outline = [
    ...left,
    { x: headBase.x + nx, y: headBase.y + ny },
    tip,
    { x: headBase.x - nx, y: headBase.y - ny },
    ...right.reverse(),
  ];
  return 'M' + outline.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L') + ' Z';
}

export const ARROW_COLORS = ['#3fbf6a', '#4a8cf0', '#f0973a', '#b07cf0', '#e0607a'] as const;
