import { useEffect, useRef } from 'react';
import type { MoveClass, MoveRecord } from '@/types';

const SYM: Partial<Record<MoveClass, string>> = { blunder: '??', mistake: '?', inaccuracy: '?!' };

export function MoveList(props: { moves: MoveRecord[]; cursor: number; onGoto: (ply: number) => void; startFen?: string; classes?: (MoveClass | undefined)[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('.mv.active')?.scrollIntoView({ block: 'nearest' }); }, [props.cursor]);
  if (!props.moves.length) return <div className="empty">No moves yet — play on the board or import a PGN.</div>;
  const blackFirst = props.moves[0]?.color === 'b';
  const startNum = Number(props.startFen?.split(' ')[5] ?? 1) || 1;
  const rows: { num: number; w?: number; b?: number }[] = [];
  props.moves.forEach((m, i) => {
    if (m.color === 'w' || (i === 0 && blackFirst)) rows.push({ num: startNum + rows.length, ...(m.color === 'w' ? { w: i } : { b: i }) });
    else rows[rows.length - 1].b = i;
  });
  const cell = (i?: number) => {
    if (i === undefined) return <span className="mv muted">…</span>;
    const c = props.classes?.[i];
    return (
      <span className={`mv ${props.cursor === i + 1 ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => props.onGoto(i + 1)}
        onKeyDown={(e) => e.key === 'Enter' && props.onGoto(i + 1)} aria-label={`Move ${props.moves[i].san}`}>
        {props.moves[i].san}{c && SYM[c] && <span className={`cls-${c}`}>{SYM[c]}</span>}
      </span>
    );
  };
  return (
    <div ref={ref} className="moves scroll" style={{ maxHeight: 260 }}>
      {rows.map((r) => (
        <div key={r.num} style={{ display: 'contents' }}>
          <span className="num">{r.num}.</span>
          {cell(r.w)}
          {r.b !== undefined ? cell(r.b) : <span />}
        </div>
      ))}
    </div>
  );
}
