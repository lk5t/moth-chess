// Analyze → Endgame (3.0): what kind of endgame this is, a verdict with its certainty, promotion races
// and the key ideas. KPK verdicts are exact (local table); other verdicts are labelled as theory/heuristic.
import { useMemo } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty } from '../ui';
import { analyseEndgame, ENDGAME_DRILLS } from '@/endgame/endgame';

const RESULT = { 'win-white': 'White wins', 'win-black': 'Black wins', draw: 'Draw', unclear: 'Unclear' } as const;
const CERT = { exact: 'exact (local table)', theory: 'known theory', heuristic: 'rule of thumb — check with the engine' } as const;

export function EndgamePanel() {
  const { fen, analysis, loadFen, setTab } = useApp();
  const info = useMemo(() => { try { return analyseEndgame(fen); } catch { return null; } }, [fen]);
  if (!info) return <Empty>This position could not be read.</Empty>;
  const top = analysis.result?.lines[0];
  return (
    <div className="stack">
      <Card glow title={<span className="row">{info.title}<span className="badge neutral">{info.material}</span></span>}>
        {!info.isEndgame && <div className="small muted">Endgame guidance appears once most pieces are off the board. Try a training position below.</div>}
        {info.verdict && (
          <div className="stack" style={{ gap: 4 }} data-testid="endgame-verdict">
            <div className="row"><b style={{ fontSize: 16 }}>{RESULT[info.verdict.result]}</b><span className={`badge ${info.verdict.certainty === 'exact' ? 'good' : 'neutral'}`}>{CERT[info.verdict.certainty]}</span></div>
            <div className="small">{info.verdict.why}</div>
            {top && info.verdict.certainty !== 'exact' && <div className="small muted">Engine ({analysis.engineName}, depth {analysis.result?.depth}): {top.pvSan.slice(0, 4).join(' ')}</div>}
          </div>
        )}
        {info.races.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="small muted" style={{ marginBottom: 4 }}>Passed pawns (rule of the square)</div>
            {info.races.map((r) => (
              <div key={r.pawn} className="row small"><span className="badge neutral">{r.white ? 'White' : 'Black'} {r.pawn}</span>
                <span className="grow">queens in {r.movesToQueen} move{r.movesToQueen === 1 ? '' : 's'} · {r.insideSquare ? 'the enemy king is inside the square (can catch it)' : 'the enemy king is outside the square'}</span>
                {r.unstoppable && <span className="badge good">unstoppable</span>}
              </div>
            ))}
          </div>
        )}
        {info.tips.length > 0 && <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{info.tips.map((t) => <li key={t}>{t}</li>)}</ul>}
      </Card>
      <Card title="Endgame training positions" actions={<button className="btn sm ghost" onClick={() => setTab('practice')}>Practise with scoring</button>}>
        {ENDGAME_DRILLS.map((d) => (
          <button key={d.id} className="list-row" onClick={() => loadFen(d.fen)} title={d.hint}>
            <span className="badge neutral">{'★'.repeat(d.level)}</span><span className="grow" style={{ textAlign: 'left' }}>{d.title}</span><span className="small muted">{d.side === 'w' ? 'White' : 'Black'} to {d.goal}</span>
          </button>
        ))}
        <div className="small muted" style={{ marginTop: 6 }}>Coverage: King + pawn vs king is exact. Other endgames use well-known theory and rules of thumb; MOTH does not include multi-gigabyte tablebases.</div>
      </Card>
    </div>
  );
}
