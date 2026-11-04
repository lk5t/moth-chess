// MOTH Control Center (v2.1): one place for status, engines, profile, websites, backups, diagnostics and
// release information. Everything here is local; the only outbound action is a GitHub link the user opens.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSettings } from '@/settings/useSettings';
import { Card, Icon, useThemeRoot, BetaBadge } from '@/components/ui';
import { ProfilePicker, SitesList, BackupCard, FairPlayNote, appVersion, openExt, useGrantedSites } from '@/components/shared';
import { engineCheck, storageCheck, type CheckResult } from '@/diagnostics/checks';
import { clearErrors, readErrors, subscribeErrors, type LogEntry } from '@/diagnostics/log';
import { browserName, buildReport, issueLink } from '@/diagnostics/report';
import { tableCounts, storageEstimate, downloadText } from '@/memory/repo';
import { kvGet } from '@/storage/kv';
import { MIGRATION_KEY } from '@/settings/store';
import { SITES } from '@/content/detector/sites';
import { CHANGELOG, FEATURE_STATUS } from './changelog';

const NAV = [['overview', 'Overview'], ['engines', 'Engines'], ['sites', 'Websites'], ['data', 'Backup & data'], ['feedback', 'Feedback & diagnostics'], ['changelog', "What's new"]] as const;
type Sec = (typeof NAV)[number][0];

function Tile({ k, v, children }: { k: string; v: ReactNode; children?: ReactNode }) {
  return <div className="tile"><span className="k">{k}</span><span className="v">{v}</span>{children}</div>;
}

export function ControlApp() {
  const [s, update, loaded] = useSettings();
  useThemeRoot(s);
  const [sec, setSec] = useState<Sec>(((location.hash.slice(1) as Sec) || 'overview'));
  useEffect(() => { const on = () => setSec((location.hash.slice(1) as Sec) || 'overview'); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  const { granted } = useGrantedSites();
  const [errors, setErrors] = useState<LogEntry[]>([]);
  useEffect(() => { void readErrors().then(setErrors); return subscribeErrors(setErrors); }, []);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const runChecks = async () => {
    setChecking(true); setChecks(null);
    const out: CheckResult[] = [];
    for (const k of ['moth', 'stockfish'] as const) { out.push(await engineCheck(k)); setChecks([...out]); }
    out.push(await storageCheck()); setChecks([...out]);
    setChecking(false);
  };
  const allowedCount = Object.values(granted).filter(Boolean).length;
  const recentErrors = errors.filter((e) => Date.now() - e.at < 24 * 3600e3).length;

  if (!loaded) return null;
  return (
    <div className="neural-bg" style={{ minHeight: '100vh' }}>
      <div className="page">
        <header className="page-header">
          <img src="icons/moth.svg" alt="" />
          <h1>MOTH Control Center</h1><BetaBadge label="Public beta" />
          <span className="grow" />
          <span className="small muted">v{appVersion()}</span>
        </header>
        <div className="split">
          <nav className="subnav" aria-label="Control Center sections">
            {NAV.map(([id, label]) => <a key={id} href={`#${id}`} className={sec === id ? 'active' : ''} aria-current={sec === id ? 'page' : undefined}>{label}</a>)}
            <div className="divider" />
            <a href="#" onClick={(e) => { e.preventDefault(); openExt('board.html'); }}>Analysis board ↗</a>
            <a href="#" onClick={(e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); }}>Settings ↗</a>
          </nav>
          <main className="stack" style={{ gap: 16 }}>
            {sec === 'overview' && (
              <>
                <div className="status-grid">
                  <Tile k="MOTH Chess" v={<><span className={`dot ${s.enabled ? 'ready' : 'error'}`} />{s.enabled ? 'On' : 'Off'}</>}>
                    <button className="btn sm" onClick={() => update({ enabled: !s.enabled })}>{s.enabled ? 'Turn off' : 'Turn on'}</button>
                  </Tile>
                  <Tile k="Analysis engine" v={s.engine.kind === 'moth' ? 'MOTH Engine' : 'Stockfish 17.1'}>
                    <span className="small muted">Review & coach: {s.engine.reviewKind === 'moth' ? 'MOTH Engine' : 'Stockfish'}</span>
                    <div className="seg" role="group" aria-label="Analysis engine">
                      <button aria-pressed={s.engine.kind === 'moth'} onClick={() => update({ engine: { kind: 'moth' } })}>MOTH</button>
                      <button aria-pressed={s.engine.kind === 'stockfish'} onClick={() => update({ engine: { kind: 'stockfish' } })}>Stockfish</button>
                    </div>
                  </Tile>
                  <Tile k="Websites" v={`${allowedCount} of ${SITES.length} allowed`}><a className="small" href="#sites">Manage</a></Tile>
                  <Tile k="Health" v={<><span className={`dot ${recentErrors ? 'error' : 'ready'}`} />{recentErrors ? `${recentErrors} error${recentErrors > 1 ? 's' : ''} today` : 'No recent errors'}</>}><a className="small" href="#feedback">Diagnostics</a></Tile>
                </div>
                <Card title="Performance profile"><ProfilePicker settings={s} update={update} /></Card>
                <Card title="Go to">
                  <div className="status-grid">
                    {[
                      ['Analysis board', Icon.board, () => openExt('board.html')],
                      ['Play MOTH', Icon.play, () => openExt('board.html?tab=play')],
                      ['Training & Coach', Icon.coach, () => openExt('board.html?tab=coach')],
                      ['MOTH Engine & learning', Icon.engine, () => openExt('board.html?tab=engine')],
                      ['Settings', Icon.gear, () => chrome.runtime.openOptionsPage()],
                      ['Welcome tour', Icon.spark, () => openExt('welcome.html')],
                    ].map(([label, icon, go]) => (
                      <button key={label as string} className="btn" style={{ justifyContent: 'flex-start', height: 44 }} onClick={go as () => void}><span style={{ width: 18, height: 18, display: 'inline-flex' }}>{icon as ReactNode}</span>{label as string}</button>
                    ))}
                  </div>
                </Card>
                <FairPlayNote />
              </>
            )}

            {sec === 'engines' && (
              <>
                <Card title="Engine self-check" actions={<button className="btn sm primary" disabled={checking} onClick={runChecks}>{checking ? 'Checking…' : 'Run checks'}</button>}>
                  <div className="small muted" style={{ marginBottom: 8 }}>Starts each engine in a fresh worker, analyses the starting position, then shuts it down again.</div>
                  {!checks && !checking && <div className="empty">Not run yet.</div>}
                  {checks?.map((c) => (
                    <div key={c.name} className="row small" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }} data-testid="check">
                      <span className={`badge ${c.ok ? 'good' : 'bad'}`}>{c.ok ? 'OK' : 'Problem'}</span><b>{c.name}</b><span className="grow muted">{c.detail}</span>
                    </div>
                  ))}
                </Card>
                <Card title="Engines">
                  <table className="t"><tbody>
                    <tr><td>MOTH Engine</td><td className="small muted">Original engine (C++ → WebAssembly), trained evaluation network, styles: aggressive / balanced / defensive. Style: <b>{s.moth.style}</b>, model: <span className="mono">{s.moth.model}</span>.</td></tr>
                    <tr><td>Stockfish 17.1 lite</td><td className="small muted">Single-threaded WebAssembly build (GPL-3.0). Stronger; used for game review by default.</td></tr>
                  </tbody></table>
                  <div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={() => openExt('board.html?tab=engine')}>Open the MOTH Engine dashboard</button></div>
                </Card>
              </>
            )}

            {sec === 'sites' && (<><FairPlayNote /><SitesList /></>)}

            {sec === 'data' && (<Card title="Backup and restore"><BackupCard settings={s} update={update} /></Card>)}

            {sec === 'feedback' && <Feedback errors={errors} checks={checks} />}

            {sec === 'changelog' && (
              <>
                <Card title="Feature status">
                  <table className="t"><tbody>{FEATURE_STATUS.map((f) => (
                    <tr key={f.name}><td>{f.name}</td><td><span className={`badge ${f.status === 'Stable' ? 'good' : f.status === 'Beta' ? 'beta' : 'warn'}`}>{f.status}</span></td><td className="small muted">{f.note}</td></tr>
                  ))}</tbody></table>
                </Card>
                {CHANGELOG.map((c) => (
                  <Card key={c.version} title={<span className="row">v{c.version} · {c.title}<span className="muted small" style={{ fontWeight: 400 }}>{c.date}</span></span>}>
                    <ul style={{ margin: 0, paddingLeft: 18 }} className="small">{c.items.map((i) => <li key={i}>{i}</li>)}</ul>
                  </Card>
                ))}
                <div className="small muted">MOTH Chess is free and in public beta. There are no accounts or subscriptions.</div>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function Feedback({ errors, checks }: { errors: LogEntry[]; checks: CheckResult[] | null }) {
  const [s] = useSettings();
  const { granted } = useGrantedSites();
  const [kind, setKind] = useState<'bug' | 'feedback'>('bug');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [incSettings, setIncSettings] = useState(true);
  const [incErrors, setIncErrors] = useState(true);
  const [extra, setExtra] = useState<{ counts?: Record<string, number>; storage?: { usage?: number; quota?: number }; migration?: any }>({});
  useEffect(() => { void (async () => setExtra({ counts: await tableCounts(), storage: await storageEstimate(), migration: await kvGet(MIGRATION_KEY) }))(); }, []);
  const generated = useMemo(() => buildReport({
    version: appVersion(), browser: browserName(), platform: (navigator as any).userAgentData?.platform ?? navigator.platform,
    settings: s, grantedSites: SITES.filter((x) => granted[x.id]).map((x) => x.id), engines: [], counts: extra.counts, storage: extra.storage,
    errors, migration: extra.migration ?? null, checks: checks ?? undefined,
  }, { includeSettings: incSettings, includeErrors: incErrors }).replace('(describe what you did, what you expected and what you saw)', desc || '(describe what you did, what you expected and what you saw)'),
  [s, granted, extra, errors, checks, incSettings, incErrors, desc]);
  const [edited, setEdited] = useState<string | null>(null);
  const text = edited ?? generated;
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Card title="Send feedback or report a bug">
        <div className="small muted" style={{ marginBottom: 8 }}>Nothing is sent automatically. Review the report below, then copy it, save it, or open a pre-filled GitHub issue yourself.</div>
        <div className="seg" role="group" aria-label="Report type" style={{ marginBottom: 8 }}>
          <button aria-pressed={kind === 'bug'} onClick={() => setKind('bug')}>Bug</button>
          <button aria-pressed={kind === 'feedback'} onClick={() => setKind('feedback')}>Idea / feedback</button>
        </div>
        <input className="input" placeholder="Short title" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
        <textarea className="input" placeholder="What happened? What did you expect?" aria-label="Description" value={desc} onChange={(e) => { setDesc(e.target.value); setEdited(null); }} rows={4} style={{ width: '100%' }} />
        <div className="row small wrap" style={{ margin: '6px 0' }}>
          <label className="row"><input type="checkbox" checked={incSettings} onChange={(e) => { setIncSettings(e.target.checked); setEdited(null); }} />Include settings</label>
          <label className="row"><input type="checkbox" checked={incErrors} onChange={(e) => { setIncErrors(e.target.checked); setEdited(null); }} />Include error log</label>
          {!checks && <span className="muted">Tip: run the engine self-check first to include its results.</span>}
        </div>
        <label className="label" htmlFor="report">Report preview (editable)</label>
        <textarea id="report" className="input mono" value={text} onChange={(e) => setEdited(e.target.value)} rows={14} style={{ width: '100%', fontSize: 11.5 }} data-testid="report" />
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn" onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? 'Copied' : 'Copy report'}</button>
          <button className="btn" onClick={() => downloadText(`moth-chess-report-${new Date().toISOString().slice(0, 10)}.md`, text, 'text/markdown')}>Save as file</button>
          <span className="grow" />
          <a className="btn primary" href={issueLink(kind, title || (kind === 'bug' ? 'Bug report' : 'Feedback'), text)} target="_blank" rel="noreferrer">Open GitHub issue…</a>
        </div>
      </Card>
      <Card title={`Error log (${errors.length})`} actions={errors.length ? <button className="btn sm" onClick={() => clearErrors()}>Clear</button> : undefined}>
        {!errors.length && <div className="empty">No errors recorded.</div>}
        {errors.slice().reverse().slice(0, 30).map((e, i) => (
          <div key={i} className="small" style={{ padding: '4px 0', borderTop: '1px solid var(--line)' }}>
            <span className="muted mono">{new Date(e.at).toLocaleString()}</span> <b>{e.source}</b> {e.message}{e.count > 1 ? <span className="badge neutral" style={{ marginLeft: 6 }}>×{e.count}</span> : null}
          </div>
        ))}
      </Card>
    </>
  );
}
