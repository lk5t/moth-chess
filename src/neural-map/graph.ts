// Neural Map graph model. Nodes are positions (shared across transpositions); edges are legal moves.
import type { NeuralEdge, NeuralNode, NeuralTree, WhiteScore } from '@/types';
import { applyMove, positionKey, validateFen } from '@/chess/position';

export const MAX_NODES = 400;
export const AUTO_EXPAND = { maxDepth: 3, branching: 3, maxNodes: 40 } as const;

export function createTree(fen: string, title = 'Neural Map'): NeuralTree {
  const v = validateFen(fen);
  if (!v.ok || !v.fen) throw new Error(v.error ?? 'Invalid FEN');
  const key = positionKey(v.fen);
  const now = Date.now();
  return { title, rootKey: key, nodes: { [key]: { key, fen: v.fen } }, edges: [], createdAt: now, updatedAt: now, tags: [] };
}

/** Add a move sequence starting at node `fromKey`. Returns keys of nodes along the line. Stops at the first illegal move. */
export function addLine(tree: NeuralTree, fromKey: string, uciMoves: string[], source: NeuralEdge['source'] = 'user'): { tree: NeuralTree; keys: string[]; added: number } {
  const t: NeuralTree = { ...tree, nodes: { ...tree.nodes }, edges: tree.edges.slice() };
  let cur = t.nodes[fromKey];
  if (!cur) throw new Error('Unknown start node');
  const keys: string[] = [];
  let added = 0;
  for (const u of uciMoves) {
    if (Object.keys(t.nodes).length >= MAX_NODES) break;
    const r = applyMove(cur.fen, u);
    if (!r) break;
    const k = positionKey(r.fenAfter);
    if (!t.nodes[k]) { t.nodes[k] = { key: k, fen: r.fenAfter }; added++; }
    if (!t.edges.some((e) => e.from === cur.key && e.uci === r.uci)) {
      t.edges.push({ id: `${cur.key}|${r.uci}`, from: cur.key, to: k, uci: r.uci, san: r.san, source });
    }
    keys.push(k);
    cur = t.nodes[k];
  }
  t.updatedAt = Date.now();
  return { tree: t, keys, added };
}

export function setNodeEval(tree: NeuralTree, key: string, evalW: WhiteScore, depth: number): NeuralTree {
  const n = tree.nodes[key];
  if (!n) return tree;
  if (n.depth && n.depth > depth) return tree;
  return { ...tree, nodes: { ...tree.nodes, [key]: { ...n, eval: evalW, depth } } };
}

export function toggleCollapse(tree: NeuralTree, key: string): NeuralTree {
  const n = tree.nodes[key];
  if (!n) return tree;
  return { ...tree, nodes: { ...tree.nodes, [key]: { ...n, collapsed: !n.collapsed } } };
}

export function childrenOf(tree: NeuralTree, key: string): NeuralEdge[] {
  return tree.edges.filter((e) => e.from === key);
}

/** Shortest move path from root to a node (BFS) — used to navigate the board to any node. */
export function pathTo(tree: NeuralTree, key: string): NeuralEdge[] {
  if (key === tree.rootKey) return [];
  const prev = new Map<string, NeuralEdge>();
  const q = [tree.rootKey];
  const seen = new Set(q);
  while (q.length) {
    const k = q.shift()!;
    for (const e of childrenOf(tree, k)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, e);
      if (e.to === key) {
        const path: NeuralEdge[] = [];
        let c: string = key;
        while (c !== tree.rootKey) { const pe = prev.get(c)!; path.unshift(pe); c = pe.from; }
        return path;
      }
      q.push(e.to);
    }
  }
  return [];
}

export interface LayoutNode { node: NeuralNode; x: number; y: number; depth: number; hiddenChildren: number; parentEdge?: NeuralEdge }
export interface LayoutEdge { edge: NeuralEdge; x1: number; y1: number; x2: number; y2: number; transposition: boolean }

/**
 * Tidy left-to-right tree layout. Transpositions (a node with several parents) are placed once, at their
 * first (shallowest) parent; additional parents are drawn as dashed transposition edges.
 */
export function layout(tree: NeuralTree, opts: { dx?: number; dy?: number } = {}): { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number } {
  const dx = opts.dx ?? 150, dy = opts.dy ?? 46;
  const placed = new Map<string, LayoutNode>();
  const treeParent = new Map<string, NeuralEdge>();
  // BFS to fix the spanning tree (shallowest parent wins)
  const order: string[] = [tree.rootKey];
  const depth = new Map<string, number>([[tree.rootKey, 0]]);
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    if (tree.nodes[k]?.collapsed) continue;
    for (const e of childrenOf(tree, k)) {
      if (depth.has(e.to)) continue;
      depth.set(e.to, depth.get(k)! + 1);
      treeParent.set(e.to, e);
      order.push(e.to);
    }
  }
  const kids = (k: string) => childrenOf(tree, k).filter((e) => treeParent.get(e.to) === e);
  let row = 0;
  const visit = (k: string, d: number): number => {
    const n = tree.nodes[k];
    const children = n.collapsed ? [] : kids(k);
    let y: number;
    if (!children.length) { y = row * dy; row++; }
    else {
      const ys = children.map((e) => visit(e.to, d + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    placed.set(k, { node: n, x: d * dx, y, depth: d, hiddenChildren: n.collapsed ? childrenOf(tree, k).length : 0, parentEdge: treeParent.get(k) });
    return y;
  };
  visit(tree.rootKey, 0);
  const edges: LayoutEdge[] = [];
  for (const e of tree.edges) {
    const a = placed.get(e.from), b = placed.get(e.to);
    if (!a || !b) continue;
    edges.push({ edge: e, x1: a.x, y1: a.y, x2: b.x, y2: b.y, transposition: treeParent.get(e.to) !== e });
  }
  const nodes = [...placed.values()];
  return { nodes, edges, width: Math.max(...nodes.map((n) => n.x)) + dx, height: Math.max(dy, row * dy) };
}

/** Evaluation change along an edge, from the mover's point of view (positive = improved for the mover). */
export function edgeSwing(tree: NeuralTree, e: NeuralEdge): number | null {
  const a = tree.nodes[e.from]?.eval, b = tree.nodes[e.to]?.eval;
  if (!a || !b) return null;
  const cp = (s: WhiteScore) => (s.type === 'cp' ? s.value : s.value === 0 ? (s.winner === 'w' ? 10000 : -10000) : Math.sign(s.value) * 10000);
  const mover = tree.nodes[e.from].fen.split(' ')[1];
  const d = cp(b) - cp(a);
  return mover === 'w' ? d : -d;
}
