// Components shared by Settings, the Control Center, onboarding and the popup (v2.1).
import { useEffect, useState, type ReactNode } from 'react';
import type { Settings, SettingsPatch, ProfileId } from '@/settings/schema';
import { PROFILES, profilePatch } from '@/settings/profiles';
import { SITES, type SiteDef } from '@/content/detector/sites';
import { createBackup, inspectBackup, restoreBackup, type BackupCheck } from '@/backup/backup';
import { downloadText } from '@/memory/repo';

export const appVersion = () => (typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : 'dev');
export const extUrl = (p: string) => (typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(p) : p);
export const openExt = (p: string) => window.open(extUrl(p), '_blank');

/** Segmented Eco / Standard / Performance picker with the active profile's description. */
export function ProfilePicker({ settings, update, compact }: { settings: Settings; update: (p: SettingsPatch) => unknown; compact?: boolean }) {
  const cur = settings.performance.profile;
  const def = PROFILES.find((p) => p.id === cur);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="seg" role="group" aria-label="Performance profile">
        {PROFILES.map((p) => (
          <button key={p.id} aria-pressed={cur === p.id} onClick={() => update(profilePatch(p.id))}>{p.label}</button>
        ))}
        {cur === 'custom' && <button aria-pressed disabled title="You changed engine resources by hand">Custom</button>}
      </div>
      {!compact && <div className="small muted">{def ? def.summary : 'Custom: engine resources were changed by hand. Pick a profile to replace them.'}</div>}
    </div>
  );
}
export const profileLabel = (id: ProfileId) => PROFILES.find((p) => p.id === id)?.label ?? 'Custom';

/** Allowed/blocked contexts per site, from fair-play/sites.json. */
export function contextsOf(site: SiteDef): { allowed: string[]; blocked: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return { allowed: uniq((site.allow ?? []).map((a) => a.context)), blocked: uniq((site.block ?? []).map((b) => b.reason.replace(/\s*\(.*\)$/, ''))) };
}

export function useGrantedSites() {
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const refresh = async () => {
    const g: Record<string, boolean> = {};
    for (const s of SITES) { try { g[s.id] = await chrome.permissions.contains({ origins: [s.origin] }); } catch { g[s.id] = false; } }
    setGranted(g);
  };
  useEffect(() => {
    void refresh();
    const on = () => void refresh();
    const ev = chrome.permissions as unknown as { onAdded?: chrome.events.Event<() => void>; onRemoved?: chrome.events.Event<() => void> };
    ev?.onAdded?.addListener(on);
    ev?.onRemoved?.addListener(on);
    return () => { ev?.onAdded?.removeListener(on); ev?.onRemoved?.removeListener(on); };
  }, []);
  return { granted, refresh };
}

/** Supported websites with permission status, what is allowed and what is always blocked. */
export function SitesList({ detailed = true }: { detailed?: boolean }) {
  const { granted, refresh } = useGrantedSites();
  return (
    <div className="stack" style={{ gap: 10 }}>
      {SITES.map((site) => {
        const c = contextsOf(site);
        return (
          <div key={site.id} className="tile" data-site={site.id}>
            <div className="row">
              <b className="grow">{site.label}</b>
              <span className={`badge ${granted[site.id] ? 'good' : 'neutral'}`}>{granted[site.id] ? 'Allowed' : 'Not allowed yet'}</span>
              {granted[site.id]
                ? <button className="btn sm" onClick={async () => { await chrome.permissions.remove({ origins: [site.origin] }); await refresh(); }}>Revoke</button>
                : <button className="btn sm primary" onClick={async () => { await chrome.permissions.request({ origins: [site.origin] }); await refresh(); }}>Allow</button>}
            </div>
            {detailed && (
              <div className="small">
                <div><span className="muted">Analysis works on:</span> {c.allowed.join(', ') || '—'}</div>
                <div><span className="muted">Always blocked:</span> {c.blocked.join(', ') || '—'}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FairPlayNote({ children }: { children?: ReactNode }) {
  return (
    <div className="banner" role="note">
      <b>Fair play.</b> MOTH analyses only analysis boards, studies, practice and games against the computer on sites you allow.
      It switches itself off on live, rated, tournament, TV and rated-puzzle pages and when a game clock is visible, and it never moves pieces on any website. {children}
    </div>
  );
}

/** Export everything to a local file / restore with a validated preview. */
export function BackupCard({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => unknown }) {
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ name: string; text: string; check: BackupCheck } | null>(null);
  const [opts, setOpts] = useState({ settings: true, data: true });
  const [msg, setMsg] = useState<{ kind: 'good' | 'bad'; text: string } | null>(null);
  const exportNow = async () => {
    setBusy(true);
    try {
      const text = await createBackup(settings, appVersion());
      downloadText(`moth-chess-backup-${new Date().toISOString().slice(0, 10)}.json`, text);
      setMsg({ kind: 'good', text: `Backup saved (${(text.length / 1024).toFixed(0)} KB). It stays on your device.` });
    } catch (e) { setMsg({ kind: 'bad', text: `Export failed: ${(e as Error).message}` }); }
    setBusy(false);
  };
  const restore = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await restoreBackup(file.text, opts, settings);
      if (r.settings) await update(r.settings);
      const n = Object.values(r.data.inserted).reduce((a, b) => a + b, 0);
      const d = Object.values(r.data.skippedDuplicates).reduce((a, b) => a + b, 0);
      setMsg({ kind: 'good', text: `Restored${r.settings ? ' settings and' : ''} ${n} record(s); ${d} already present were kept.` });
      setFile(null);
    } catch (e) { setMsg({ kind: 'bad', text: `Restore failed — nothing was changed in settings. ${(e as Error).message}` }); }
    setBusy(false);
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">A backup contains your settings, saved games, reviews, positions, training and practice history. Trained engine models are exported separately from the MOTH Engine page.</div>
      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={exportNow}>Export backup</button>
        <label className="btn">Choose backup file…<input type="file" accept=".json,application/json" hidden aria-label="Backup file" onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          const text = await f.text();
          setFile({ name: f.name, text, check: inspectBackup(text) }); setMsg(null);
        }} /></label>
      </div>
      {file && (
        <div className="tile" data-testid="backup-preview">
          <div className="row"><b className="grow">{file.name}</b><span className={`badge ${file.check.ok ? 'good' : 'bad'}`}>{file.check.ok ? 'Valid' : 'Cannot restore'}</span></div>
          {file.check.ok && <div className="small">{file.check.kind === 'backup' ? `MOTH Chess ${file.check.app ?? ''} backup` : 'MOTH Chess 2.0 Memory export'}{file.check.createdAt ? ` from ${file.check.createdAt.slice(0, 10)}` : ''} · {Object.entries(file.check.counts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'no records'}</div>}
          {file.check.errors.map((e) => <div key={e} className="small" style={{ color: 'var(--bad)' }}>{e}</div>)}
          {file.check.warnings.map((w) => <div key={w} className="small muted">{w}</div>)}
          {file.check.ok && (
            <div className="row wrap small" style={{ marginTop: 4 }}>
              {file.check.hasSettings && <label className="row"><input type="checkbox" checked={opts.settings} onChange={(e) => setOpts({ ...opts, settings: e.target.checked })} />Replace settings</label>}
              <label className="row"><input type="checkbox" checked={opts.data} onChange={(e) => setOpts({ ...opts, data: e.target.checked })} />Merge data (keeps existing records)</label>
              <span className="grow" />
              <button className="btn sm" onClick={() => setFile(null)}>Cancel</button>
              <button className="btn sm primary" disabled={busy || (!opts.settings && !opts.data)} onClick={restore}>Restore</button>
            </div>
          )}
        </div>
      )}
      {msg && <div className={`banner ${msg.kind} small`} aria-live="polite">{msg.text}</div>}
    </div>
  );
}
