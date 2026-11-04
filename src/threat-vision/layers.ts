// Turns a ThreatReport into board layers (square highlights + arrows) honouring per-category toggles.
import type { Arrow, Square } from '@/types';
import type { Highlight } from '@/utils/messages';
import type { ThreatReport } from './threats';
import type { Settings } from '@/settings/schema';
import { parseUci } from '@/chess/position';

export const LAYER_COLORS = {
  attacked: '#e65a6e',
  undefended: '#e0c23a',
  hanging: '#ff3b4e',
  pins: '#b07cf0',
  forks: '#f0973a',
  skewers: '#d062c8',
  kingSafety: '#ff3b4e',
  checks: '#4a8cf0',
  defences: '#3fbf6a',
} as const;

export function threatLayers(r: ThreatReport | null, layers: Settings['visual']['threatLayers']): { highlights: Highlight[]; arrows: Arrow[] } {
  if (!r) return { highlights: [], arrows: [] };
  const hl = new Map<Square, Highlight>();
  const put = (square: Square, color: string, opacity: number, label: string) => {
    const prev = hl.get(square);
    if (!prev || prev.opacity < opacity) hl.set(square, { square, color, opacity, label: prev ? `${prev.label}; ${label}` : label });
  };
  const arrows: Arrow[] = [];
  const enemy = r.turn === 'w' ? 'b' : 'w';
  if (layers.attacked) for (const a of r.attacked[enemy]) put(a.square, LAYER_COLORS.attacked, Math.min(0.12 + a.count * 0.06, 0.32), `attacked ${a.count}× by ${enemy === 'w' ? 'White' : 'Black'}`);
  if (layers.undefended) for (const c of ['w', 'b'] as const) for (const s of r.undefended[c]) put(s, LAYER_COLORS.undefended, 0.32, 'undefended piece');
  if (layers.hanging) for (const h of r.hanging) put(h.square, LAYER_COLORS.hanging, 0.55, `hanging (${h.reason.replace(/-/g, ' ')}, ≈${h.gain})`);
  if (layers.pins) for (const p of r.pins) {
    put(p.pinned, LAYER_COLORS.pins, 0.45, p.absolute ? 'pinned to the king' : `pinned against ${p.to}`);
    arrows.push({ from: p.pinner, to: p.to, color: LAYER_COLORS.pins, width: 0.55, opacity: 0.6, rank: 8 });
  }
  if (layers.skewers) for (const s of r.skewers) {
    put(s.front, LAYER_COLORS.skewers, 0.42, `skewered — ${s.back} behind`);
    arrows.push({ from: s.attacker, to: s.back, color: LAYER_COLORS.skewers, width: 0.55, opacity: 0.55, rank: 8 });
  }
  if (layers.forks) for (const f of [...r.forks, ...r.opponentForks].slice(0, 4)) {
    const u = parseUci(f.uci);
    if (!u) continue;
    arrows.push({ from: u.from, to: u.to, color: LAYER_COLORS.forks, width: 0.8, opacity: f.kind === 'engine-validated' ? 0.95 : 0.6, rank: 6 });
    for (const t of f.targets) put(t, LAYER_COLORS.forks, 0.35, `fork target (${f.san}, ${f.kind})`);
  }
  if (layers.checks) for (const c of r.checks.slice(0, 6)) {
    const u = parseUci(c.uci);
    if (u) arrows.push({ from: u.from, to: u.to, color: LAYER_COLORS.checks, width: 0.6, opacity: c.mate ? 0.95 : 0.55, rank: 7 });
  }
  if (layers.kingSafety) for (const w of r.kingWarnings) for (const s of w.squares) put(s, LAYER_COLORS.kingSafety, 0.28, w.message);
  if (layers.defences) for (const d of r.defences.slice(0, 5)) {
    const u = parseUci(d.uci);
    if (u) arrows.push({ from: u.from, to: u.to, color: LAYER_COLORS.defences, width: 0.6, opacity: 0.7, rank: 5 });
  }
  return { highlights: [...hl.values()], arrows };
}
