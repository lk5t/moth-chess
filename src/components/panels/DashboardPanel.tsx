import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty, Select, Stat, Tip } from '../ui';
import { BarChart, LineChart } from '../charts';
import { db } from '@/memory/db';
import { computeDashboard, type DashboardFilters, type Metric } from '@/dashboard/metrics';
import type { ExerciseAttempt, GameReview, SavedGame } from '@/types';

export function DashboardPanel({ compact }: { compact?: boolean }) {
  const { openFull } = useApp();
  const [data, setData] = useState<{ games: SavedGame[]; reviews: GameReview[]; attempts: ExerciseAttempt[] } | null>(null);
  const [f, setF] = useState<DashboardFilters>({});
  const [range, setRange] = useState<'all' | '7' | '30' | '90'>('all');
  useEffect(() => {
    const d = db();
    Promise.all([d.games.toArray(), d.reviews.toArray(), d.attempts.toArray()]).then(([games, reviews, attempts]) => setData({ games, reviews, attempts })).catch(() => setData({ games: [], reviews: [], attempts: [] }));
  }, []);
  const filters = useMemo<DashboardFilters>(() => ({ ...f, from: range === 'all' ? undefined : Date.now() - Number(range) * 86_400_000 }), [f, range]);
  const dash = useMemo(() => (data ? computeDashboard(data.games, data.reviews, data.attempts, filters) : null), [data, filters]);
  if (!dash) return <Card title="Performance Dashboard"><Empty>Loading…</Empty></Card>;

  const m = (x: Metric, suffix = '') => (x.value === null ? '—' : `${x.value}${suffix}`);
  const explain = (x: Metric) => <Tip tip={<>{x.explanation}<br />Sample: {x.n}</>}><span className="badge neutral" style={{ cursor: 'help' }}>?</span></Tip>;

  return (
    <div className="stack">
      <Card glow title="Performance Dashboard" actions={compact && <button className="btn sm" onClick={() => openFull?.({ tab: 'dashboard' })}>Open full dashboard</button>}>
        {!compact && (
          <div className="grid-3" style={{ marginBottom: 12 }}>
            <Select label="Date range" value={range} onChange={setRange} options={[{ value: 'all', label: 'All time' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]} />
            <Select label="My colour" value={(f.color ?? '') as '' | 'w' | 'b'} onChange={(v) => setF({ ...f, color: (v || undefined) as 'w' | 'b' | undefined })} options={[{ value: '', label: 'Either (or as imported)' }, { value: 'w', label: 'White' }, { value: 'b', label: 'Black' }]} />
            <Select label="Result" value={(f.result ?? '') as string} onChange={(v) => setF({ ...f, result: (v || undefined) as DashboardFilters['result'] })} options={[{ value: '', label: 'Any' }, { value: 'win', label: 'My wins' }, { value: 'loss', label: 'My losses' }, { value: 'draw', label: 'Draws' }]} />
            <div><label className="label" htmlFor="moth-eco">Opening (ECO prefix)</label><input id="moth-eco" className="input" placeholder="e.g. B or C50" value={f.eco ?? ''} onChange={(e) => setF({ ...f, eco: e.target.value || undefined })} /></div>
            <Select label="Training category" value={(f.category ?? '') as string} onChange={(v) => setF({ ...f, category: (v || undefined) as DashboardFilters['category'] })}
              options={[{ value: '', label: 'All' }, ...['tactic', 'opening', 'middlegame', 'endgame', 'missed-win', 'defence'].map((c) => ({ value: c, label: c }))]} />
          </div>
        )}
        {dash.gamesReviewed === 0 && <div className="banner warn">No reviewed games match these filters yet. Import games and run a review to populate the dashboard.</div>}
        <div className="grid-3">
          <Stat label="Games reviewed" value={dash.gamesReviewed} />
          <Stat label="Est. accuracy" value={<span className="row">{m(dash.accuracy, '%')} {explain(dash.accuracy)}</span>} low={dash.accuracy.n > 0 && dash.accuracy.lowConfidence} />
          <Stat label="Training success" value={<span className="row">{m(dash.trainingSuccess, '%')} {explain(dash.trainingSuccess)}</span>} low={dash.trainingSuccess.n > 0 && dash.trainingSuccess.lowConfidence} />
          <Stat label="Blunders / 100 moves" value={<span className="row">{m(dash.blundersPer100)} {explain(dash.blundersPer100)}</span>} low={dash.blundersPer100.n > 0 && dash.blundersPer100.n < 40} />
          <Stat label="Mistakes / 100 moves" value={<span className="row">{m(dash.mistakesPer100)} {explain(dash.mistakesPer100)}</span>} />
          <Stat label="Inaccuracies / 100" value={<span className="row">{m(dash.inaccuraciesPer100)} {explain(dash.inaccuraciesPer100)}</span>} />
          <Stat label="Opening accuracy" value={<span className="row">{m(dash.openingAccuracy, '%')} {explain(dash.openingAccuracy)}</span>} low={dash.openingAccuracy.n > 0 && dash.openingAccuracy.lowConfidence} />
          <Stat label="Endgame accuracy" value={<span className="row">{m(dash.endgameAccuracy, '%')} {explain(dash.endgameAccuracy)}</span>} low={dash.endgameAccuracy.n > 0 && dash.endgameAccuracy.lowConfidence} />
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>All metrics are MOTH estimates computed locally from Stockfish evaluations. They are not equivalent to accuracy scores on chess websites. "low n" marks small samples.</p>
      </Card>
      {!compact && (
        <>
          <Card title="Accuracy trend (weekly)">
            {dash.accuracyTrend.length < 2 ? <Empty>Need reviews from at least two different weeks.</Empty> : (
              <>
                <LineChart values={dash.accuracyTrend.map((t) => t.value)} min={0} max={100} height={110} label="Weekly accuracy" area />
                <div className="row small muted" style={{ justifyContent: 'space-between' }}><span>{dash.accuracyTrend[0].label}</span><span>{dash.accuracyTrend[dash.accuracyTrend.length - 1].label}</span></div>
              </>
            )}
          </Card>
          <div className="grid-2">
            <Card title="Opening performance">
              {!dash.openings.length && <Empty>No games.</Empty>}
              <table className="t"><thead><tr><th>Opening</th><th>Games</th><th>Score</th><th>Acc.</th></tr></thead>
                <tbody>{dash.openings.slice(0, 10).map((o) => <tr key={o.eco}><td title={o.name}><span className="badge">{o.eco}</span> {o.name.slice(0, 26)}</td><td>{o.games}{o.games < 3 && <span className="muted"> *</span>}</td><td>{o.score}%</td><td>{o.accuracy ?? '—'}</td></tr>)}</tbody>
              </table>
              <p className="muted small" style={{ marginBottom: 0 }}>Score uses your colour when known. * fewer than 3 games.</p>
            </Card>
            <Card title="Training by category">
              <BarChart label="Training success by category" data={dash.trainingByCategory.map((c) => ({ label: `${c.category} (${c.attempts})`, value: c.success }))} max={100} format={(v) => `${v}%`} />
            </Card>
          </div>
          <Card title="Recent evaluation graphs">
            {!dash.evalGraphs.length && <Empty>Review games to see evaluation graphs.</Empty>}
            <div className="grid-2">{dash.evalGraphs.map((g) => <div key={g.gameId}><div className="small muted">{g.title}</div><LineChart values={g.points} min={0} max={100} mid={50} height={70} label={`Evaluation graph ${g.title}`} area /></div>)}</div>
          </Card>
        </>
      )}
    </div>
  );
}
