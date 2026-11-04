// Neural Map, What-If Simulator and opening database.
import { describe, it, expect } from 'vitest';
import { addLine, createTree, layout, pathTo, setNodeEval, toggleCollapse, childrenOf, edgeSwing } from '@/neural-map/graph';
import { createSim, currentFen, diffSquares, simMove, simReset, simStep, simToPgn, simUci } from '@/simulator/simulator';
import { OPENINGS, continuations, openingIndex, recogniseOpening, lookupPosition, searchOpenings } from '@/openings/eco';
import { START_FEN, applyMove, parsePgn, positionKey } from '@/chess/position';

const line = (uci: string[]) => { const fens = [START_FEN]; for (const u of uci) fens.push(applyMove(fens[fens.length - 1], u)!.fenAfter); return fens; };

describe('Neural Map', () => {
  it('builds a branching graph from lines', () => {
    let t = createTree(START_FEN);
    t = addLine(t, t.rootKey, ['e2e4', 'e7e5', 'g1f3']).tree;
    t = addLine(t, t.rootKey, ['e2e4', 'c7c5']).tree;
    expect(Object.keys(t.nodes)).toHaveLength(5);
    expect(childrenOf(t, positionKey(line(['e2e4'])[1]))).toHaveLength(2);
  });
  it('shares nodes for transpositions while keeping both move histories', () => {
    let t = createTree(START_FEN);
    t = addLine(t, t.rootKey, ['g1f3', 'd7d5', 'd2d4']).tree;
    t = addLine(t, t.rootKey, ['d2d4', 'd7d5', 'g1f3']).tree;
    const target = positionKey(line(['d2d4', 'd7d5', 'g1f3'])[3]);
    expect(t.edges.filter((e) => e.to === target)).toHaveLength(2);
    expect(Object.keys(t.nodes)).toHaveLength(6); // root, Nf3, Nf3 d5, d4, d4 d5, shared
    const lay = layout(t);
    expect(lay.nodes.filter((n) => n.node.key === target)).toHaveLength(1);
    expect(lay.edges.filter((e) => e.transposition)).toHaveLength(1);
  });
  it('navigates to any node via the shortest path', () => {
    let t = createTree(START_FEN);
    t = addLine(t, t.rootKey, ['e2e4', 'e7e5', 'g1f3', 'b8c6']).tree;
    const k = positionKey(line(['e2e4', 'e7e5', 'g1f3', 'b8c6'])[4]);
    expect(pathTo(t, k).map((e) => e.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(pathTo(t, t.rootKey)).toEqual([]);
  });
  it('stops at illegal moves, collapses branches and keeps the deepest eval', () => {
    let t = createTree(START_FEN);
    const r = addLine(t, t.rootKey, ['e2e4', 'e2e4']);
    expect(r.keys).toHaveLength(1);
    t = toggleCollapse(r.tree, t.rootKey);
    expect(layout(t).nodes).toHaveLength(1);
    t = setNodeEval(t, t.rootKey, { type: 'cp', value: 20, perspective: 'white' }, 18);
    t = setNodeEval(t, t.rootKey, { type: 'cp', value: 99, perspective: 'white' }, 10);
    expect(t.nodes[t.rootKey].eval?.value).toBe(20);
  });
  it('lays out nodes without overlap', () => {
    let t = createTree(START_FEN);
    for (const m of ['e2e4', 'd2d4', 'c2c4', 'g1f3']) t = addLine(t, t.rootKey, [m, 'e7e6']).tree;
    const pos = layout(t).nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(pos).size).toBe(pos.length);
  });
  it('computes evaluation swings from the mover’s perspective', () => {
    let t = createTree(START_FEN);
    t = addLine(t, t.rootKey, ['f2f3']).tree;
    t = setNodeEval(t, t.rootKey, { type: 'cp', value: 30, perspective: 'white' }, 10);
    const k = Object.keys(t.nodes).find((x) => x !== t.rootKey)!;
    t = setNodeEval(t, k, { type: 'cp', value: -40, perspective: 'white' }, 10);
    expect(edgeSwing(t, t.edges[0])).toBe(-70);
  });
});

describe('What-If Simulator isolation', () => {
  it('never modifies the base position and is immutable', () => {
    const base = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const s0 = createSim(base);
    const s1 = simMove(s0, 'f1b5')!;
    const s2 = simMove(s1, 'a7a6')!;
    expect(s0.moves).toHaveLength(0);
    expect(currentFen(s0)).toBe(base);
    expect(s2.baseFen).toBe(base);
    expect(Object.isFrozen(s2)).toBe(true);
    expect(() => (s2.moves as unknown as unknown[]).push(1)).toThrow();
  });
  it('enforces turn order and legality for either side', () => {
    const s = createSim(START_FEN);
    expect(simMove(s, 'e7e5')).toBeNull();
    expect(simMove(simMove(s, 'e2e4')!, 'e7e5')).not.toBeNull();
  });
  it('steps, truncates future moves on a new branch, and resets', () => {
    let s = simMove(simMove(createSim(START_FEN), 'e2e4')!, 'e7e5')!;
    s = simStep(s, -1);
    expect(s.cursor).toBe(1);
    s = simMove(s, 'c7c5')!;
    expect(simUci(s)).toEqual(['e2e4', 'c7c5']);
    expect(simReset(s).moves).toHaveLength(0);
  });
  it('reports changed squares and exports PGN with the base FEN', () => {
    const base = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    const s = simMove(createSim(base), 'e2e4')!;
    expect(diffSquares(base, currentFen(s)).sort()).toEqual(['e2', 'e4']);
    const pgn = simToPgn(s);
    expect(pgn).toContain('[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]');
    expect(parsePgn(pgn).moves[0].san).toBe('e4');
  });
});

describe('opening recognition', () => {
  it('every database line is legal', () => {
    const idx = openingIndex();
    expect(idx.invalid).toEqual([]);
    expect(idx.byKey.size).toBeGreaterThan(OPENINGS.length * 0.9);
  });
  it('recognises the Najdorf with its ECO code', () => {
    const r = recogniseOpening(line(['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6', 'c1e3']));
    expect(r.opening).toMatchObject({ eco: 'B90', name: 'Sicilian Defence: Najdorf Variation' });
    expect(r.ply).toBe(10);
  });
  it('handles move-order transpositions (position-based)', () => {
    // QGD reached via 1.c4 e6 2.Nc3 d5 3.d4 (English move order)
    const r = recogniseOpening(line(['c2c4', 'e7e6', 'b1c3', 'd7d5', 'd2d4']));
    expect(r.opening?.eco).toBe('D31');
  });
  it('lists book continuations and searches the database', () => {
    const c = continuations(START_FEN).map((x) => x.san);
    expect(c).toEqual(expect.arrayContaining(['e4', 'd4', 'c4', 'Nf3']));
    expect(lookupPosition(line(['e2e4', 'e7e5'])[2])?.eco).toBe('C20');
    expect(searchOpenings('caro').every((o) => o.name.includes('Caro'))).toBe(true);
    expect(searchOpenings('C6').length).toBeGreaterThan(0);
  });
});
