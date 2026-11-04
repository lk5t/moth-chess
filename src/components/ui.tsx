// Reusable MOTH UI components.
import { useEffect, useId, type ReactNode, type CSSProperties } from 'react';
import type { EngineStatus } from '@/types';
import type { Settings } from '@/settings/schema';

export function Card(props: { title?: ReactNode; actions?: ReactNode; children: ReactNode; glow?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <section className={`card ${props.glow ? 'glow' : ''} ${props.className ?? ''}`} style={props.style}>
      {(props.title || props.actions) && (
        <h3 className="card-title">
          <span className="grow">{props.title}</span>
          {props.actions}
        </h3>
      )}
      {props.children}
    </section>
  );
}

export interface TabDef<T extends string> { id: T; label: ReactNode }
export function Tabs<T extends string>(props: { tabs: TabDef<T>[]; value: T; onChange: (t: T) => void; label: string }) {
  const onKey = (e: React.KeyboardEvent) => {
    const i = props.tabs.findIndex((t) => t.id === props.value);
    if (e.key === 'ArrowRight') props.onChange(props.tabs[(i + 1) % props.tabs.length].id);
    if (e.key === 'ArrowLeft') props.onChange(props.tabs[(i - 1 + props.tabs.length) % props.tabs.length].id);
  };
  return (
    <div className="tabs" role="tablist" aria-label={props.label} onKeyDown={onKey}>
      {props.tabs.map((t) => (
        <button key={t.id} className="tab" role="tab" aria-selected={t.id === props.value} tabIndex={t.id === props.value ? 0 : -1} onClick={() => props.onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
      <label htmlFor={id} className="grow">
        <div>{props.label}</div>
        {props.hint && <div className="muted small">{props.hint}</div>}
      </label>
      <span className="switch">
        <input id={id} type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
        <span />
      </span>
    </div>
  );
}

export function Slider(props: { label: ReactNode; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div style={{ padding: '4px 0' }}>
      <div className="row">
        <label htmlFor={id} className="grow">{props.label}</label>
        <span className="mono small">{props.format ? props.format(props.value) : props.value}</span>
      </div>
      <input id={id} className="slider" type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))} />
      {props.hint && <div className="muted small">{props.hint}</div>}
    </div>
  );
}

export function Select<T extends string>(props: { label?: ReactNode; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div>
      {props.label && <label htmlFor={id} className="label">{props.label}</label>}
      <select id={id} className="select" value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function Tip(props: { tip: ReactNode; children: ReactNode }) {
  return <span className="tip" tabIndex={0}>{props.children}<span className="tip-body" role="tooltip">{props.tip}</span></span>;
}

const STATUS_TEXT: Record<EngineStatus, string> = {
  idle: 'Engine idle', loading: 'Loading engine…', ready: 'Engine ready', thinking: 'Analysing', stopping: 'Stopping…', error: 'Engine error', restarting: 'Restarting engine', terminated: 'Engine asleep',
};
export function EngineStatusBadge(props: { status: EngineStatus; detail?: string }) {
  return (
    <span className="row small" title={props.detail ?? STATUS_TEXT[props.status]} aria-live="polite">
      <span className={`dot ${props.status}`} />
      <span className="muted">{STATUS_TEXT[props.status]}</span>
    </span>
  );
}

export function SourceTag({ source }: { source: string }) {
  return <span className={`src ${source}`} title={source === 'engine' ? 'Proven by Stockfish search' : source === 'rules' ? 'Proven by the rules of chess' : source === 'geometric' ? 'Simple attack geometry — not engine-checked' : 'MOTH heuristic explanation'}>{source}</span>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

export function Stat(props: { label: string; value: ReactNode; hint?: ReactNode; low?: boolean }) {
  return (
    <div className="stat">
      <span className="k">{props.label}{props.low && <span className="badge warn" style={{ marginLeft: 6 }} title="Small sample — treat with caution">low n</span>}</span>
      <span className="v">{props.value}</span>
      {props.hint && <span className="muted small">{props.hint}</span>}
    </div>
  );
}

/** Applies theme / accent / animation intensity to <html>. */
export function useThemeRoot(s: Settings) {
  useEffect(() => {
    const el = document.documentElement;
    const apply = () => {
      const theme = s.appearance.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.appearance.theme;
      el.dataset.theme = theme;
      el.dataset.accent = s.appearance.accent;
      el.style.setProperty('--anim', String(s.appearance.animation));
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [s.appearance.theme, s.appearance.accent, s.appearance.animation]);
}

export const Icon = {
  play: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 20h8M10 17h6l-1-5 2-3-3-1V5h-2v2l-3 1 2 3z" /><circle cx="12" cy="4" r="1" /></svg>,
  engine: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3c-2 3-6 4-6 9a6 6 0 0012 0c0-5-4-6-6-9z" /><path d="M9 14c1 1.5 5 1.5 6 0" /></svg>,
  board: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>,
  brain: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="7" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="12" cy="17" r="2" /><circle cx="12" cy="9" r="1.5" /><path d="M7.7 8l2.9.6M16.3 8l-2.9.6M12 10.5V15M7 9l4 6.5M17 9l-4 6.5" /></svg>,
  map: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="5" cy="12" r="2" /><circle cx="17" cy="5" r="2" /><circle cx="17" cy="12" r="2" /><circle cx="17" cy="19" r="2" /><path d="M7 12h8M7 11l8-5M7 13l8 5" /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  flask: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3" /><path d="M7.5 15h9" /></svg>,
  review: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 19l5-6 4 3 7-9" /><path d="M4 4v15h16" /></svg>,
  coach: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l9 5-9 5-9-5z" /><path d="M7 10.5V16c0 1.5 2.5 3 5 3s5-1.5 5-3v-5.5" /></svg>,
  memory: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>,
  chart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
  book: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z" /><path d="M4 19V5" /></svg>,
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>,
  flip: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" /></svg>,
};
