// Small SVG charts that stay readable inside the extension UI.
import type { MoveClass, WhiteScore } from '@/types';
import { evalBarFraction, formatScore } from '@/engine/normalize';

export function EvalBar({ score, flipped, height = '100%' }: { score?: WhiteScore | null; flipped?: boolean; height?: number | string }) {
  const frac = evalBarFraction(score);
  return (
    <div className={`evalbar ${flipped ? 'flipped' : ''}`} style={{ height }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}
      aria-label={`Evaluation ${formatScore(score)} (White's perspective)`} title={`${formatScore(score)} — White's perspective`}>
      <div className="fill" style={{ height: `${frac * 100}%` }} />
      <div className="mid" />
    </div>
  );
}

/** Line chart of values in [min,max]; `marks` colour individual points (e.g. blunders). */
export function LineChart(props: {
  values: number[]; min?: number; max?: number; height?: number; mid?: number; current?: number; onPick?: (i: number) => void;
  marks?: (MoveClass | undefined)[]; label: string; area?: boolean; format?: (v: number) => string;
}) {
  const { values, height = 120 } = props;
  const W = 600, H = height;
  const min = props.min ?? Math.min(...values, 0), max = props.max ?? Math.max(...values, 1);
  if (!values.length) return <div className="empty">No data yet</div>;
  const x = (i: number) => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
  const y = (v: number) => H - ((v - min) / (max - min || 1)) * H;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const markColor: Partial<Record<MoveClass, string>> = { blunder: 'var(--bad)', mistake: '#f0773a', inaccuracy: 'var(--warn)' };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={props.label} preserveAspectRatio="none" style={{ display: 'block', cursor: props.onPick ? 'pointer' : 'default' }}
      onClick={(e) => {
        if (!props.onPick) return;
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        props.onPick(Math.round(((e.clientX - r.left) / r.width) * (values.length - 1)));
      }}>
      {props.mid !== undefined && <line x1={0} x2={W} y1={y(props.mid)} y2={y(props.mid)} stroke="var(--line-strong)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
      {props.area && <path d={`${d} L${x(values.length - 1)},${H} L0,${H} Z`} fill="var(--accent-soft)" />}
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {props.marks?.map((m, i) => (m && markColor[m] ? <circle key={i} cx={x(i)} cy={y(values[i])} r={4} fill={markColor[m]} vectorEffect="non-scaling-stroke"><title>{`${i + 1}: ${m}`}</title></circle> : null))}
      {props.current !== undefined && props.current >= 0 && props.current < values.length && (
        <line x1={x(props.current)} x2={x(props.current)} y1={0} y2={H} stroke="var(--accent-strong)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

export function BarChart(props: { data: { label: string; value: number; hint?: string }[]; max?: number; format?: (v: number) => string; label: string }) {
  const max = props.max ?? Math.max(1, ...props.data.map((d) => d.value));
  if (!props.data.length) return <div className="empty">No data yet</div>;
  return (
    <div className="stack" style={{ gap: 6 }} role="img" aria-label={props.label}>
      {props.data.map((d) => (
        <div key={d.label} className="row small" title={d.hint}>
          <span style={{ width: 110, flex: '0 0 110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
          <div className="grow" style={{ height: 10, background: 'var(--bg-2)', borderRadius: 5, overflow: 'hidden' }}>
            <div style={{ width: `${(d.value / max) * 100}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent-strong), var(--accent))', borderRadius: 5 }} />
          </div>
          <span className="mono" style={{ width: 52, textAlign: 'right' }}>{props.format ? props.format(d.value) : d.value}</span>
        </div>
      ))}
    </div>
  );
}
