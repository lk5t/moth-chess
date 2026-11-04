import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty } from '../ui';
import { AUTO_EXPAND, addLine, createTree, edgeSwing, layout, pathTo, setNodeEval, toggleCollapse } from '@/neural-map/graph';
import { positionKey } from '@/chess/position';
import { formatScore } from '@/engine/normalize';
import { queuedEvaluate } from '@/engine/queue';
import { db } from '@/memory/db';
import { saveTree } from '@/memory/repo';
import type { NeuralTree } from '@/types';

const NODE_W = 112, NODE_H = 30;

export function NeuralMapPanel({ compact }: { compact?: boolean }) {
  const { tree, setTree, fen, rootFen, moves, cursor, loadLine, toast, settings } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [view, setView] = useState({ x: 20, y: 20, k: 1 });
  const [saved, setSaved] = useState<NeuralTree[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const curKey = positionKey(fen);

  useEffect(() => { if (!compact) db().trees.orderBy('updatedAt').reverse().limit(20).toArray().then(setSaved).catch(() => {}); }, [compact, busy]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const lay = useMemo(() => (tree ? layout(tree) : null), [tree]);
  const selPath = useMemo(() => new Set(tree ? pathTo(tree, curKey).map((e) => e.id) : []), [tree, curKey]);

  const startFromCurrent = () => setTree(createTree(fen, `Map from move ${Math.ceil(cursor / 2) || 'start'}`));
  const addCurrentLine = () => {
    if (!tree) return;
    let t = tree;
    if (t.rootKey === positionKey(rootFen)) t = addLine(t, t.rootKey, moves.slice(0, cursor).map((m) => m.uci), 'user').tree;
    else if (t.nodes[curKey]) { toast('Current position is already in the map'); return; }
    else { toast('Current line does not start from this map’s root — start a new map here'); return; }
    setTree(t);
  };

  const grow = async (fromKey: string) => {
    if (!tree) return;
    const ac = new AbortController();
    abortRef.current = ac;
    let t = tree;
    let addedTotal = 0;
    const frontier: { key: string; d: number }[] = [{ key: fromKey, d: 0 }];
    try {
      while (frontier.length && addedTotal < AUTO_EXPAND.maxNodes && !ac.signal.aborted) {
        const { key, d } = frontier.shift()!;
        const node = t.nodes[key];
        setBusy(`Expanding ${node.fen.split(' ')[0].slice(0, 12)}… (${addedTotal}/${AUTO_EXPAND.maxNodes} nodes)`);
        const r = await queuedEvaluate(node.fen, 12, AUTO_EXPAND.branching, ac.signal);
        if (r.lines[0]) t = setNodeEval(t, key, r.lines[0].whiteScore, r.lines[0].depth);
        for (const l of r.lines) {
          if (!l.pv[0]) continue;
          const res = addLine(t, key, [l.pv[0]], 'engine');
          t = res.tree;
          addedTotal += res.added;
          const child = res.keys[0];
          if (child && l.pv.length > 1) {
            // child eval from the parent's line is the same score one ply deeper — store it at reduced depth
            t = setNodeEval(t, child, l.whiteScore, Math.max(1, l.depth - 1));
          }
          if (child && d + 1 < AUTO_EXPAND.maxDepth) frontier.push({ key: child, d: d + 1 });
        }
        setTree(t);
      }
      toast(ac.signal.aborted ? 'Expansion stopped' : `Added ${addedTotal} positions`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(`Expansion failed: ${(e as Error).message}`);
    } finally { setBusy(null); abortRef.current = null; }
  };

  const evalMissing = async () => {
    if (!tree) return;
    const ac = new AbortController(); abortRef.current = ac;
    let t = tree;
    const missing = Object.values(t.nodes).filter((n) => !n.eval).slice(0, 60);
    try {
      for (let i = 0; i < missing.length && !ac.signal.aborted; i++) {
        setBusy(`Evaluating ${i + 1}/${missing.length}`);
        const r = await queuedEvaluate(missing[i].fen, 12, 1, ac.signal);
        if (r.lines[0]) { t = setNodeEval(t, missing[i].key, r.lines[0].whiteScore, r.lines[0].depth); setTree(t); }
      }
    } catch { /* aborted */ } finally { setBusy(null); abortRef.current = null; }
  };

  const navigate = (key: string) => {
    if (!tree) return;
    const path = pathTo(tree, key);
    loadLine(tree.nodes[tree.rootKey].fen, path.map((e) => e.uci));
  };

  // pan & zoom
  const panRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const onWheel = (e: React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.min(2.5, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    setView({ k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k });
  };

  const swingColor = (s: number | null) => (s === null ? undefined : s <= -150 ? 'var(--bad)' : s <= -60 ? 'var(--warn)' : s >= 60 ? 'var(--good)' : undefined);

  return (
    <div className="stack">
      <Card glow title="MOTH Neural Map" actions={tree && <span className="muted small">{Object.keys(tree.nodes).length} positions · {tree.edges.length} moves</span>}>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <button className="btn sm primary" onClick={startFromCurrent} disabled={!!busy}>New map here</button>
          <button className="btn sm" onClick={addCurrentLine} disabled={!tree || !!busy}>Add current line</button>
          <button className="btn sm" onClick={() => tree && grow(tree.nodes[curKey] ? curKey : tree.rootKey)} disabled={!tree || !!busy} title={`Engine expands up to ${AUTO_EXPAND.maxNodes} positions, ${AUTO_EXPAND.branching} moves per node, ${AUTO_EXPAND.maxDepth} plies deep`}>✦ Grow from engine</button>
          <button className="btn sm" onClick={evalMissing} disabled={!tree || !!busy}>Evaluate nodes</button>
          {busy && <button className="btn sm danger" onClick={() => abortRef.current?.abort()}>Stop</button>}
          <span className="grow" />
          <button className="btn sm icon" onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.2) }))} aria-label="Zoom in">+</button>
          <button className="btn sm icon" onClick={() => setView((v) => ({ ...v, k: Math.max(0.3, v.k / 1.2) }))} aria-label="Zoom out">−</button>
          <button className="btn sm" onClick={() => setView({ x: 20, y: 20, k: 1 })}>Fit</button>
        </div>
        {busy && <div className="small muted" style={{ marginBottom: 6 }} aria-live="polite">{busy}</div>}
        {!tree || !lay ? (
          <Empty>Start a map from the current position, then add lines or let the engine grow the most promising branches.</Empty>
        ) : (
          <svg ref={svgRef} className={`nmap ${panRef.current ? 'dragging' : ''}`} style={{ height: compact ? 260 : 440 }} onWheel={onWheel}
            onPointerDown={(e) => { if ((e.target as Element).closest('.node')) return; panRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }; (e.target as Element).setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { const p = panRef.current; if (p) setView((v) => ({ ...v, x: p.x + e.clientX - p.px, y: p.y + e.clientY - p.py })); }}
            onPointerUp={() => (panRef.current = null)} role="tree" aria-label="Variation graph">
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {lay.edges.map((e) => {
                const on = selPath.has(e.edge.id);
                const sw = edgeSwing(tree, e.edge);
                const x1 = e.x1 + NODE_W, y1 = e.y1 + NODE_H / 2, x2 = e.x2, y2 = e.y2 + NODE_H / 2;
                const mx = (x1 + x2) / 2;
                return <path key={e.edge.id} className={`edge ${on ? 'on' : ''} ${e.transposition ? 'trans' : ''} ${on && settings.appearance.animation > 0 ? 'flow' : ''}`}
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} style={swingColor(sw) && !on ? { stroke: swingColor(sw) } : undefined}><title>{`${e.edge.san}${sw !== null ? ` (swing ${(sw / 100).toFixed(2)} for the mover)` : ''}${e.transposition ? ' — transposition' : ''}`}</title></path>;
              })}
              {lay.nodes.map((n) => {
                const sel = n.node.key === curKey;
                const label = n.parentEdge?.san ?? 'start';
                const moveNo = n.node.fen.split(' ');
                const prefix = n.parentEdge ? (moveNo[1] === 'b' ? `${moveNo[5]}.` : `${Number(moveNo[5]) - 1}…`) : '';
                return (
                  <g key={n.node.key} className={`node ${sel ? 'sel' : ''}`} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }}
                    onClick={() => navigate(n.node.key)} onDoubleClick={() => setTree(toggleCollapse(tree, n.node.key))} role="treeitem" aria-selected={sel} tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(n.node.key)}>
                    <rect width={NODE_W} height={NODE_H} rx={8} />
                    <text x={8} y={19}>{prefix}{label}</text>
                    <text x={NODE_W - 8} y={19} textAnchor="end" className="ev" fill={n.node.eval ? (n.node.eval.value >= 0 ? 'var(--text)' : 'var(--muted)') : 'var(--muted)'}>{n.node.eval ? formatScore(n.node.eval) : '·'}</text>
                    {n.hiddenChildren > 0 && <text x={NODE_W + 4} y={19} fill="var(--accent)">+{n.hiddenChildren}</text>}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        <p className="muted small" style={{ margin: '6px 0 0' }}>Click a node to load it on the board · double-click to collapse · drag to pan · scroll to zoom. Dashed edges are transpositions (same position via another move order). Edge colours show evaluation swings for the side that moved.</p>
      </Card>
      {!compact && (
        <Card title="Saved maps" actions={tree && <button className="btn sm" onClick={async () => { const id = await saveTree({ ...tree }); setTree({ ...tree, id }); toast('Map saved'); setBusy(null); }}>Save current</button>}>
          {tree && <input className="input" style={{ marginBottom: 8 }} value={tree.title} onChange={(e) => setTree({ ...tree, title: e.target.value })} aria-label="Map title" />}
          {!saved.length && <Empty>No saved maps yet.</Empty>}
          <div className="list">
            {saved.map((s) => (
              <div key={s.id} className={`list-item ${tree?.id === s.id ? 'active' : ''}`} onClick={() => setTree(s)} role="button" tabIndex={0}>
                <span className="grow">{s.title}</span><span className="muted small">{Object.keys(s.nodes).length} nodes · {new Date(s.updatedAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
