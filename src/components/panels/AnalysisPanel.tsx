import { useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, EngineStatusBadge, Slider, Toggle, Tip } from '../ui';
import { EvalBar } from '../charts';
import { describeScore, formatScore } from '@/engine/normalize';
import { explainPosition } from '@/intelligence/explain';
import { ARROW_COLORS } from '@/content/arrows/geometry';
import { gameStatus } from '@/chess/position';
import { savePosition } from '@/memory/repo';

export function AnalysisPanel() {
  const { fen, analysis, settings, updateSettings, play, surface, toast } = useApp();
  const r = analysis.result;
  const top = r?.lines[0];
  const turn = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  const [explain, setExplain] = useState(surface === 'board');
  const status = useMemo(() => gameStatus(fen), [fen]);
  const intel = useMemo(() => {
    if (!explain || !r || !r.lines.length) return null;
    try { return explainPosition(fen, r, { detail: 'brief' }); } catch { return null; }
  }, [explain, fen, r]);

  return (
    <div className="stack">
      <Card glow title={<span className="row">Evaluation <EngineStatusBadge status={analysis.status} detail={analysis.statusDetail} /></span>}>
        <div className="row" style={{ alignItems: 'stretch', gap: 12 }}>
          {settings.visual.evalBar && <EvalBar score={top?.whiteScore} height={64} />}
          <div className="grow stack" style={{ gap: 4 }}>
            <div className="row">
              <span className="mono" style={{ fontSize: 26, fontWeight: 800 }} aria-live="polite">{status.over ? (status.checkmate ? '#' : '½') : formatScore(top?.whiteScore)}</span>
              <span className="badge neutral" title="All scores are shown from White's perspective">White's view</span>
            </div>
            <div className="muted small">
              {status.over ? (status.checkmate ? `Checkmate — ${status.winner === 'w' ? 'White' : 'Black'} wins` : `Draw (${status.reason?.replace(/-/g, ' ')})`)
                : top ? `${describeScore(top.whiteScore)} · depth ${r!.depth}${r!.complete ? '' : '…'}${r!.fromCache ? ' · cached' : ''}` : analysis.running ? 'Thinking…' : 'Analysis paused'}
            </div>
            <div className="row small"><span className={`dot ${fen.split(' ')[1] === 'w' ? 'ready' : ''}`} style={{ background: fen.split(' ')[1] === 'w' ? '#fff' : '#111', boxShadow: 'none', border: '1px solid var(--line-strong)' }} />{turn} to move</div>
          </div>
        </div>
      </Card>

      <Card title="Engine suggestions" actions={<Toggle checked={explain} onChange={setExplain} label={<span className="small muted">Explain</span>} />}>
        {analysis.status === 'error' && (
          <div className="banner bad" role="alert">
            {analysis.statusDetail ?? 'The engine failed to start.'}
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              <button className="btn sm" onClick={analysis.retry}>Restart engine</button>
              <button className="btn sm ghost" onClick={() => updateSettings({ engine: { kind: settings.engine.kind === 'moth' ? 'stockfish' : 'moth' } })}>Switch to {settings.engine.kind === 'moth' ? 'Stockfish' : 'MOTH Engine'}</button>
            </div>
          </div>
        )}
        {analysis.warnings.length > 0 && analysis.status !== 'error' && <div className="banner warn small">{analysis.warnings[0]}</div>}
        {!r?.lines.length && !status.over && <div className="empty">{analysis.running ? 'Waiting for the first engine result…' : 'Press Start to analyse this position.'}</div>}
        {status.over && <div className="empty">Game over — no moves to suggest.</div>}
        {r?.lines.map((l, i) => {
          const cand = intel?.candidates.find((c) => c.uci === l.pv[0]);
          return (
            <div key={l.multipv} className="line" style={{ borderLeftColor: ARROW_COLORS[i] }} role="button" tabIndex={0}
              title="Click to play the first move on the board" onClick={() => l.pv[0] && play(l.pv[0])} onKeyDown={(e) => e.key === 'Enter' && l.pv[0] && play(l.pv[0])}>
              <span className="score">{formatScore(l.whiteScore)}</span>
              <div>
                <div className="pv"><b>{l.pvSan[0]}</b> {surface === 'overlay' && !settings.hud.showPv ? '' : l.pvSan.slice(1, 10).join(' ')}</div>
                {cand && cand.reasons[0] && <div className="small muted" style={{ marginTop: 2 }}>{cand.reasons.slice(0, 2).map((x) => x.text).join(' ')}</div>}
                <div className="small muted">d{l.depth}{l.bound ? ` (${l.bound} bound)` : ''}{l.nps ? ` · ${(l.nps / 1000).toFixed(0)} kN/s` : ''}</div>
              </div>
            </div>
          );
        })}
      </Card>

      <Card title="Analysis controls">
        <div className="row wrap" style={{ marginBottom: 8 }}>
          {analysis.running
            ? <button className="btn" onClick={analysis.stop}>■ Stop</button>
            : <button className="btn primary" onClick={analysis.start}>▶ Start</button>}
          <button className="btn" onClick={analysis.reanalyse} title="Clear cached results and analyse again">↻ Reanalyse</button>
          {surface === 'board' && <button className="btn ghost" onClick={async () => { const s = await savePosition(fen, { lastEval: top?.whiteScore }); toast(s.duplicate ? 'Position already in Memory' : 'Position saved to Memory'); }}>☆ Save position</button>}
          <span className="grow" />
          <Tip tip={`${analysis.engineName}, local WASM. No server involved.`}><span className="badge neutral" data-testid="engine-name">{analysis.engineName} · local</span></Tip>
        </div>
        <div className="row small" style={{ gap: 6, marginBottom: 6 }}>
          <label className="row" style={{ gap: 4 }}><span className="muted">Engine</span>
            <select className="input sm" aria-label="Analysis engine" value={settings.engine.kind} onChange={(e) => updateSettings({ engine: { kind: e.target.value as 'moth' | 'stockfish' } })}>
              <option value="moth">MOTH Engine</option><option value="stockfish">Stockfish</option>
            </select>
          </label>
          {settings.engine.kind === 'moth' && (
            <label className="row" style={{ gap: 4 }}><span className="muted">Style</span>
              <select className="input sm" aria-label="MOTH style" value={settings.moth.style} onChange={(e) => updateSettings({ moth: { style: e.target.value as 'aggressive' | 'balanced' | 'defensive' } })}>
                <option value="aggressive">Aggressive</option><option value="balanced">Balanced</option><option value="defensive">Defensive</option>
              </select>
            </label>
          )}
        </div>
        <Slider label="Depth" value={settings.engine.depth} min={1} max={30} onChange={(v) => updateSettings({ engine: { depth: v } })} />
        <Slider label="Lines (MultiPV)" value={settings.engine.multiPv} min={1} max={5} onChange={(v) => updateSettings({ engine: { multiPv: v } })} />
        <Toggle label="Move arrows" checked={settings.visual.arrows} onChange={(v) => updateSettings({ visual: { arrows: v } })} />
      </Card>
    </div>
  );
}
