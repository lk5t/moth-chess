import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty } from '../ui';
import { Board } from '../Board';
import { createSim, currentFen, diffSquares, simMove, simReset, simStep, simToPgn, simUci, type SimState } from '@/simulator/simulator';
import { queuedEvaluate } from '@/engine/queue';
import { formatScore, toCp } from '@/engine/normalize';
import { addLine, createTree } from '@/neural-map/graph';
import { positionKey } from '@/chess/position';
import { downloadText, saveSimulation } from '@/memory/repo';
import { db } from '@/memory/db';
import type { Simulation, WhiteScore } from '@/types';

export function WhatIfPanel() {
  const { fen, orientation, setTree, tree, toast, setTab } = useApp();
  const [sim, setSim] = useState<SimState>(() => createSim(fen));
  const [evals, setEvals] = useState<{ before?: WhiteScore; beforeFen?: string; after?: WhiteScore; afterFen?: string }>({});
  const [saved, setSaved] = useState<Simulation[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const simFen = currentFen(sim);
  const diff = useMemo(() => diffSquares(sim.baseFen, simFen), [sim.baseFen, simFen]);

  useEffect(() => { db().simulations.orderBy('createdAt').reverse().limit(15).toArray().then(setSaved).catch(() => {}); }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    (async () => {
      try {
        const b = evals.beforeFen === sim.baseFen && evals.before ? evals.before : (await queuedEvaluate(sim.baseFen, 14, 1, ac.signal)).lines[0]?.whiteScore;
        if (ac.signal.aborted) return;
        setEvals((e) => ({ ...e, before: b, beforeFen: sim.baseFen }));
        if (simFen === sim.baseFen) { setEvals({ before: b, beforeFen: sim.baseFen, after: b, afterFen: simFen }); return; }
        const a = (await queuedEvaluate(simFen, 14, 1, ac.signal)).lines[0]?.whiteScore;
        if (!ac.signal.aborted) setEvals({ before: b, beforeFen: sim.baseFen, after: a, afterFen: simFen });
      } catch { /* aborted */ }
    })();
    return () => ac.abort();
  }, [simFen, sim.baseFen]);

  const swing = evals.before && evals.after && evals.afterFen === simFen ? toCp(evals.after) - toCp(evals.before) : null;

  const sendToMap = () => {
    const uci = simUci(sim);
    if (!uci.length) { toast('Play some moves in the sandbox first'); return; }
    let t = tree;
    if (!t || !t.nodes[positionKey(sim.baseFen)]) t = createTree(sim.baseFen, 'What-If map');
    t = addLine(t, positionKey(sim.baseFen), uci, 'whatif').tree;
    setTree(t);
    toast('Variation sent to Neural Map');
    setTab('neural');
  };

  return (
    <div className="stack">
      <Card glow title="What-If Simulator" actions={<span className="muted small">sandbox — the source position is never modified</span>}>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <button className="btn sm" onClick={() => { setSim(createSim(fen)); setEvals({}); }} title="Clone the board's current position into the sandbox">⟲ Clone current position</button>
          <button className="btn sm" onClick={() => setSim(simReset(sim))}>Reset</button>
          <button className="btn sm icon" onClick={() => setSim(simStep(sim, -1))} disabled={sim.cursor === 0} aria-label="Step back">‹</button>
          <button className="btn sm icon" onClick={() => setSim(simStep(sim, 1))} disabled={sim.cursor >= sim.moves.length} aria-label="Step forward">›</button>
          <span className="grow" />
          <button className="btn sm" onClick={sendToMap}>→ Neural Map</button>
          <button className="btn sm" onClick={async () => { await saveSimulation({ title: `What-If ${new Date().toLocaleString()}`, baseFen: sim.baseFen, moves: simUci(sim), san: sim.moves.slice(0, sim.cursor).map((m) => m.san), evalBefore: evals.before, evalAfter: evals.after }); toast('Simulation saved'); setSaved(await db().simulations.orderBy('createdAt').reverse().limit(15).toArray()); }}>Save</button>
          <button className="btn sm" onClick={() => downloadText('moth-whatif.pgn', simToPgn(sim), 'application/x-chess-pgn')}>Export PGN</button>
        </div>
        <div className="grid-2">
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>Original · {formatScore(evals.before)}</div>
            <Board fen={sim.baseFen} orientation={orientation} interactive={false} coordinates={false} ariaLabel="Original position (read only)" />
          </div>
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>Sandbox · {evals.afterFen === simFen ? formatScore(evals.after) : '…'}</div>
            <Board fen={simFen} orientation={orientation} coordinates={false} onMove={(u) => { const n = simMove(sim, u); if (n) setSim(n); return !!n; }}
              highlights={diff.map((s) => ({ square: s, color: '#8b7bff', opacity: 0.3, label: 'changed' }))}
              lastMove={sim.cursor ? [sim.moves[sim.cursor - 1].from, sim.moves[sim.cursor - 1].to] : undefined} ariaLabel="Sandbox board" />
          </div>
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <span className="mono small grow">{sim.moves.slice(0, sim.cursor).map((m) => m.san).join(' ') || 'Play moves for either side on the sandbox board.'}</span>
          {swing !== null && sim.cursor > 0 && <span className={`badge ${swing > 30 ? 'good' : swing < -30 ? 'bad' : 'neutral'}`} title="Change in Stockfish evaluation, White's perspective, depth 14">Δ {swing > 0 ? '+' : ''}{(swing / 100).toFixed(2)}</span>}
        </div>
        {diff.length > 0 && <div className="small muted">Changed squares: {diff.join(', ')}</div>}
      </Card>
      <Card title="Saved simulations">
        {!saved.length && <Empty>No simulations saved yet.</Empty>}
        <div className="list">
          {saved.map((s) => (
            <div key={s.id} className="list-item" role="button" tabIndex={0} onClick={() => { let st = createSim(s.baseFen); for (const u of s.moves) { const n = simMove(st, u); if (n) st = n; } setSim(st); }}>
              <span className="grow mono small">{s.san.join(' ') || '(no moves)'}</span><span className="muted small">{formatScore(s.evalBefore)} → {formatScore(s.evalAfter)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
