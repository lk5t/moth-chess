// Pure overlay geometry (dragging, resizing, viewport clamping) — unit tested.
export interface OverlayRect { x: number; y: number; w: number; h: number }
/** userPlaced: the user dragged/resized the panel, so automatic placement leaves it alone. */
export interface OverlayState extends OverlayRect { minimized: boolean; hidden: boolean; userPlaced?: boolean }

export const MIN_W = 300, MIN_H = 260, MAX_W = 720, BAR_H = 34, MINI_W = 210;

export function defaultOverlayState(vw: number, vh: number, startMinimized = false): OverlayState {
  const w = Math.min(380, vw - 32);
  const h = Math.min(560, vh - 32);
  return { x: Math.max(16, vw - w - 24), y: 72, w, h, minimized: startMinimized, hidden: false };
}

export function clampToViewport(s: OverlayState, vw: number, vh: number): OverlayState {
  const w = Math.max(Math.min(MIN_W, vw - 8), Math.min(s.w, MAX_W, vw - 8));
  const h = Math.max(Math.min(MIN_H, vh - 8), Math.min(s.h, vh - 8));
  const visW = s.minimized ? MINI_W : w;
  const visH = s.minimized ? BAR_H : h;
  // keep at least the title bar fully reachable
  const x = Math.min(Math.max(0, s.x), Math.max(0, vw - visW));
  const y = Math.min(Math.max(0, s.y), Math.max(0, vh - Math.min(visH, BAR_H + 40)));
  return { ...s, x, y, w, h };
}

export function dragTo(s: OverlayState, start: { px: number; py: number; x: number; y: number }, px: number, py: number, vw: number, vh: number): OverlayState {
  return clampToViewport({ ...s, x: start.x + (px - start.px), y: start.y + (py - start.py) }, vw, vh);
}

export function resizeTo(s: OverlayState, start: { px: number; py: number; w: number; h: number }, px: number, py: number, vw: number, vh: number): OverlayState {
  return clampToViewport({ ...s, w: Math.max(MIN_W, start.w + (px - start.px)), h: Math.max(MIN_H, start.h + (py - start.py)) }, vw, vh);
}

// ---------------- HUD placement (v2.1) ----------------
export interface Rect { left: number; top: number; width: number; height: number }

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Choose a position for the HUD panel that covers neither the board nor the site's own controls
 * (move list, analysis tools). Candidates are tried in order; the one with the least weighted overlap wins
 * (covering the board counts 10× more than covering a control). Size is kept; the result is viewport-clamped.
 */
export function placeAvoiding(s: OverlayState, board: Rect, avoid: Rect[], vw: number, vh: number, opts: { keepIfClear?: boolean; margin?: number } = {}): OverlayState {
  const margin = opts.margin ?? 12;
  const w = s.minimized ? MINI_W : s.w, h = s.minimized ? BAR_H : s.h;
  const scoreOf = (r: Rect) => overlapArea(r, board) * 10 + avoid.reduce((a, b) => a + overlapArea(r, b), 0);
  if (opts.keepIfClear !== false) {
    const cur = clampToViewport(s, vw, vh);
    if (scoreOf({ left: cur.x, top: cur.y, width: w, height: h }) === 0) return cur;
  }
  const top = Math.max(8, Math.min(board.top, vh - h - 8));
  const cands: { x: number; y: number }[] = [
    { x: board.left + board.width + margin + 18, y: top }, // right of the board (clear of a right-hand eval bar)
    { x: board.left - w - margin - 18, y: top }, // left of the board
    { x: vw - w - 16, y: 72 }, // right edge
    { x: 16, y: 72 }, // left edge
    { x: vw - w - 16, y: vh - h - 16 }, // bottom-right
    { x: 16, y: vh - h - 16 }, // bottom-left
  ];
  let best: OverlayState | null = null, bestScore = Infinity;
  for (const c of cands) {
    const st = clampToViewport({ ...s, x: c.x, y: c.y }, vw, vh);
    const r: Rect = { left: st.x, top: st.y, width: w, height: h };
    const score = scoreOf(r);
    if (score < bestScore - 0.5) { best = st; bestScore = score; }
    if (score === 0) break;
  }
  return best ?? clampToViewport(s, vw, vh);
}

/** Side for the evaluation bar: the preferred side unless it would fall outside the viewport. */
export function evalBarSide(pref: 'left' | 'right', board: Rect, vw: number, barW: number): 'left' | 'right' {
  if (pref === 'left' && board.left - barW - 4 < 0) return 'right';
  if (pref === 'right' && board.left + board.width + barW + 4 > vw) return 'left';
  return pref;
}
