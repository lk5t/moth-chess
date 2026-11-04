import { useEffect, useState } from 'react';
import { useSettings } from './useSettings';
import { resetSettings } from './store';
import { LIMITS, type Accent } from './schema';
import { Card, Select, Slider, Toggle, useThemeRoot } from '@/components/ui';
import { TABLES, type TableName } from '@/memory/db';
import { clearTables, downloadText, exportAll, importAll, storageEstimate, tableCounts } from '@/memory/repo';
import { kvBytesInUse } from '@/storage/kv';
import { SITES } from '@/content/detector/sites';

const fmtBytes = (b?: number) => (b === undefined ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export function SettingsApp() {
  const [s, update, loaded] = useSettings();
  useThemeRoot(s);
  const [counts, setCounts] = useState<Record<TableName, number> | null>(null);
  const [est, setEst] = useState<{ usage?: number; quota?: number }>({});
  const [kvBytes, setKvBytes] = useState<number>();
  const [clearSel, setClearSel] = useState<Set<TableName>>(new Set());
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    setCounts(await tableCounts()); setEst(await storageEstimate()); setKvBytes(await kvBytesInUse());
    const g: Record<string, boolean> = {};
    for (const site of SITES) g[site.id] = await chrome.permissions.contains({ origins: [site.origin] });
    setGranted(g);
  };
  useEffect(() => { void refresh(); chrome.commands?.getAll?.().then(setCommands).catch(() => {}); }, []);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  if (!loaded) return null;
  return (
    <div className="neural-bg" style={{ minHeight: '100vh' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: 20 }} className="stack">
        <div className="page-head"><img src="icons/icon48.png" width={32} alt="" /><h1>MOTH Chess · Settings</h1><span className="grow" />{msg && <span className="badge good" aria-live="polite">{msg}</span>}</div>
        <div className="grid-2">
          <Card title="Appearance">
            <Select label="Theme" value={s.appearance.theme} onChange={(v) => update({ appearance: { theme: v } })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Follow system' }]} />
            <div style={{ height: 8 }} />
            <Select<Accent> label="Accent colour" value={s.appearance.accent} onChange={(v) => update({ appearance: { accent: v } })} options={(['violet', 'indigo', 'teal', 'rose', 'amber'] as Accent[]).map((a) => ({ value: a, label: a[0].toUpperCase() + a.slice(1) }))} />
            <Slider label="Overlay opacity" value={s.appearance.overlayOpacity} min={LIMITS.overlayOpacity[0]} max={LIMITS.overlayOpacity[1]} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update({ appearance: { overlayOpacity: v } })} />
            <Slider label="Overlay scale" value={s.appearance.overlayScale} min={LIMITS.overlayScale[0]} max={LIMITS.overlayScale[1]} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update({ appearance: { overlayScale: v } })} />
            <Slider label="Animation intensity" value={s.appearance.animation} min={0} max={1} step={0.1} format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`)} onChange={(v) => update({ appearance: { animation: v } })} />
          </Card>
          <Card title="Engine">
            <Slider label="Search depth" value={s.engine.depth} min={LIMITS.depth[0]} max={LIMITS.depth[1]} onChange={(v) => update({ engine: { depth: v } })} />
            <Slider label="Thinking time limit" value={s.engine.moveTimeMs} min={0} max={30000} step={500} format={(v) => (v ? `${(v / 1000).toFixed(1)} s` : 'depth only')} onChange={(v) => update({ engine: { moveTimeMs: v } })} hint="Stops a search after this time even if the depth isn't reached." />
            <Slider label="Threads" value={s.engine.threads} min={LIMITS.threads[0]} max={LIMITS.threads[1]} onChange={(v) => update({ engine: { threads: v } })} hint="The bundled Stockfish lite build is single-threaded (it avoids SharedArrayBuffer, which overlay frames cannot use); higher values are clamped to what the engine reports." />
            <Slider label="Hash" value={s.engine.hashMb} min={LIMITS.hashMb[0]} max={LIMITS.hashMb[1]} step={16} format={(v) => `${v} MB`} onChange={(v) => update({ engine: { hashMb: v } })} />
            <Slider label="Lines (MultiPV)" value={s.engine.multiPv} min={1} max={5} onChange={(v) => update({ engine: { multiPv: v } })} />
            <Slider label="Game review depth" value={s.review.depth} min={LIMITS.reviewDepth[0]} max={LIMITS.reviewDepth[1]} onChange={(v) => update({ review: { depth: v } })} />
          </Card>
          <Card title="Visual analysis">
            <Toggle label="Move arrows" checked={s.visual.arrows} onChange={(v) => update({ visual: { arrows: v } })} hint="Green = best, blue = 2nd, orange = 3rd line" />
            <Slider label="Arrow thickness" value={s.visual.arrowWidth} min={LIMITS.arrowWidth[0]} max={LIMITS.arrowWidth[1]} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update({ visual: { arrowWidth: v } })} />
            <Slider label="Arrow opacity" value={s.visual.arrowOpacity} min={LIMITS.arrowOpacity[0]} max={LIMITS.arrowOpacity[1]} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update({ visual: { arrowOpacity: v } })} />
            <Toggle label="Threat Vision" checked={s.visual.threatVision} onChange={(v) => update({ visual: { threatVision: v } })} hint="Layer toggles are in the Threat Vision panel" />
            <Toggle label="Square highlights" checked={s.visual.squareHighlights} onChange={(v) => update({ visual: { squareHighlights: v } })} />
            <Toggle label="Evaluation bar" checked={s.visual.evalBar} onChange={(v) => update({ visual: { evalBar: v } })} />
          </Card>
          <Card title="Intelligence">
            <Select label="Explanation detail" value={s.intelligence.detail} onChange={(v) => update({ intelligence: { detail: v } })} options={[{ value: 'brief', label: 'Brief' }, { value: 'standard', label: 'Standard' }, { value: 'detailed', label: 'Detailed' }]} />
            <Toggle label="Automatic position summaries" checked={s.intelligence.autoSummary} onChange={(v) => update({ intelligence: { autoSummary: v } })} />
            <Toggle label="Coaching recommendations" checked={s.intelligence.coachingRecommendations} onChange={(v) => update({ intelligence: { coachingRecommendations: v } })} />
          </Card>
          <Card title="Memory">
            <div className="small">IndexedDB usage: <b>{fmtBytes(est.usage)}</b>{est.quota ? ` of ${fmtBytes(est.quota)} available` : ''} · preferences: {fmtBytes(kvBytes)}</div>
            <table className="t" style={{ margin: '8px 0' }}>
              <tbody>{counts && TABLES.map((t) => (
                <tr key={t}><td><label className="row"><input type="checkbox" checked={clearSel.has(t)} onChange={(e) => { const n = new Set(clearSel); e.target.checked ? n.add(t) : n.delete(t); setClearSel(n); }} />{t}</label></td><td className="mono">{counts[t]}</td></tr>
              ))}</tbody>
            </table>
            <div className="row wrap">
              <button className="btn sm" onClick={async () => downloadText(`moth-chess-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export</button>
              <label className="btn sm">Import<input type="file" accept=".json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { await importAll(await f.text()); flash('Import complete'); await refresh(); } catch (err) { flash(`Import failed: ${(err as Error).message}`); } e.target.value = ''; }} /></label>
              <button className="btn sm danger" disabled={!clearSel.size} onClick={async () => { if (confirm(`Permanently delete all data in: ${[...clearSel].join(', ')}?`)) { await clearTables([...clearSel]); setClearSel(new Set()); flash('Data cleared'); await refresh(); } }}>Clear selected</button>
            </div>
          </Card>
          <Card title="General">
            <Toggle label="Enable MOTH Chess" checked={s.enabled} onChange={(v) => update({ enabled: v })} hint="Disabling removes all overlays immediately" />
            <Toggle label="Auto-analyse positions" checked={s.general.autoAnalyse} onChange={(v) => update({ general: { autoAnalyse: v } })} />
            <Toggle label="Start overlay minimised" checked={s.general.startMinimized} onChange={(v) => update({ general: { startMinimized: v } })} />
            <Toggle label="Notifications" checked={s.general.notifications} onChange={(v) => update({ general: { notifications: v } })} hint="e.g. when a game review finishes" />
            <div className="divider" />
            <div className="small muted" style={{ marginBottom: 4 }}>Keyboard shortcuts (change at brave://extensions/shortcuts)</div>
            {commands.filter((c) => c.name !== '_execute_action').map((c) => <div key={c.name} className="row small"><span className="grow">{c.description}</span><span className="kbd">{c.shortcut || 'unset'}</span></div>)}
            <div className="row small"><span className="grow">Board: previous / next move, flip, start-stop</span><span className="kbd">← → F Space</span></div>
            <div className="divider" />
            <div className="small muted" style={{ marginBottom: 4 }}>Site access (overlay on analysis boards only)</div>
            {SITES.map((site) => (
              <div key={site.id} className="row small"><span className="grow">{site.label}</span>
                {granted[site.id]
                  ? <button className="btn sm" onClick={async () => { await chrome.permissions.remove({ origins: [site.origin] }); await refresh(); }}>Revoke</button>
                  : <button className="btn sm primary" onClick={async () => { await chrome.permissions.request({ origins: [site.origin] }); await refresh(); }}>Allow</button>}
              </div>
            ))}
            <div className="divider" />
            <button className="btn danger" onClick={async () => { if (confirm('Reset all settings to defaults?')) { await resetSettings(); flash('Settings reset'); } }}>Reset settings</button>
          </Card>
        </div>
        <Card title="About">
          <p className="small" style={{ margin: 0 }}>MOTH Chess v1.0 · runs entirely in your browser · engine: Stockfish (GPL-3.0) compiled to WebAssembly, bundled locally · no accounts, servers or telemetry. MOTH is disabled on live/rated game pages and never moves pieces on any website.</p>
        </Card>
      </div>
    </div>
  );
}
