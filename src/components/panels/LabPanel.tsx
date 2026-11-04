// Engine Lab → Benchmarks (3.0, advanced). MOTH vs Stockfish on a puzzle suite, MOTH-vs-MOTH self-play
// matches with configurable sides, and a local history of results that can be exported. All local.
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty } from '../ui';
import { extUrl } from '../shared';
import { getBatchEngine } from '@/engine/worker-transport';
import { kvGet, kvSet } from '@/storage/kv';
import { downloadText, importPgnText } from '@/memory/repo';
import type { MatchResult } from '@/moth-engine/model';

const HIST_KEY = 'moth.lab.history.v1';
interface HistEntry { at: number; kind: 'suite' | 'match'; label: string; detail: Record<string, unknown> }
type Style = 'aggressive' | 'balanced' | 'defensive';
interface Side { name: string; style: Style; model: 'builtin' | 'classical'; limit: 'nodes' | 'ms'; value: number }

async function addHistory(e: HistEntry) { const h = ((await kvGet<HistEntry[]>(HIST_KEY)) ?? []); h.unshift(e); await kvSet(HIST_KEY, h.slice(0, 100)); }

export function LabPanel() {
  const { toast } = useApp();
  const [history, setHistory] = useState<HistEntry[]>([]);
  const reload = () => kvGet<HistEntry[]>(HIST_KEY).then((h) => setHistory(h ?? []));
  useEffect(() => { void reload(); }, []);
  return (
    <div className="stack" style={{ maxWidth: 1000 }}>
      <div className="banner small">Advanced tools for engine development. They run in the background of this tab and use a full CPU core while active.</div>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Compare onDone={async (e) => { await addHistory(e); void reload(); }} />
        <SelfPlay onDone={async (e) => { await addHistory(e); void reload(); }} toast={toast} />
      </div>
      <Card title={`Results history (${history.length})`} actions={history.length ? <button className="btn sm" onClick={() => downloadText(`moth-lab-results-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(history, null, 1))}>Export JSON</button> : undefined}>
        {!history.length && <Empty>Run a comparison or a match to start a history.</Empty>}
        <table className="t"><tbody>{history.slice(0, 20).map((h, i) => (
          <tr key={i}><td className="small muted">{new Date(h.at).toLocaleString()}</td><td><span className="badge neutral">{h.kind}</span></td><td className="small">{h.label}</td></tr>
        ))}</tbody></table>
      </Card>
    </div>
  );
}

function Compare({ onDone }: { onDone: (e: HistEntry) => void }) {
  const [n, setN] = useState(30);
  const [ms, setMs] = useState(100);
  const [running, setRunning] = useState(false);
  const [res, setRes] = useState<{ moth?: { solved: number; total: number; nps: number; avgDepth: number }; sf?: { solved: number; total: number; nps: number; avgDepth: number }; progress: string } | null>(null);
  const worker = useRef<Worker | null>(null);
  const run = async () => {
    setRunning(true); setRes({ progress: 'Loading puzzles…' });
    const data = await (await fetch(extUrl('moth-engine/tactics.json'))).json() as { puzzles: { fen: string; solution: string }[] };
    const step = Math.max(1, Math.floor(data.puzzles.length / n));
    const positions = data.puzzles.filter((_, i) => i % step === 0).slice(0, n).map((p) => ({ fen: p.fen, best: [p.solution] }));
    // MOTH in the lab worker
    const moth = await new Promise<{ solved: number; total: number; nps: number; avgDepth: number }>((resolve, reject) => {
      const w = new Worker(extUrl('moth-lab-worker.js')); worker.current = w;
      w.onmessage = (e) => {
        if (e.data.type === 'suite-progress') setRes((r) => ({ ...r, progress: `MOTH: ${e.data.done}/${e.data.total} (${e.data.solved} solved)` }));
        if (e.data.type === 'suite-done') { w.terminate(); resolve(e.data); }
        if (e.data.type === 'error') { w.terminate(); reject(new Error(e.data.msg)); }
      };
      w.postMessage({ type: 'suite', params: { positions, movetimeMs: ms, style: 'balanced', model: 'builtin' } });
    }).catch((e) => { setRes({ progress: `MOTH failed: ${(e as Error).message}` }); return undefined; });
    if (!moth) { setRunning(false); return; }
    setRes({ moth, progress: 'Stockfish…' });
    // Stockfish through the regular UCI controller (fresh batch engine)
    const sfEng = getBatchEngine('stockfish');
    let solved = 0, nodes = 0, t = 0, depth = 0;
    for (let i = 0; i < positions.length; i++) {
      sfEng.clearCache();
      const r = await sfEng.analyse(positions[i].fen, { depth: 99, multiPv: 1, moveTimeMs: ms }).result;
      if (r.bestMove && positions[i].best.includes(r.bestMove)) solved++;
      const l = r.lines[0]; nodes += l?.nodes ?? 0; t += l?.timeMs ?? ms; depth += r.depth;
      if (i % 5 === 0) setRes({ moth, progress: `Stockfish: ${i + 1}/${positions.length} (${solved} solved)` });
    }
    const sf = { solved, total: positions.length, nps: t ? Math.round((nodes / t) * 1000) : 0, avgDepth: depth / positions.length };
    setRes({ moth, sf, progress: 'Done' });
    setRunning(false);
    onDone({ at: Date.now(), kind: 'suite', label: `${positions.length} puzzles @ ${ms} ms — MOTH ${moth.solved}, Stockfish ${sf.solved}`, detail: { ms, moth, sf } });
  };
  const row = (name: string, r?: { solved: number; total: number; nps: number; avgDepth: number }) => r && (
    <tr><td><b>{name}</b></td><td className="mono">{r.solved}/{r.total}</td><td className="mono">{(r.nps / 1000).toFixed(0)} kN/s</td><td className="mono">{r.avgDepth.toFixed(1)}</td></tr>
  );
  return (
    <Card title="MOTH vs Stockfish">
      <div className="small muted" style={{ marginBottom: 6 }}>Same positions, same time per move: puzzles solved, search speed (nodes per second) and average depth.</div>
      <div className="row wrap small">
        <label className="row">Positions <input className="input sm" type="number" min={5} max={235} value={n} onChange={(e) => setN(Number(e.target.value))} style={{ width: 70 }} /></label>
        <label className="row">Time <input className="input sm" type="number" min={20} max={2000} value={ms} onChange={(e) => setMs(Number(e.target.value))} style={{ width: 70 }} /> ms</label>
        <button className="btn sm primary" disabled={running} onClick={() => void run()}>{running ? 'Running…' : 'Run comparison'}</button>
        {running && <button className="btn sm" onClick={() => { worker.current?.terminate(); setRunning(false); }}>Stop</button>}
      </div>
      {res && <div className="small muted" style={{ marginTop: 6 }} aria-live="polite">{res.progress}</div>}
      {(res?.moth || res?.sf) && <table className="t" style={{ marginTop: 6 }}><thead><tr><th>Engine</th><th>Solved</th><th>Speed</th><th>Depth</th></tr></thead><tbody>{row('MOTH Engine', res.moth)}{row('Stockfish 17.1', res.sf)}</tbody></table>}
    </Card>
  );
}

function SelfPlay({ onDone, toast }: { onDone: (e: HistEntry) => void; toast: (m: string) => void }) {
  const [a, setA] = useState<Side>({ name: 'MOTH A', style: 'balanced', model: 'builtin', limit: 'nodes', value: 20000 });
  const [b, setB] = useState<Side>({ name: 'MOTH B', style: 'aggressive', model: 'builtin', limit: 'nodes', value: 20000 });
  const [openings, setOpenings] = useState(10);
  const [state, setState] = useState<{ running: boolean; done: number; total: number; stats?: MatchResult; pgns: string[]; last?: string }>({ running: false, done: 0, total: 0, pgns: [] });
  const w = useRef<Worker | null>(null);
  const start = (resume = false) => {
    const startAt = resume ? state.done : 0;
    const wk = new Worker(extUrl('moth-lab-worker.js')); w.current = wk;
    setState((s) => ({ running: true, done: startAt, total: openings * 2, stats: resume ? s.stats : undefined, pgns: resume ? s.pgns : [] }));
    const side = (x: Side) => ({ name: x.name, style: x.style, model: x.model, ...(x.limit === 'nodes' ? { nodes: x.value } : { movetimeMs: x.value }) });
    wk.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'game') setState((s) => ({ ...s, done: m.index, total: m.total, stats: m.stats, pgns: [...s.pgns, m.pgn], last: `${m.result} (${m.reason})` }));
      if (m.type === 'done' || m.type === 'stopped') {
        wk.terminate();
        setState((s) => ({ ...s, running: false }));
        if (m.type === 'done') onDone({ at: Date.now(), kind: 'match', label: `${a.name} (${a.style}, ${a.model}) vs ${b.name} (${b.style}, ${b.model}): ${m.stats.wins}-${m.stats.draws}-${m.stats.losses} for B, ${m.stats.elo > 0 ? '+' : ''}${m.stats.elo} ± ${m.stats.eloError} Elo`, detail: { a, b, stats: m.stats } });
      }
      if (m.type === 'error') { wk.terminate(); setState((s) => ({ ...s, running: false, last: `Error: ${m.msg}` })); }
    };
    wk.postMessage({ type: 'match', params: { a: side(a), b: side(b), openings, seed: 11, startAt } });
  };
  const sideForm = (x: Side, set: (s: Side) => void, label: string) => (
    <div className="stack" style={{ gap: 4 }}>
      <b className="small">{label}</b>
      <select className="input sm" aria-label={`${label} style`} value={x.style} onChange={(e) => set({ ...x, style: e.target.value as Style })}><option value="aggressive">Aggressive</option><option value="balanced">Balanced</option><option value="defensive">Defensive</option></select>
      <select className="input sm" aria-label={`${label} evaluation`} value={x.model} onChange={(e) => set({ ...x, model: e.target.value as Side['model'] })}><option value="builtin">Network + classical</option><option value="classical">Classical only</option></select>
      <div className="row"><select className="input sm" aria-label={`${label} limit`} value={x.limit} onChange={(e) => set({ ...x, limit: e.target.value as Side['limit'] })}><option value="nodes">nodes</option><option value="ms">ms</option></select>
        <input className="input sm" type="number" aria-label={`${label} limit value`} value={x.value} onChange={(e) => set({ ...x, value: Number(e.target.value) })} style={{ width: 90 }} /></div>
    </div>
  );
  const st = state.stats;
  return (
    <Card title="Self-play match">
      <div className="small muted" style={{ marginBottom: 6 }}>MOTH vs MOTH from book openings, each opening with both colours. Results are from B's point of view.</div>
      <div className="grid-2">{sideForm(a, setA, 'Side A')}{sideForm(b, setB, 'Side B')}</div>
      <div className="row wrap small" style={{ marginTop: 8 }}>
        <label className="row">Openings <input className="input sm" type="number" min={1} max={200} value={openings} onChange={(e) => setOpenings(Number(e.target.value))} style={{ width: 70 }} /></label>
        {!state.running && <button className="btn sm primary" onClick={() => start(false)}>Start</button>}
        {!state.running && state.done > 0 && state.done < state.total && <button className="btn sm" onClick={() => start(true)}>Resume</button>}
        {state.running && <button className="btn sm" onClick={() => w.current?.postMessage({ type: 'stop' })}>Stop</button>}
      </div>
      {(state.running || st) && (
        <div className="small" style={{ marginTop: 8 }} aria-live="polite">
          Game {state.done}/{state.total}{state.last ? ` · last: ${state.last}` : ''}
          {st && <div>B: <b>{st.wins}</b> wins, <b>{st.draws}</b> draws, <b>{st.losses}</b> losses · {st.elo > 0 ? '+' : ''}{st.elo} ± {st.eloError} Elo · LOS {(st.los * 100).toFixed(0)}%{st.games < 100 ? ' (few games — wide error bar)' : ''}</div>}
        </div>
      )}
      {state.pgns.length > 0 && !state.running && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => downloadText(`moth-selfplay-${Date.now()}.pgn`, state.pgns.join('\n\n'), 'application/x-chess-pgn')}>Download PGN</button>
          <button className="btn sm" onClick={async () => { const r = await importPgnText(state.pgns.join('\n\n'), { tags: ['self-play'] }); toast(`${r.added.length} games saved to the Library (tag “self-play”) — usable as Learning Lab training data`); }}>Save to Library</button>
        </div>
      )}
    </Card>
  );
}
