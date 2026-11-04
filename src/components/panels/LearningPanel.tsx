// MOTH Engine learning dashboard + Learning Lab. Shows measured data only: the shipped model registry
// and benchmark results (produced by the offline pipeline), and this browser's own measurements
// (move latencies, practice games, Learning Lab runs and models).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from '@/memory/useLiveQuery';
import { useApp } from '../AppContext';
import { db, type StoredModel, type TrainingRun } from '@/memory/db';
import { latencyStats } from '@/play/client';
import { buildProfile, deletePracticeHistory } from '@/play/adaptation';
import type { Registry, RegistryEntry } from '@/moth-engine/training/gate';
import type { ModelMeta, ModelStatus } from '@/moth-engine/model';
import { ENGINE_NAME } from '@/moth-engine/uci';
import { Toggle } from '../ui';

interface Bench {
  generatedAt: string;
  machine: string;
  latency: Record<string, { n: number; mean: number; p50: number; p95: number; p99: number; max: number; target?: string }>;
  vsStockfish?: { movetimeMs: number; tactics: { moth: { solved: number; total: number }; stockfish: { solved: number; total: number } }; nps?: { moth: number; stockfish: number } };
  strength?: { method: string; estimateElo: number | null; ci95?: [number, number]; results: { opponent: string; elo: number; games: number; score: number }[] };
  tactics?: { budgetMs: number; solved: number; total: number; byTheme: Record<string, { solved: number; total: number }> };
  styles?: { forcedWinsAgree: number; mates?: number; positions: number; checkRate: Record<string, number>; captureRate: Record<string, number>; differentFromBalanced?: Record<string, number> };
  book?: { positions: number; moves: number; named: number; gambits: number; traps: number; mistakes: number; humanGames: number };
}

const asset = (p: string) => (typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(`moth-engine/${p}`) : `moth-engine/${p}`);
const STATUS_CLASS: Record<ModelStatus, string> = { training: 'neutral', 'awaiting-validation': 'warn', approved: 'good', rejected: 'bad', retired: 'neutral' };
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const ms = (x: number) => (x < 10 ? x.toFixed(2) : x.toFixed(1));

export function LearningPanel() {
  const { settings, updateSettings, toast } = useApp();
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [bench, setBench] = useState<Bench | null>(null);
  const [labLog, setLabLog] = useState<string[]>([]);
  const [labRunning, setLabRunning] = useState(false);
  const worker = useRef<Worker | null>(null);
  const runId = useRef<number | null>(null);

  useEffect(() => {
    fetch(asset('models/registry.json')).then((r) => (r.ok ? r.json() : null)).then(setRegistry).catch(() => setRegistry(null));
    fetch(asset('benchmarks.json')).then((r) => (r.ok ? r.json() : null)).then(setBench).catch(() => setBench(null));
    return () => worker.current?.terminate();
  }, []);

  const latency = useLiveQuery(() => db().latency.orderBy('at').reverse().limit(2000).toArray(), [], []);
  const labModels = useLiveQuery(() => db().models.orderBy('createdAt').reverse().toArray(), [], [] as StoredModel[]);
  const runs = useLiveQuery(() => db().runs.orderBy('at').reverse().limit(10).toArray(), [], [] as TrainingRun[]);
  const practice = useLiveQuery(() => db().practice.toArray(), [], []);
  const gameCount = useLiveQuery(() => db().games.count(), [], 0);
  const profile = useMemo(() => buildProfile(practice ?? []), [practice]);

  const localLatency = useMemo(() => {
    const by: Record<string, number[]> = {};
    for (const s of latency ?? []) (by[s.source] ??= []).push(s.ms);
    const all = (latency ?? []).filter((s) => s.source !== 'book').map((s) => s.ms);
    return { by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, latencyStats(v)])), uncached: latencyStats((latency ?? []).filter((s) => s.source === 'search').map((s) => s.ms)), all: latencyStats(all) };
  }, [latency]);

  const activeId = settings.moth.model === 'builtin' ? registry?.active ?? 'classical' : settings.moth.model.startsWith('idb:') ? settings.moth.model.slice(4) : settings.moth.model;
  const humanGames = registry?.models.reduce((a, m) => Math.max(a, m.summary.data?.humanGames ?? 0), 0) ?? 0;
  const selfPlay = registry?.models.reduce((a, m) => a + (m.summary.data?.selfPlayGames ?? 0), 0) ?? 0;

  const startLab = useCallback(async () => {
    const games = await db().games.toArray();
    if (games.length < 5) { toast('The Learning Lab needs at least 5 games in Memory (import PGNs or play MOTH).'); return; }
    const active = settings.moth.model.startsWith('idb:') ? await db().models.where('modelId').equals(settings.moth.model.slice(4)).first() : null;
    let parentBytes: ArrayBuffer | null = active?.bytes ?? null;
    let parentId = active?.modelId ?? 'classical';
    if (!active && registry?.active) {
      const e = registry.models.find((m) => m.id === registry.active);
      if (e) { const r = await fetch(asset(`models/${e.file}`)); if (r.ok) { parentBytes = await r.arrayBuffer(); parentId = e.id; } }
    }
    const w = new Worker(chrome.runtime.getURL('moth-train-worker.js'));
    worker.current = w;
    setLabRunning(true);
    setLabLog([`Learning Lab started from ${parentId} with ${games.length} games from Memory.`]);
    const params = { pgns: games.map((g) => g.pgn), parentBytes, parentId, teacherDepth: 7, selfPlayGames: 20, matchOpenings: 20, epochs: 4, seed: Date.now() % 100000 };
    runId.current = await db().runs.add({ at: Date.now(), status: 'running', log: [], params: { games: games.length, parentId, teacherDepth: 7, selfPlayGames: 20, matchGames: 40, epochs: 4 } });
    const logs: string[] = [];
    w.onmessage = async (e) => {
      const m = e.data as { type: string; msg?: string; meta?: ModelMeta; bytes?: ArrayBuffer };
      if (m.type === 'log') { logs.push(m.msg!); setLabLog((l) => [...l.slice(-200), m.msg!]); }
      if (m.type === 'done' && m.meta && m.bytes) {
        await db().models.add({ modelId: m.meta.id, meta: m.meta, bytes: m.bytes, createdAt: Date.now() });
        await db().runs.update(runId.current!, { status: 'done', log: logs, candidateId: m.meta.id, promoted: m.meta.status === 'approved' });
        toast(m.meta.status === 'approved' ? `Candidate ${m.meta.id} passed validation — you can activate it.` : `Candidate ${m.meta.id} was rejected (no measurable improvement).`);
        setLabRunning(false); w.terminate();
      }
      if (m.type === 'error' || m.type === 'cancelled') {
        if (m.msg) setLabLog((l) => [...l, `Stopped: ${m.msg}`]);
        await db().runs.update(runId.current!, { status: m.type === 'error' ? 'failed' : 'cancelled', log: [...logs, m.msg ?? 'cancelled'] });
        setLabRunning(false); w.terminate();
      }
    };
    w.onerror = () => { setLabRunning(false); setLabLog((l) => [...l, 'The training worker crashed.']); };
    w.postMessage({ type: 'start', params }, parentBytes ? [] : []);
  }, [registry, settings.moth.model, toast]);

  const activate = async (spec: string) => { await updateSettings({ moth: { model: spec } }); toast(`Active evaluation model: ${spec}`); };
  const exportModel = (m: StoredModel) => {
    const url = URL.createObjectURL(new Blob([m.bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a'); a.href = url; a.download = `${m.modelId}.mothnn`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row"><h2 style={{ margin: 0 }} className="grow">MOTH Engine</h2><span className="badge">{ENGINE_NAME}</span></div>
        <div className="grid-stats">
          <Stat k="Active evaluation model" v={activeId} />
          <Stat k="Human games processed" v={humanGames ? humanGames.toLocaleString() : '—'} />
          <Stat k="Self-play games" v={selfPlay ? selfPlay.toLocaleString() : '—'} />
          <Stat k="Training runs" v={String((registry?.models.length ?? 0) + (runs?.length ?? 0))} />
          <Stat k="Candidates evaluated" v={String((registry?.models.length ?? 0) + (labModels?.length ?? 0))} />
          <Stat k="Estimated strength" v={bench?.strength?.estimateElo ? `${bench.strength.estimateElo}${bench.strength.ci95 ? ` (${bench.strength.ci95[0]}–${bench.strength.ci95[1]})` : ''}` : '—'} hint={bench?.strength?.method} />
        </div>
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Model history</h3>
        {!registry?.models.length && !labModels?.length && <div className="empty">No trained models yet — MOTH is using its classical evaluation.</div>}
        <table className="t">
          <thead><tr><th>Model</th><th>Status</th><th>Val. loss (parent)</th><th>Match vs parent</th><th>Tactics</th><th /></tr></thead>
          <tbody>
            <tr><td>classical</td><td><span className="badge neutral">baseline</span></td><td>—</td><td>—</td><td>—</td><td><button className="btn sm" onClick={() => activate('classical')} disabled={settings.moth.model === 'classical'}>Use</button></td></tr>
            {registry?.models.map((m: RegistryEntry) => (
              <tr key={m.id} title={m.reasons.join('\n')}>
                <td className="mono">{m.id}{registry.active === m.id ? ' ★' : ''}</td>
                <td><span className={`badge ${STATUS_CLASS[m.status]}`}>{m.status}</span></td>
                <td>{m.summary.valLoss?.toFixed(5)} ({m.summary.valLossParent?.toFixed(5)})</td>
                <td>{m.summary.match ? `${(m.summary.match.score * 100).toFixed(1)}% · ${m.summary.match.elo >= 0 ? '+' : ''}${m.summary.match.elo} ± ${m.summary.match.eloError} (${m.summary.match.games} g)` : '—'}</td>
                <td>{m.summary.tactics ? `${m.summary.tactics.solved}/${m.summary.tactics.total} (${m.summary.parentTactics?.solved})` : '—'}</td>
                <td>{m.status !== 'rejected' && <button className="btn sm" disabled={settings.moth.model === `file:${m.file}` || (settings.moth.model === 'builtin' && registry.active === m.id)} onClick={() => activate(registry.active === m.id ? 'builtin' : `file:${m.file}`)}>Use</button>}</td>
              </tr>
            ))}
            {labModels?.map((m) => (
              <tr key={m.modelId} title={m.meta.decision?.reasons.join('\n')}>
                <td className="mono">{m.modelId}</td>
                <td><span className={`badge ${STATUS_CLASS[m.meta.status]}`}>{m.meta.status}</span></td>
                <td>{m.meta.metrics.valLoss?.toFixed(5)} ({m.meta.metrics.valLossParent?.toFixed(5)})</td>
                <td>{m.meta.metrics.match ? `${(m.meta.metrics.match.score * 100).toFixed(1)}% · ${m.meta.metrics.match.elo} ± ${m.meta.metrics.match.eloError}` : '—'}</td>
                <td>{m.meta.metrics.tactics ? `${m.meta.metrics.tactics.solved}/${m.meta.metrics.tactics.total}` : '—'}</td>
                <td className="row">
                  {m.meta.status === 'approved' && <button className="btn sm" disabled={settings.moth.model === `idb:${m.modelId}`} onClick={() => activate(`idb:${m.modelId}`)}>Activate</button>}
                  <button className="btn sm ghost" onClick={() => exportModel(m)}>Export</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {settings.moth.model !== 'builtin' && <button className="btn sm" onClick={() => activate('builtin')}>Roll back to the shipped model</button>}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Move response time</h3>
        <p className="small muted" style={{ margin: 0 }}>Targets (engineering goals, not guarantees): cached 1–5 ms · book 1–10 ms · typical 10–50 ms · complex 20–100 ms · default deadline 100 ms.</p>
        <table className="t">
          <thead><tr><th>Category</th><th>n</th><th>mean</th><th>P50</th><th>P95</th><th>P99</th><th>max</th></tr></thead>
          <tbody>
            {Object.entries(bench?.latency ?? {}).map(([k, v]) => <tr key={`b-${k}`}><td>{k} <span className="muted">(benchmark)</span></td><td>{v.n}</td><td>{ms(v.mean)}</td><td>{ms(v.p50)}</td><td>{ms(v.p95)}</td><td>{ms(v.p99)}</td><td>{ms(v.max)}</td></tr>)}
            {Object.entries(localLatency.by).map(([k, v]) => v && <tr key={`l-${k}`}><td>{k} <span className="muted">(this browser)</span></td><td>{v.n}</td><td>{ms(v.mean)}</td><td>{ms(v.p50)}</td><td>{ms(v.p95)}</td><td>{ms(v.p99)}</td><td>{ms(v.max)}</td></tr>)}
          </tbody>
        </table>
        {!bench && !latency?.length && <div className="empty">No measurements yet — play a game against MOTH.</div>}
      </div>

      {(bench?.tactics || bench?.vsStockfish) && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>Tactical test suite</h3>
          {bench?.tactics && <div className="small">MOTH solved <b>{bench.tactics.solved}/{bench.tactics.total}</b> ({pct(bench.tactics.solved, bench.tactics.total)}) at {bench.tactics.budgetMs} ms per puzzle.</div>}
          {bench?.vsStockfish && <div className="small">Same hardware and budget ({bench.vsStockfish.movetimeMs} ms): MOTH {bench.vsStockfish.tactics.moth.solved}/{bench.vsStockfish.tactics.moth.total} · Stockfish {bench.vsStockfish.tactics.stockfish.solved}/{bench.vsStockfish.tactics.stockfish.total}{bench.vsStockfish.nps ? ` · speed ${(bench.vsStockfish.nps.moth / 1e6).toFixed(2)} vs ${(bench.vsStockfish.nps.stockfish / 1e6).toFixed(2)} Mnps` : ''}</div>}
          {bench?.tactics && (
            <details><summary className="small">By theme</summary>
              <table className="t"><tbody>{Object.entries(bench.tactics.byTheme).sort((a, b) => b[1].total - a[1].total).map(([t, v]) => <tr key={t}><td>{t}</td><td>{v.solved}/{v.total}</td><td>{pct(v.solved, v.total)}</td></tr>)}</tbody></table>
            </details>
          )}
          {bench?.strength && (
            <details><summary className="small">Strength estimate details</summary>
              <div className="small muted">{bench.strength.method}</div>
              <table className="t"><tbody>{bench.strength.results.map((r) => <tr key={r.opponent}><td>{r.opponent}</td><td>{r.games} games</td><td>{(r.score * 100).toFixed(1)}%</td></tr>)}</tbody></table>
            </details>
          )}
        </div>
      )}

      {bench?.styles && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Playing styles</h3>
          <div className="small">Measured on {bench.styles.positions} middlegame positions: Aggressive picks a different move than Balanced in {pct((bench.styles.differentFromBalanced?.aggressive ?? 0) * bench.styles.positions, bench.styles.positions)} of them, Defensive in {pct((bench.styles.differentFromBalanced?.defensive ?? 0) * bench.styles.positions, bench.styles.positions)}. All three styles found the forced mate in {bench.styles.forcedWinsAgree}/{bench.styles.mates ?? bench.styles.forcedWinsAgree} mate puzzles.</div>
        </div>
      )}

      {bench?.book && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Opening knowledge</h3>
          <div className="grid-stats">
            <Stat k="Positions" v={bench.book.positions.toLocaleString()} /><Stat k="Validated moves" v={bench.book.moves.toLocaleString()} />
            <Stat k="Named lines" v={bench.book.named.toLocaleString()} /><Stat k="Gambit moves" v={bench.book.gambits.toLocaleString()} />
            <Stat k="Traps" v={String(bench.book.traps)} /><Stat k="Known mistakes" v={String(bench.book.mistakes)} />
          </div>
        </div>
      )}

      <div className="card stack">
        <div className="row"><h3 style={{ margin: 0 }} className="grow">Personal adaptation</h3>
          <Toggle checked={settings.moth.learning} onChange={(v) => updateSettings({ moth: { learning: v } })} label={<span className="small">Learn from my practice games</span>} />
        </div>
        <p className="small muted" style={{ margin: 0 }}>Kept separate from the engine model: it only changes which sound book lines MOTH prepares against you and what MOTH Coach recommends.</p>
        {profile.games === 0 ? <div className="empty">No practice games yet.</div> : (
          <>
            <div className="grid-stats">
              <Stat k="Practice games" v={String(profile.games)} />
              <Stat k="Score as White" v={profile.asWhite.games ? `${(profile.asWhite.score * 100).toFixed(0)}% (${profile.asWhite.games})` : '—'} />
              <Stat k="Score as Black" v={profile.asBlack.games ? `${(profile.asBlack.score * 100).toFixed(0)}% (${profile.asBlack.games})` : '—'} />
              <Stat k="Avg loss · opening" v={`${profile.phases.opening.toFixed(0)} cp`} />
              <Stat k="Avg loss · middlegame" v={`${profile.phases.middlegame.toFixed(0)} cp`} />
              <Stat k="Avg loss · endgame" v={`${profile.phases.endgame.toFixed(0)} cp`} />
            </div>
            {profile.weaknesses.length > 0 && <div className="small">Most frequent issues: {profile.weaknesses.slice(0, 5).map((w) => `${w.tag} (${w.count})`).join(' · ')}</div>}
            {profile.openings.length > 0 && <div className="small">Openings: {profile.openings.slice(0, 5).map((o) => `${o.name} — ${(o.score * 100).toFixed(0)}% in ${o.games}`).join(' · ')}</div>}
          </>
        )}
        <div><button className="btn sm danger" onClick={async () => { if (confirm('Delete all practice-game history used for personal adaptation?')) { await deletePracticeHistory(); toast('Practice history deleted'); } }}>Delete practice history</button></div>
      </div>

      <div className="card stack">
        <div className="row"><h3 style={{ margin: 0 }} className="grow">Learning Lab</h3>
          {labRunning ? <button className="btn sm danger" onClick={() => worker.current?.postMessage({ type: 'stop' })}>Stop</button> : <button className="btn sm primary" onClick={() => void startLab()}>Train from my games</button>}
        </div>
        <p className="small muted" style={{ margin: 0 }}>Trains a candidate network on the {gameCount} game{gameCount === 1 ? '' : 's'} in Memory plus self-play, labelled by a deeper MOTH search, then benchmarks it against the active model. Only measurable improvements are approved; everything else is kept as rejected.</p>
        {labLog.length > 0 && <pre className="small mono" style={{ maxHeight: 220, overflow: 'auto', margin: 0 }} aria-live="polite">{labLog.join('\n')}</pre>}
        {runs && runs.length > 0 && <div className="small muted">Previous runs: {runs.map((r) => `${new Date(r.at).toLocaleString()} ${r.status}${r.promoted ? ' (approved)' : r.candidateId ? ' (rejected)' : ''}`).join(' · ')}</div>}
      </div>
    </div>
  );
}

function Stat({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return <div className="stat" title={hint}><div className="k">{k}</div><div className="v" style={{ fontSize: 15 }}>{v}</div></div>;
}
