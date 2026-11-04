import { describe, it, expect } from 'vitest';
import { parseBoard, see, idx, hangingPieces, findPins, findSkewers, material, phaseOf, attackersOf } from '@/chess/geometry';
import { analyseThreats } from '@/threat-vision/threats';
import { threatLayers } from '@/threat-vision/layers';
import { computeFeatures } from '@/intelligence/features';
import { explainPosition, listProviders, heuristicProvider } from '@/intelligence/explain';
import { DEFAULT_SETTINGS } from '@/settings/schema';
import { START_FEN } from '@/chess/position';
import type { EngineResult } from '@/types';
import { toWhite } from '@/engine/normalize';

function fakeResult(fen: string, lines: { uci: string[]; cp?: number; mate?: number }[], depth = 20): EngineResult {
  const turn = fen.split(' ')[1] as 'w' | 'b';
  const sc = (l: { cp?: number; mate?: number }) => (l.mate !== undefined ? { type: 'mate' as const, value: l.mate } : { type: 'cp' as const, value: l.cp ?? 0 });
  return {
    fen, searchId: 1, depth, complete: true, bestMove: lines[0]?.uci[0],
    lines: lines.map((l, i) => ({ multipv: i + 1, depth, score: sc(l), whiteScore: toWhite(sc(l), turn), pv: l.uci, pvSan: [] })),
  };
}

describe('board geometry', () => {
  it('computes material and phase', () => {
    expect(material(parseBoard(START_FEN)).diff).toBe(0);
    expect(phaseOf(parseBoard(START_FEN), 0)).toBe('opening');
    expect(phaseOf(parseBoard('8/5k2/8/3P4/8/8/2K5/8 w - - 0 50'))).toBe('endgame');
  });
  it('static exchange: undefended piece is a full win, defended equal trade is 0', () => {
    // white knight e5 attacked by black pawn d6? (no) — rook takes undefended knight
    const b1 = parseBoard('4k3/8/8/4n3/8/8/8/4RK2 w - - 0 1');
    expect(see(b1, idx('e5'), 'w')).toBe(3);
    const b2 = parseBoard('4k3/3p4/8/4n3/8/8/8/4RK2 w - - 0 1'); // Nd defended by pawn d6? (d7 doesn't defend e5) → still hanging
    expect(see(b2, idx('e5'), 'w')).toBe(3);
    const b3 = parseBoard('4k3/8/3p4/4n3/8/8/8/4RK2 w - - 0 1'); // pawn d6 defends: RxN, pxR = 3 - 5
    expect(see(b3, idx('e5'), 'w')).toBe(0); // white simply should not capture → best is 0
  });
  it('finds hanging pieces (attacked by a lesser piece)', () => {
    const h = hangingPieces(parseBoard('4k3/8/8/3q4/4P3/8/8/4K3 b - - 0 1'), 'b');
    expect(h.map((x) => x.square)).toContain('d5');
    expect(h[0].reason).toBe('attacked-by-lesser');
  });
  it('detects absolute pins and skewers', () => {
    const pins = findPins(parseBoard('4k3/4n3/8/8/8/8/8/4RK2 w - - 0 1'), 'b');
    expect(pins).toEqual([expect.objectContaining({ pinned: 'e7', pinner: 'e1', absolute: true })]);
    const sk = findSkewers(parseBoard('8/8/8/q3k3/8/8/8/R5K1 w - - 0 1'), 'b');
    void sk; // queen and king not on the a-file line together — no skewer
    const sk2 = findSkewers(parseBoard('4q3/8/8/4k3/8/8/8/4R1K1 w - - 0 1'), 'b');
    expect(sk2[0]).toMatchObject({ attacker: 'e1', front: 'e5', back: 'e8' });
  });
  it('lists attackers', () => {
    expect(attackersOf(parseBoard(START_FEN), idx('f3'), 'w').length).toBe(3); // e2, g2 pawns + g1 knight
  });
});

describe('Threat Vision', () => {
  it('finds a knight fork of king and rook (Nc7+)', () => {
    const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1';
    const r = analyseThreats(fen);
    const fork = r.forks.find((f) => f.san.startsWith('Nc7'));
    expect(fork).toBeDefined();
    expect(fork!.targets).toEqual(expect.arrayContaining(['e8', 'a8']));
    expect(fork!.kind).toBe('geometric');
  });
  it('marks a fork engine-validated when it is among Stockfish’s top lines', () => {
    const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1';
    const r = analyseThreats(fen, fakeResult(fen, [{ uci: ['d5c7'], cp: 500 }]));
    expect(r.forks.find((f) => f.uci === 'd5c7')!.kind).toBe('engine-validated');
  });
  it('lists checks (with mate) and defensive responses when in check', () => {
    const r = analyseThreats('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    expect(r.checks.find((c) => c.san === 'Rd8#')?.mate).toBe(true);
    const inCheck = analyseThreats('3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1');
    expect(inCheck.inCheck).toBe(true);
    expect(inCheck.kingWarnings.some((w) => w.message.includes('check'))).toBe(true);
  });
  it('finds material the side to move can win and what the opponent threatens', () => {
    const r = analyseThreats('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1');
    expect(r.materialThreats[0]).toMatchObject({ san: 'exd5', gain: 9 });
  });
  it('builds toggleable board layers', () => {
    const r = analyseThreats('4k3/4n3/8/8/8/8/8/4RK2 w - - 0 1');
    const on = threatLayers(r, DEFAULT_SETTINGS.visual.threatLayers);
    expect(on.highlights.some((h) => h.square === 'e7')).toBe(true);
    const off = threatLayers(r, { ...DEFAULT_SETTINGS.visual.threatLayers, pins: false, undefended: false, hanging: false, kingSafety: false, checks: false });
    expect(off.highlights.some((h) => h.square === 'e7')).toBe(false);
  });
});

describe('MOTH Intelligence', () => {
  it('computes verified features for the start position', () => {
    const f = computeFeatures(START_FEN, 0);
    expect(f.w.undevelopedMinors).toHaveLength(4);
    expect(f.w.castled).toBe(false);
    expect(f.w.pawnShield).toBeGreaterThan(0);
    expect(f.materialDiff).toBe(0);
  });
  it('explains a developing move and compares candidates, tagging sources', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const rep = explainPosition(fen, fakeResult(fen, [{ uci: ['g1f3', 'b8c6'], cp: 35 }, { uci: ['h2h4'], cp: -40 }]), { detail: 'detailed' });
    expect(rep.candidates[0].san).toBe('Nf3');
    expect(rep.candidates[0].reasons.some((r) => /Develops a knight/.test(r.text) && r.source === 'heuristic')).toBe(true);
    expect(rep.candidates[1].reasons.some((r) => r.source === 'engine' && /worse than Nf3/.test(r.text))).toBe(true);
    expect(rep.insights[0].source).toBe('engine');
    expect(rep.summary).toMatch(/Nf3 is the engine's choice/);
  });
  it('never claims engine-proven insights when no engine result is available', () => {
    const rep = explainPosition('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    expect(rep.insights.every((i) => i.source !== 'engine')).toBe(true);
    expect(rep.candidates).toHaveLength(0);
  });
  it('ignores engine results that belong to another position', () => {
    const rep = explainPosition(START_FEN, fakeResult('8/8/8/8/8/8/8/K6k w - - 0 1', [{ uci: ['a1a2'], cp: 0 }]));
    expect(rep.candidates).toHaveLength(0);
  });
  it('detects a hanging piece and endgame principles', () => {
    expect(explainPosition('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1').insights.some((i) => i.category === 'hanging')).toBe(true);
    const eg = explainPosition('8/5k2/8/3P4/8/8/2K5/8 w - - 0 50');
    expect(eg.phase).toBe('endgame');
    expect(eg.insights.some((i) => i.category === 'endgame')).toBe(true);
  });
  it('reports checkmate by the rules', () => {
    expect(explainPosition('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3').insights[0]).toMatchObject({ source: 'rules', text: expect.stringContaining('Checkmate') });
  });
  it('has a pluggable provider registry with an always-available heuristic provider', async () => {
    expect(listProviders()[0].id).toBe('heuristic');
    expect(await heuristicProvider.available()).toBe(true);
  });
  it('compares candidates against a forced mate without centipawn nonsense', () => {
    const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const rep = explainPosition(fen, fakeResult(fen, [{ uci: ['h5f7'], mate: 1 }, { uci: ['h5h4'], cp: -107 }]), { detail: 'detailed' });
    expect(rep.candidates[0].san).toBe('Qxf7#');
    const cmp = rep.candidates[1].reasons.find((r) => r.source === 'engine');
    expect(cmp?.text).toBe('Misses the forced mate in 1 that Qxf7# delivers (depth 20).');
    expect(rep.candidates[1].reasons.some((r) => /pawns worse/.test(r.text))).toBe(false);
  });
});
