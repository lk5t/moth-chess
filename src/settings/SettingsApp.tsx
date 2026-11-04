// Settings (v2.1): grouped sections with a sticky section index instead of one long grid of cards.
import { useEffect, useState, type ReactNode } from 'react';
import { useSettings } from './useSettings';
import { resetSettings } from './store';
import { LIMITS, type Accent } from './schema';
import { Card, Select, Slider, Toggle, useThemeRoot, BetaBadge } from '@/components/ui';
import { TABLES, type TableName } from '@/memory/db';
import { clearTables, storageEstimate, tableCounts } from '@/memory/repo';
import { kvBytesInUse } from '@/storage/kv';
import { ProfilePicker, SitesList, BackupCard, FairPlayNote, appVersion, openExt } from '@/components/shared';

const fmtBytes = (b?: number) => (b === undefined ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

const SECTIONS = [
  ['general', 'General'], ['performance', 'Performance'], ['engine', 'Engine'], ['moth', 'MOTH Engine'], ['hud', 'Analysis HUD'],
  ['visual', 'Board visuals'], ['intelligence', 'Explanations'], ['sites', 'Websites & fair play'], ['data', 'Data & backup'], ['about', 'About'],
] as const;

function Section({ id, title, children, note }: { id: string; title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section id={id} className="stack" style={{ gap: 10, scrollMarginTop: 16 }}>
      <h2 style={{ margin: '8px 0 0' }}>{title}</h2>
      {note && <div className="small muted">{note}</div>}
      {children}
    </section>
  );
}

export function SettingsApp() {
  const [s, update, loaded] = useSettings();
  useThemeRoot(s);
  const [counts, setCounts] = useState<Record<TableName, number> | null>(null);
  const [est, setEst] = useState<{ usage?: number; quota?: number }>({});
  const [kvBytes, setKvBytes] = useState<number>();
  const [clearSel, setClearSel] = useState<Set<TableName>>(new Set());
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [active, setActive] = useState<string>(location.hash.slice(1) || 'general');

  const refresh = async () => { setCounts(await tableCounts()); setEst(await storageEstimate()); setKvBytes(await kvBytesInUse()); };
  useEffect(() => { void refresh(); chrome.commands?.getAll?.().then(setCommands).catch(() => {}); }, []);
  useEffect(() => {
    if (!loaded) return;
    const io = new IntersectionObserver((es) => { const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (v) setActive(v.target.id); }, { rootMargin: '0px 0px -70% 0px' });
    SECTIONS.forEach(([id]) => { const el = document.getElementById(id); if (el) io.observe(el); });
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    return () => io.disconnect();
  }, [loaded]);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  if (!loaded) return null;
  return (
    <div className="neural-bg" style={{ minHeight: '100vh' }}>
      <div className="page">
        <header className="page-header">
          <img src="icons/moth.svg" alt="" />
          <h1>MOTH Chess · Settings</h1><BetaBadge />
          <span className="grow" />
          {msg && <span className="badge good" aria-live="polite">{msg}</span>}
          <button className="btn" onClick={() => openExt('control.html')}>Control Center</button>
        </header>
        <div className="split">
          <nav className="subnav" aria-label="Settings sections">
            {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className={active === id ? 'active' : ''} onClick={() => setActive(id)}>{label}</a>)}
          </nav>
          <div className="stack" style={{ gap: 26 }}>
            <Section id="general" title="General">
              <Card>
                <Toggle label="Enable MOTH Chess" checked={s.enabled} onChange={(v) => update({ enabled: v })} hint="Turning this off removes every overlay immediately." />
                <Toggle label="Auto-analyse positions" checked={s.general.autoAnalyse} onChange={(v) => update({ general: { autoAnalyse: v } })} />
                <Toggle label="Notifications" checked={s.general.notifications} onChange={(v) => update({ general: { notifications: v } })} hint="e.g. when a game review finishes" />
                <div className="divider" />
                <Select label="Theme" value={s.appearance.theme} onChange={(v) => update({ appearance: { theme: v } })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Follow system' }]} />
                <div style={{ height: 8 }} />
                <Select<Accent> label="Accent colour" value={s.appearance.accent} onChange={(v) => update({ appearance: { accent: v } })} options={(['violet', 'indigo', 'teal', 'rose', 'amber'] as Accent[]).map((a) => ({ value: a, label: a[0].toUpperCase() + a.slice(1) }))} />
                <Slider label="Animation intensity" value={s.appearance.animation} min={0} max={1} step={0.1} format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`)} onChange={(v) => update({ appearance: { animation: v } })} />
              </Card>
            </Section>

            <Section id="performance" title="Performance profile" note="Profiles set the engine's memory, depth, thinking time and how quickly an unused engine is shut down. Changing any of those values by hand switches to Custom.">
              <Card>
                <ProfilePicker settings={s} update={update} />
                <div className="divider" />
                <Slider label="Wait before analysing a new position" value={s.performance.debounceMs} min={LIMITS.debounceMs[0]} max={LIMITS.debounceMs[1]} step={10} format={(v) => `${v} ms`} onChange={(v) => update({ performance: { debounceMs: v } })} hint="Longer waits save CPU when you step quickly through a game." />
                <Slider label="Shut the engine down after" value={s.performance.idleSec} min={LIMITS.idleSec[0]} max={LIMITS.idleSec[1]} step={10} format={(v) => `${v} s idle`} onChange={(v) => update({ performance: { idleSec: v } })} />
              </Card>
            </Section>

            <Section id="engine" title="Engine">
              <Card>
                <Select label="Analysis engine" value={s.engine.kind} onChange={(v) => update({ engine: { kind: v } })} options={[{ value: 'moth', label: 'MOTH Engine (original)' }, { value: 'stockfish', label: 'Stockfish 17.1 lite' }]} />
                <div style={{ height: 8 }} />
                <Select label="Game review / coach engine" value={s.engine.reviewKind} onChange={(v) => update({ engine: { reviewKind: v } })} options={[{ value: 'stockfish', label: 'Stockfish (stronger evaluations)' }, { value: 'moth', label: 'MOTH Engine' }]} />
                <Slider label="Search depth" value={s.engine.depth} min={LIMITS.depth[0]} max={LIMITS.depth[1]} onChange={(v) => update({ engine: { depth: v } })} />
                <Slider label="Lines (MultiPV)" value={s.engine.multiPv} min={1} max={5} onChange={(v) => update({ engine: { multiPv: v } })} />
                <Slider label="Hash" value={s.engine.hashMb} min={LIMITS.hashMb[0]} max={LIMITS.hashMb[1]} step={16} format={(v) => `${v} MB`} onChange={(v) => update({ engine: { hashMb: v } })} hint="MOTH Engine uses at most 128 MB." />
                <details>
                  <summary className="small muted" style={{ cursor: 'pointer', padding: '6px 0' }}>Advanced</summary>
                  <Slider label="Thinking time limit" value={s.engine.moveTimeMs} min={0} max={30000} step={500} format={(v) => (v ? `${(v / 1000).toFixed(1)} s` : 'depth only')} onChange={(v) => update({ engine: { moveTimeMs: v } })} hint="Stops a search after this time even if the depth isn't reached." />
                  <Slider label="Threads" value={s.engine.threads} min={LIMITS.threads[0]} max={LIMITS.threads[1]} onChange={(v) => update({ engine: { threads: v } })} hint="Both bundled engines are single-threaded (overlay frames cannot use SharedArrayBuffer); higher values are clamped to 1." />
                  <Slider label="Game review depth" value={s.review.depth} min={LIMITS.reviewDepth[0]} max={LIMITS.reviewDepth[1]} onChange={(v) => update({ review: { depth: v } })} />
                </details>
              </Card>
            </Section>

            <Section id="moth" title="MOTH Engine">
              <Card>
                <Select label="Playing style" value={s.moth.style} onChange={(v) => update({ moth: { style: v } })} options={[{ value: 'aggressive', label: 'Aggressive — initiative, gambits, sound sacrifices' }, { value: 'balanced', label: 'Balanced' }, { value: 'defensive', label: 'Defensive — king safety, solid structure' }]} />
                <Slider label="Move response budget" value={s.moth.moveTimeMs} min={LIMITS.mothMoveTime[0]} max={1000} step={5} format={(v) => `${v} ms`} onChange={(v) => update({ moth: { moveTimeMs: v } })} hint="Deadline for MOTH's moves in Play MOTH. Analysis keeps deepening." />
                <Toggle checked={s.moth.ownBook} onChange={(v) => update({ moth: { ownBook: v } })} label="Use the opening book for moves" />
                <Toggle checked={s.moth.ponder} onChange={(v) => update({ moth: { ponder: v } })} label="Ponder on your time" hint="Only in MOTH's own practice games." />
                <Toggle checked={s.moth.learning} onChange={(v) => update({ moth: { learning: v } })} label="Learn from my practice games (personal adaptation)" />
                <div className="small muted">Evaluation model: <span className="mono">{s.moth.model}</span> — manage models on the board page's MOTH Engine section.</div>
              </Card>
            </Section>

            <Section id="hud" title="Analysis HUD" note="How MOTH appears on allowed analysis boards. The panel can also be dragged and resized on the page; its position is remembered.">
              <Card>
                <Toggle checked={s.board.autoOverlay} onChange={(v) => update({ board: { autoOverlay: v } })} label="Open MOTH automatically on supported analysis boards" />
                <Toggle checked={s.general.startMinimized} onChange={(v) => update({ general: { startMinimized: v } })} label="Start the panel minimised" />
                <Select label="Panel layout" value={s.hud.layout} onChange={(v) => update({ hud: { layout: v } })} options={[{ value: 'full', label: 'Full — all sections' }, { value: 'compact', label: 'Compact — evaluation and best line only' }]} />
                <div style={{ height: 8 }} />
                <Select label="Evaluation bar" value={s.hud.evalBar} onChange={(v) => update({ hud: { evalBar: v } })} options={[{ value: 'left', label: 'Left of the board' }, { value: 'right', label: 'Right of the board' }, { value: 'off', label: 'Hidden' }]} />
                <Slider label="Arrows on the page board" value={s.hud.arrowCount} min={0} max={3} format={(v) => (v ? `${v} line${v > 1 ? 's' : ''}` : 'none')} onChange={(v) => update({ hud: { arrowCount: v } })} />
                <Toggle checked={s.hud.bestMoveSquares} onChange={(v) => update({ hud: { bestMoveSquares: v } })} label="Outline the best move's squares" />
                <Toggle checked={s.hud.showPv} onChange={(v) => update({ hud: { showPv: v } })} label="Show the principal variation" />
                <Toggle checked={s.hud.showStatus} onChange={(v) => update({ hud: { showStatus: v } })} label="Show engine and board status" />
                <Toggle checked={s.hud.avoidBoard} onChange={(v) => update({ hud: { avoidBoard: v } })} label="Keep the panel off the board" hint="Places the panel beside the board (and away from the site's move list) until you move it yourself." />
                <Slider label="Panel opacity" value={s.appearance.overlayOpacity} min={LIMITS.overlayOpacity[0]} max={LIMITS.overlayOpacity[1]} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update({ appearance: { overlayOpacity: v } })} />
                <Slider label="Panel scale" value={s.appearance.overlayScale} min={LIMITS.overlayScale[0]} max={LIMITS.overlayScale[1]} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update({ appearance: { overlayScale: v } })} />
              </Card>
            </Section>

            <Section id="visual" title="Board visuals">
              <Card>
                <Toggle label="Move arrows" checked={s.visual.arrows} onChange={(v) => update({ visual: { arrows: v } })} hint="Green = best, blue = 2nd, orange = 3rd line" />
                <Slider label="Arrow thickness" value={s.visual.arrowWidth} min={LIMITS.arrowWidth[0]} max={LIMITS.arrowWidth[1]} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update({ visual: { arrowWidth: v } })} />
                <Slider label="Arrow opacity" value={s.visual.arrowOpacity} min={LIMITS.arrowOpacity[0]} max={LIMITS.arrowOpacity[1]} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update({ visual: { arrowOpacity: v } })} />
                <Toggle label="Threat Vision" checked={s.visual.threatVision} onChange={(v) => update({ visual: { threatVision: v } })} hint="Layer toggles are in the Threat Vision panel" />
                <Toggle label="Square highlights" checked={s.visual.squareHighlights} onChange={(v) => update({ visual: { squareHighlights: v } })} />
                <Toggle label="Evaluation bar on the MOTH board" checked={s.visual.evalBar} onChange={(v) => update({ visual: { evalBar: v } })} />
              </Card>
            </Section>

            <Section id="intelligence" title="Explanations">
              <Card>
                <Select label="Explanation detail" value={s.intelligence.detail} onChange={(v) => update({ intelligence: { detail: v } })} options={[{ value: 'brief', label: 'Brief' }, { value: 'standard', label: 'Standard' }, { value: 'detailed', label: 'Detailed' }]} />
                <Toggle label="Automatic position summaries" checked={s.intelligence.autoSummary} onChange={(v) => update({ intelligence: { autoSummary: v } })} />
                <Toggle label="Coaching recommendations" checked={s.intelligence.coachingRecommendations} onChange={(v) => update({ intelligence: { coachingRecommendations: v } })} />
              </Card>
            </Section>

            <Section id="sites" title="Websites & fair play">
              <FairPlayNote />
              <SitesList />
            </Section>

            <Section id="data" title="Data & backup" note="Everything is stored in this browser profile only.">
              <Card title="Backup and restore"><BackupCard settings={s} update={update} /></Card>
              <Card title="Storage">
                <div className="small">IndexedDB usage: <b>{fmtBytes(est.usage)}</b>{est.quota ? ` of ${fmtBytes(est.quota)} available` : ''} · preferences: {fmtBytes(kvBytes)}</div>
                <table className="t" style={{ margin: '8px 0' }}>
                  <tbody>{counts && TABLES.map((t) => (
                    <tr key={t}><td><label className="row"><input type="checkbox" checked={clearSel.has(t)} onChange={(e) => { const n = new Set(clearSel); e.target.checked ? n.add(t) : n.delete(t); setClearSel(n); }} />{t}</label></td><td className="mono">{counts[t]}</td></tr>
                  ))}</tbody>
                </table>
                <div className="row wrap">
                  <button className="btn sm danger" disabled={!clearSel.size} onClick={async () => { if (confirm(`Permanently delete all data in: ${[...clearSel].join(', ')}?`)) { await clearTables([...clearSel]); setClearSel(new Set()); flash('Data cleared'); await refresh(); } }}>Clear selected</button>
                  <button className="btn sm danger" onClick={async () => { if (confirm('Reset all settings to defaults? Your games and training data are kept.')) { await resetSettings(); flash('Settings reset'); } }}>Reset settings</button>
                </div>
              </Card>
            </Section>

            <Section id="about" title="About">
              <Card>
                <p className="small" style={{ marginTop: 0 }}>MOTH Chess {appVersion()} · <b>free public beta</b> — work in progress; some features are marked <span className="badge beta">Beta</span>. Runs entirely in your browser. Engines: MOTH Engine (original, WebAssembly) and Stockfish 17.1 lite (GPL-3.0), both bundled locally. No accounts, servers or telemetry.</p>
                <div className="small muted" style={{ marginBottom: 6 }}>Keyboard shortcuts (change at brave://extensions/shortcuts)</div>
                {commands.filter((c) => c.name !== '_execute_action').map((c) => <div key={c.name} className="row small"><span className="grow">{c.description}</span><span className="kbd">{c.shortcut || 'unset'}</span></div>)}
                <div className="row small"><span className="grow">Board: previous / next move, flip, start-stop</span><span className="kbd">← → F Space</span></div>
                <div className="row wrap" style={{ marginTop: 10 }}>
                  <button className="btn sm" onClick={() => openExt('welcome.html')}>Show the welcome tour</button>
                  <button className="btn sm" onClick={() => openExt('control.html#feedback')}>Feedback & bug report</button>
                  <button className="btn sm" onClick={() => openExt('control.html#changelog')}>What's new</button>
                </div>
              </Card>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
