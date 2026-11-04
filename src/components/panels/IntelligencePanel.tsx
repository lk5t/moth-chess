import { useMemo } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty, SourceTag } from '../ui';
import { explainPosition, type InsightCategory } from '@/intelligence/explain';

const CAT_LABEL: Record<InsightCategory, string> = {
  summary: 'Overview', material: 'Material', development: 'Development', 'king-safety': 'King safety', 'pawn-structure': 'Pawn structure',
  center: 'Centre', hanging: 'Loose pieces', tactics: 'Tactics', endgame: 'Endgame', comparison: 'Comparison',
};

export function IntelligencePanel() {
  const { fen, analysis, settings, play, cursor } = useApp();
  const report = useMemo(() => {
    try { return explainPosition(fen, analysis.result, { detail: settings.intelligence.detail, ply: cursor }); } catch (e) { return { error: (e as Error).message } as const; }
  }, [fen, analysis.result, settings.intelligence.detail, cursor]);
  if ('error' in report) return <Card title="MOTH Intelligence"><div className="banner bad">{report.error}</div></Card>;
  const f = report.features;
  return (
    <div className="stack">
      {settings.intelligence.autoSummary && (
        <Card glow title={<span className="row">Position summary <span className="badge">{report.phase}</span></span>}>
          <p style={{ margin: 0, fontSize: 13.5 }}>{report.summary}</p>
          {!analysis.result && <p className="muted small" style={{ marginBottom: 0 }}>Engine results not available yet — showing heuristic observations only.</p>}
        </Card>
      )}
      <Card title="Key observations" actions={<span className="row small muted"><SourceTag source="engine" /><SourceTag source="rules" /><SourceTag source="heuristic" /></span>}>
        {!report.insights.length && <Empty>Nothing notable detected.</Empty>}
        <div className="stack" style={{ gap: 6 }}>
          {report.insights.map((i, k) => (
            <div key={k} className="row" style={{ alignItems: 'flex-start' }}>
              <SourceTag source={i.source} />
              <div className="grow"><span className="muted small">{CAT_LABEL[i.category]} · </span>{i.text}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Candidate moves compared">
        {!report.candidates.length && <Empty>Start the engine to compare candidate moves.</Empty>}
        <div className="stack">
          {report.candidates.map((c) => (
            <div key={c.uci} className="card" style={{ padding: 10, background: 'var(--panel-2)' }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <button className="btn sm" onClick={() => play(c.uci)} title="Play on board">{c.rank}. {c.san}</button>
                <span className="mono">{c.evalText}</span>
                {c.rank > 1 && <span className={`badge ${c.deltaFromBestCp > 100 ? 'bad' : c.deltaFromBestCp > 30 ? 'warn' : 'good'}`}>−{(c.deltaFromBestCp / 100).toFixed(2)}</span>}
                <span className="grow" /><span className="muted small">depth {c.engineDepth}</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }} className="stack small">
                {c.reasons.map((r, i) => <li key={i} className="row" style={{ alignItems: 'flex-start', gap: 6 }}><SourceTag source={r.source} /><span>{r.text}</span></li>)}
              </ul>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Verified board features">
        <table className="t">
          <thead><tr><th /><th>White</th><th>Black</th></tr></thead>
          <tbody>
            <tr><td>Material</td><td>{f.w.material}</td><td>{f.b.material}</td></tr>
            <tr><td>Minor pieces developed</td><td>{f.w.developed}</td><td>{f.b.developed}</td></tr>
            <tr><td>King</td><td>{f.w.kingSquare}{f.w.castled ? ' (castled)' : ''}</td><td>{f.b.kingSquare}{f.b.castled ? ' (castled)' : ''}</td></tr>
            <tr><td>Pawn shield / king-zone attacks</td><td>{f.w.pawnShield} / {f.w.kingAttackers}</td><td>{f.b.pawnShield} / {f.b.kingAttackers}</td></tr>
            <tr><td>Centre control</td><td>{f.w.centerControl}</td><td>{f.b.centerControl}</td></tr>
            <tr><td>Doubled / isolated pawns</td><td>{f.w.doubledPawns} / {f.w.isolatedPawns}</td><td>{f.b.doubledPawns} / {f.b.isolatedPawns}</td></tr>
            <tr><td>Passed pawns</td><td>{f.w.passedPawns.join(' ') || '—'}</td><td>{f.b.passedPawns.join(' ') || '—'}</td></tr>
            <tr><td>Hanging pieces</td><td>{f.w.hanging.map((h) => h.square).join(' ') || '—'}</td><td>{f.b.hanging.map((h) => h.square).join(' ') || '—'}</td></tr>
            <tr><td>Mobility</td><td>{f.w.mobility}</td><td>{f.b.mobility}</td></tr>
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>Explanations come from deterministic MOTH heuristics over these features. Stockfish provides evaluations and lines only; it does not write explanations.</p>
      </Card>
    </div>
  );
}
