// Pure overlay geometry (dragging, resizing, viewport clamping) — unit tested.
export interface OverlayRect { x: number; y: number; w: number; h: number }
export interface OverlayState extends OverlayRect { minimized: boolean; hidden: boolean }

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
