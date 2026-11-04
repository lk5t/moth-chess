// Library → Player DNA (3.0): a local profile built from your completed games, reviews and training.
import { useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty, Stat } from '../ui';
import { BarChart, LineChart } from '../charts';
import { useLiveQuery } from '@/memory/useLiveQuery';
import { loadDna, resetDna } from '@/training/adaptive';
import { DashboardPanel } from './DashboardPanel';

const pct = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`);

export function DnaPanel() {
  const { setTab, toast } = useApp();
  const [tick, setTick] = useState(0);
  const dna = useLiveQuery(() => loadDna(), [tick], null);
  if (!dna) return <Empty>Building your profile…</Empty>;
  return (
    <div className="stack">
      {!dna.sufficient && (
        <div className="banner">
          <b>Your Player DNA grows with every reviewed game.</b> {dna.weaknesses.recommendations[0]}
          <div className="row" style={{ marginTop: 6 }}><button className="btn sm primary" onClick={() => setTab('review')}>Review a game</button><button className="btn sm" onClick={() => setTab('memory')}>Import games</button></div>
        </div>
      )}
      <div className="grid-3">
        <Stat label="Games" value={dna.games} hint={`${dna.reviewed} reviewed`} />
        <Stat label="Average accuracy" value={dna.accuracy.overall === null ? '—' : `${dna.accuracy.overall.toFixed(1)}%`} low={dna.reviewed < 5} hint="your moves, reviewed games" />
        <Stat label="Training success" value={dna.training.attempts ? pct(dna.training.success / dna.training.attempts) : '—'} low={dna.training.attempts < 5} hint={`${dna.training.attempts} exercises`} />
      </div>
      {dna.style.length > 0 && <Card title="What stands out"><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{dna.style.map((s) => <li key={s}>{s}</li>)}{dna.weaknesses.recurring.map((s) => <li key={s}>{s}</li>)}</ul></Card>}
      <div className="grid-2">
        <Card title="Mistakes by game phase">
          {dna.phases.some((p) => p.mistakes) ? <BarChart label="Mistakes and blunders by phase" data={dna.phases.map((p) => ({ label: p.phase, value: p.mistakes, hint: `average loss ${(p.avgLoss * 100).toFixed(0)}% win chance` }))} /> : <Empty>No reviewed mistakes yet.</Empty>}
        </Card>
        <Card title="Tactical patterns you missed">
          {dna.motifs.length ? <BarChart label="Missed tactical motifs" data={dna.motifs.slice(0, 6).map((m) => ({ label: m.motif, value: m.count }))} /> : <Empty>Generated from your reviewed games.</Empty>}
        </Card>
      </div>
      <Card title="Accuracy trend">
        {dna.accuracy.trend.length >= 2 ? <LineChart label="Accuracy per 5 reviewed games" values={dna.accuracy.trend.map((t) => t.value)} min={0} max={100} height={90} area format={(v) => `${v.toFixed(0)}%`} /> : <Empty>Needs at least 6 reviewed games.</Empty>}
      </Card>
      <div className="grid-2">
        <Card title="Your openings">
          {!dna.openings.length && <Empty>Openings appear once games are imported or played.</Empty>}
          {dna.openings.map((o) => <div key={o.name} className="row small"><span className="badge neutral">{o.eco}</span><span className="grow">{o.name}</span><span className="muted">{o.games} · {pct(o.score)}</span></div>)}
        </Card>
        <Card title="Endgame practice">
          {!dna.endgame.drills && <Empty>Try the endgame drills in Train → Practice.</Empty>}
          {dna.endgame.byKind.map((k) => <div key={k.id} className="row small"><span className="grow">{k.title}</span><span className="muted">{k.solved}/{k.tries} solved</span></div>)}
        </Card>
      </div>
      <details className="card" style={{ padding: 12 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Detailed statistics and filters</summary>
        <div style={{ marginTop: 10 }}><DashboardPanel /></div>
      </details>
      <div className="row">
        <span className="grow small muted">Built only from games you imported, reviewed or played here — never from live play. Stored on this device.</span>
        <button className="btn sm danger" onClick={async () => { if (confirm('Reset your training history and exercise progress? Saved games and reviews are kept.')) { await resetDna({ history: true, exercises: true }); toast('Player DNA training data reset'); setTick((t) => t + 1); } }}>Reset profile data</button>
      </div>
    </div>
  );
}
