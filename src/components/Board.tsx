// Interactive SVG chess board (click-to-move and drag), with arrows, highlight layers and promotion picker.
import { useMemo, useRef, useState, type PointerEvent as RPE, type ReactNode } from 'react';
import type { Arrow, Orientation, PieceType, Square } from '@/types';
import type { Highlight } from '@/utils/messages';
import { boardFromFen, legalMoves } from '@/chess/position';
import { arrowPath, pointToSquare, squareOrigin } from '@/content/arrows/geometry';
import { attackersOf, kingIndex, parseBoard, sqName } from '@/chess/geometry';

const VB = 800;
const S = VB / 8;
const FILES = 'abcdefgh';
// U+FE0E forces text (not emoji) presentation of the chess glyphs
const GLYPH: Record<PieceType, string> = { k: '♚︎', q: '♛︎', r: '♜︎', b: '♝︎', n: '♞︎', p: '♟︎' };

export interface BoardProps {
  fen: string;
  orientation?: Orientation;
  onMove?: (uci: string) => boolean | void;
  arrows?: Arrow[];
  highlights?: Highlight[];
  lastMove?: [Square, Square];
  interactive?: boolean;
  coordinates?: boolean;
  ariaLabel?: string;
}

export function Board({ fen, orientation = 'white', onMove, arrows = [], highlights = [], lastMove, interactive = true, coordinates = true, ariaLabel }: BoardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<{ from: Square; x: number; y: number } | null>(null);
  const [promo, setPromo] = useState<{ from: Square; to: Square } | null>(null);
  const grid = useMemo(() => boardFromFen(fen), [fen]);
  const legal = useMemo(() => (interactive ? legalMoves(fen) : []), [fen, interactive]);
  const turn = fen.split(' ')[1];
  const checkSq = useMemo<Square | null>(() => {
    const b = parseBoard(fen);
    const k = kingIndex(b, b.turn);
    return k >= 0 && attackersOf(b, k, b.turn === 'w' ? 'b' : 'w').length ? sqName(k) : null;
  }, [fen]);

  const pieceAt = (sq: Square) => grid[8 - Number(sq[1])][FILES.indexOf(sq[0])];
  const targets = useMemo(() => new Set(selected ? legal.filter((m) => m.from === selected).map((m) => m.to) : []), [selected, legal]);

  const toLocal = (e: RPE): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * VB, y: ((e.clientY - r.top) / r.height) * VB };
  };

  const tryMove = (from: Square, to: Square) => {
    const cands = legal.filter((m) => m.from === from && m.to === to);
    if (!cands.length) return false;
    if (cands.some((m) => m.promotion)) { setPromo({ from, to }); return true; }
    onMove?.(from + to);
    return true;
  };

  const onDown = (e: RPE) => {
    if (!interactive || promo) return;
    const p = toLocal(e);
    const sq = pointToSquare(p.x, p.y, VB, orientation);
    if (!sq) return;
    const pc = pieceAt(sq);
    if (selected && targets.has(sq)) { tryMove(selected, sq); setSelected(null); return; }
    if (pc && pc.color === turn) {
      setSelected(sq);
      setDrag({ from: sq, x: p.x, y: p.y });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } else setSelected(null);
  };
  const onMoveP = (e: RPE) => { if (drag) { const p = toLocal(e); setDrag({ ...drag, x: p.x, y: p.y }); } };
  const onUp = (e: RPE) => {
    if (!drag) return;
    const p = toLocal(e);
    const sq = pointToSquare(p.x, p.y, VB, orientation);
    if (sq && sq !== drag.from && tryMove(drag.from, sq)) setSelected(null);
    setDrag(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    // Keyboard move entry: type UCI like "e2e4" then Enter (accessible fallback)
    if (e.key === 'Escape') { setSelected(null); setPromo(null); }
  };

  const squares: ReactNode[] = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = `${FILES[f]}${r + 1}` as Square;
    const o = squareOrigin(sq, VB, orientation);
    const light = (f + r) % 2 === 1;
    squares.push(<rect key={sq} x={o.x} y={o.y} width={S} height={S} fill={light ? 'var(--board-light)' : 'var(--board-dark)'} />);
  }

  return (
    <div className="board-wrap" onKeyDown={onKey}>
      <svg ref={svgRef} className="board-svg" viewBox={`0 0 ${VB} ${VB}`} role="img" aria-label={ariaLabel ?? `Chess board, ${turn === 'w' ? 'White' : 'Black'} to move`}
        onPointerDown={onDown} onPointerMove={onMoveP} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        <defs>
          <radialGradient id="moth-check"><stop offset="0" stopColor="#ff3b4e" stopOpacity="0.9" /><stop offset="0.55" stopColor="#ff3b4e" stopOpacity="0.45" /><stop offset="1" stopColor="#ff3b4e" stopOpacity="0" /></radialGradient>
        </defs>
        {squares}
        {lastMove && lastMove.map((sq) => { const o = squareOrigin(sq, VB, orientation); return <rect key={'lm' + sq} x={o.x} y={o.y} width={S} height={S} fill="var(--board-hl)" />; })}
        {highlights.map((h, i) => { const o = squareOrigin(h.square, VB, orientation); return <rect key={'h' + i} x={o.x} y={o.y} width={S} height={S} fill={h.color} fillOpacity={h.opacity}><title>{h.label ?? ''}</title></rect>; })}
        {selected && (() => { const o = squareOrigin(selected, VB, orientation); return <rect x={o.x} y={o.y} width={S} height={S} fill="var(--accent)" fillOpacity={0.35} />; })()}
        {checkSq && (() => { const o = squareOrigin(checkSq, VB, orientation); return <circle cx={o.x + S / 2} cy={o.y + S / 2} r={S * 0.5} fill="url(#moth-check)" />; })()}
        {coordinates && Array.from({ length: 8 }, (_, i) => (
          <g key={'c' + i} fontSize={15} fontWeight={700} style={{ pointerEvents: 'none' }}>
            <text x={i * S + S - 6} y={VB - 6} textAnchor="end" fill={i % 2 === 0 ? 'var(--board-light)' : 'var(--board-dark)'}>{orientation === 'white' ? FILES[i] : FILES[7 - i]}</text>
            <text x={5} y={i * S + 17} fill={i % 2 === 0 ? 'var(--board-dark)' : 'var(--board-light)'}>{orientation === 'white' ? 8 - i : i + 1}</text>
          </g>
        ))}
        {grid.flatMap((row, ri) => row.map((pc, fi) => {
          if (!pc) return null;
          const sq = `${FILES[fi]}${8 - ri}` as Square;
          if (drag?.from === sq) return null;
          const o = squareOrigin(sq, VB, orientation);
          return <PieceGlyph key={sq + pc.type + pc.color} type={pc.type} color={pc.color} x={o.x + S / 2} y={o.y + S / 2 + 3} />;
        }))}
        {[...targets].map((sq) => {
          const o = squareOrigin(sq, VB, orientation);
          const occ = pieceAt(sq);
          return occ ? <circle key={'t' + sq} cx={o.x + S / 2} cy={o.y + S / 2} r={S * 0.46} fill="none" stroke="var(--accent-strong)" strokeOpacity={0.7} strokeWidth={6} style={{ pointerEvents: 'none' }} />
            : <circle key={'t' + sq} cx={o.x + S / 2} cy={o.y + S / 2} r={S * 0.15} fill="var(--accent-strong)" fillOpacity={0.6} style={{ pointerEvents: 'none' }} />;
        })}
        <g style={{ pointerEvents: 'none' }}>
          {[...arrows].sort((a, b) => b.rank - a.rank).map((a, i) => <path key={'a' + i} d={arrowPath(a.from, a.to, VB, orientation, a.width)} fill={a.color} fillOpacity={a.opacity} />)}
        </g>
        {drag && (() => { const pc = pieceAt(drag.from); return pc ? <PieceGlyph type={pc.type} color={pc.color} x={drag.x} y={drag.y} lifted /> : null; })()}
      </svg>
      {promo && (
        <div className="promo" role="dialog" aria-label="Choose promotion piece">
          <div>
            {(['q', 'r', 'b', 'n'] as PieceType[]).map((p) => (
              <button key={p} aria-label={{ q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[p as 'q']} onClick={() => { onMove?.(promo.from + promo.to + p); setPromo(null); setSelected(null); }}>
                <span style={{ color: turn === 'w' ? '#fff' : '#1b1a22', WebkitTextStroke: turn === 'w' ? '1px #222' : '1px #ccc' }}>{GLYPH[p]}</span>
              </button>
            ))}
            <button aria-label="Cancel" onClick={() => setPromo(null)} style={{ fontSize: 20 }}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PieceGlyph({ type, color, x, y, lifted }: { type: PieceType; color: 'w' | 'b'; x: number; y: number; lifted?: boolean }) {
  return (
    <text className="glyph piece" x={x} y={y} fontSize={lifted ? 84 : 76}
      fill={color === 'w' ? '#fbfaff' : '#1b1a22'} stroke={color === 'w' ? '#25222f' : '#d9d4ea'} strokeWidth={color === 'w' ? 2.2 : 1.4} paintOrder="stroke"
      style={{ filter: lifted ? 'drop-shadow(0 6px 6px rgba(0,0,0,.4))' : 'drop-shadow(0 1px 1px rgba(0,0,0,.35))', pointerEvents: 'none' }}>
      {GLYPH[type]}
    </text>
  );
}

export { GLYPH };
