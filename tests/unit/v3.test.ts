// 3.0 modules: endgame intelligence, adaptive training / Player DNA, game reports, updates, explorer.
import { describe, it, expect, beforeEach } from 'vitest';
import { probeKPK, sq } from '@/endgame/kpk';
import { analyseEndgame, ENDGAME_DRILLS } from '@/endgame/endgame';
import { computeDna, endgameLevel, recommend, scheduleRepertoire, repertoireQuestions, saveRepertoire, BOX_DAYS } from '@/training/adaptive';
import { buildReport, reportMarkdown, ACCURACY_METHOD } from '@/review/report';
import { compareVersions, updateAvailable, checkForUpdate, readUpdateState, recordInstalled } from '@/updates/updates';
import { plansFor } from '@/openings/explorer';
import { validateFen, applyMove } from '@/chess/position';
import { MothDB, setDb, db, type TrainingLog } from '@/memory/db';
import type { GameReview, ReviewedMove, SavedGame } from '@/types';

let n = 0;
beforeEach(() => { setDb(new MothDB(`moth-v3-${++n}`)); });

describe('endgame: exact KPK table', () => {
  it('knows the opposition', () => {
    expect(probeKPK(sq('e5'), sq('e7'), sq('e4'), true, true)).toBe('draw'); // Black has the opposition
    expect(probeKPK(sq('e5'), sq('e7'), sq('e4'), true, false)).toBe('win');
    expect(probeKPK(sq('d6'), sq('d8'), sq('d5'), true, true)).toBe('win'); // king on the 6th in front: always wins
  });
  it('draws rook pawns when the defender holds the corner, wins far-away pawns', () => {
    expect(probeKPK(sq('b6'), sq('a8'), sq('a5'), true, true)).toBe('draw');
    expect(probeKPK(sq('g1'), sq('b6'), sq('g2'), true, true)).toBe('win');
  });
  it('is colour- and mirror-symmetric', () => {
    // White Ke5 ke7 Pe4 (wtm draw)  ⇔  Black Ke4 ke2 Pe5 (btm draw)
    expect(probeKPK(sq('e2'), sq('e4'), sq('e5'), false, false)).toBe('draw');
    expect(probeKPK(sq('e2'), sq('e4'), sq('e5'), false, true)).toBe('win');
    expect(probeKPK(sq('f3'), sq('f5'), sq('f2'), true, true)).toBe(probeKPK(sq('c3'), sq('c5'), sq('c2'), true, true));
  });
  it('builds the table quickly', () => {
    const t0 = performance.now();
    probeKPK(sq('a2'), sq('h7'), sq('b2'), true, true);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe('endgame classification', () => {
  it('classifies and explains', () => {
    expect(analyseEndgame('8/8/8/4k3/8/8/8/3QK3 w - - 0 1')).toMatchObject({ kind: 'basic-mate', verdict: { result: 'win-white' } });
    expect(analyseEndgame('8/8/8/4k3/8/8/8/3NK3 w - - 0 1').verdict?.result).toBe('draw');
    const kpk = analyseEndgame('8/4k3/8/4K3/4P3/8/8/8 w - - 0 1');
    expect(kpk.kind).toBe('kpk');
    expect(kpk.verdict).toMatchObject({ result: 'draw', certainty: 'exact' });
    expect(analyseEndgame('4k3/r7/8/3PK3/8/8/8/7R b - - 0 1').kind).toBe('rook-pawn');
    expect(analyseEndgame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1').isEndgame).toBe(false);
  });
  it('applies the rule of the square in pawn races', () => {
    const out = analyseEndgame('8/8/1k6/8/8/8/6P1/6K1 w - - 0 1');
    const r = out.races.find((x) => x.pawn === 'g2')!;
    expect(r.insideSquare).toBe(false);
    expect(r.unstoppable).toBe(true);
    const inside = analyseEndgame('8/8/6k1/8/8/8/6P1/6K1 w - - 0 1').races.find((x) => x.pawn === 'g2')!;
    expect(inside.insideSquare).toBe(true);
  });
  it('every training position is legal, and KPK drills match the exact table', () => {
    for (const d of ENDGAME_DRILLS) {
      expect(validateFen(d.fen).ok, d.id).toBe(true);
      const info = analyseEndgame(d.fen);
      if (info.kind === 'kpk') expect(info.verdict!.result === 'draw' ? 'draw' : 'win', d.id).toBe(d.goal);
    }
  });
});

const mk = (ply: number, color: 'w' | 'b', cls: ReviewedMove['classification'], before: number, after: number, phase: ReviewedMove['phase'] = 'middlegame', best?: string): ReviewedMove => ({
  ply, san: `m${ply}`, uci: 'e2e4', color, fenBefore: '8/8/8/8/8/8/8/8 w - - 0 1', fenAfter: '8/8/8/8/8/8/8/8 b - - 0 1',
  evalBefore: { type: 'cp', value: 0 }, evalAfter: { type: 'cp', value: 0 }, bestMoveSan: best, winBefore: before, winAfter: after,
  accuracy: Math.max(0, 100 - (before - after) * 3), classification: cls, phase,
} as ReviewedMove);

describe('smart game report', () => {
  const moves = [mk(1, 'w', 'book', 50, 50, 'opening'), mk(2, 'b', 'best', 50, 50, 'opening'), mk(3, 'w', 'blunder', 55, 20, 'middlegame', 'Nf3'), mk(4, 'b', 'mistake', 80, 60, 'middlegame', 'Qh4'), mk(5, 'w', 'best', 40, 40, 'endgame')];
  const review: GameReview = { gameId: 1, depth: 12, status: 'complete', progressPly: 5, totalPly: 5, moves, createdAt: 1, updatedAt: 1 };
  const game: SavedGame = { id: 1, pgn: '', headers: {}, white: 'Ann', black: 'Bo', result: '0-1', plyCount: 5, contentHash: 'x', importedAt: 1, tags: [], userColor: 'w' };
  it('finds critical moments, missed chances and strong moves from measured swings only', () => {
    const r = buildReport(review, game);
    expect(r.critical[0]).toMatchObject({ ply: 3, swing: 35, best: 'Nf3' });
    expect(r.missed[0]).toMatchObject({ ply: 4, best: 'Qh4' }); // Black failed to punish 3.m3 fully
    expect(r.strong[0]).toMatchObject({ ply: 5 }); // best move right after the opponent's 20-point mistake
    expect(r.summary[0]).toMatch(/Black won/);
    expect(r.method).toBe(ACCURACY_METHOD);
    const md = reportMarkdown(r);
    expect(md).toContain('## Critical moments');
    expect(md).toContain('How accuracy is calculated');
  });
});

describe('adaptive training and Player DNA', () => {
  it('adapts endgame level: up after two successes, down after two failures', () => {
    const L = (level: number, success: boolean, at: number): TrainingLog => ({ at, kind: 'endgame', itemId: 'x', success, level });
    expect(endgameLevel([])).toBe(1);
    expect(endgameLevel([L(1, true, 1), L(1, true, 2)])).toBe(2);
    expect(endgameLevel([L(1, true, 1), L(1, true, 2), L(2, false, 3), L(2, false, 4)])).toBe(1);
    expect(endgameLevel([L(1, true, 1), L(1, false, 2), L(1, true, 3)])).toBe(1);
  });
  it('schedules repertoire lines with Leitner boxes and asks only the user\'s moves', () => {
    const line = { id: 1, color: 'b' as const, name: 'x', uci: ['e2e4', 'c7c5', 'g1f3', 'd7d6'], key: 'b:x', createdAt: 0, drilled: 0, correct: 0, dueAt: 0, box: 1 };
    expect(repertoireQuestions(line)).toEqual([1, 3]);
    const ok = scheduleRepertoire(line, true, 0);
    expect(ok.box).toBe(2); expect(ok.dueAt).toBe(BOX_DAYS[2] * 86400e3);
    expect(scheduleRepertoire(line, false, 0).box).toBe(0);
  });
  it('saves repertoire lines without duplicates', async () => {
    expect(await saveRepertoire('w', 'Italian', ['e2e4', 'e7e5'])).toBe(true);
    expect(await saveRepertoire('w', 'Italian', ['e2e4', 'e7e5'])).toBe(false);
    expect(await db().repertoire.count()).toBe(1);
  });
  it('computes DNA only from stored data and recommends with reasons', () => {
    const games: SavedGame[] = [1, 2, 3, 4].map((i) => ({ id: i, pgn: '', headers: {}, white: 'me', black: 'x', result: i % 2 ? '1-0' : '0-1', plyCount: 40, contentHash: `${i}`, importedAt: i, tags: [], userColor: 'w', openingName: 'Italian Game', eco: 'C50' }));
    const dna = computeDna(games, [], [], [], []);
    expect(dna.games).toBe(4);
    expect(dna.openings[0]).toMatchObject({ name: 'Italian Game', games: 4, score: 0.5, color: 'w' });
    expect(dna.sufficient).toBe(false);
    const recs = recommend(dna, { exercises: 3, repertoire: 0 }, []);
    expect(recs[0].kind).toBe('exercises');
    expect(recs.some((r) => r.kind === 'review')).toBe(true);
    expect(recs.find((r) => r.kind === 'endgame')?.target).toBe(ENDGAME_DRILLS.find((d) => d.level === 1)!.id);
  });
});

describe('updates', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('3.0.0', '2.1.9')).toBe(1);
    expect(compareVersions('v2.10.0', '2.9.0')).toBe(1);
    expect(compareVersions('3.0.0', '3.0.0')).toBe(0);
    expect(compareVersions('3.0.0-beta', '3.0.1')).toBe(-1);
  });
  it('checks GitHub at most once a day and never installs anything', async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response(JSON.stringify({ tag_name: 'v3.1.0', html_url: 'https://github.com/lk5t/moth-chess/releases/tag/v3.1.0', body: 'notes' }), { status: 200 }); }) as typeof fetch;
    const st = await checkForUpdate('3.0.0', { fetcher, force: true });
    expect(updateAvailable(st, '3.0.0')).toBe(true);
    expect(updateAvailable(st, '3.1.0')).toBe(false);
    await checkForUpdate('3.0.0', { fetcher });
    expect(calls).toBe(1);
    const bad = (async () => new Response('x', { status: 500 })) as typeof fetch;
    expect((await checkForUpdate('3.0.0', { fetcher: bad, force: true })).error).toMatch(/500/);
  });
  it('records upgrades for the "what\'s new" notice', async () => {
    await recordInstalled('3.0.0', '2.0.1');
    expect((await readUpdateState()).installed).toMatchObject({ from: '2.0.1', to: '3.0.0', seen: false });
  });
});

describe('opening explorer helpers', () => {
  it('gives family plans and a generic fallback', () => {
    expect(plansFor('Sicilian Defense: Najdorf Variation')[0]).toMatch(/d4/);
    expect(plansFor('Some Unknown Opening').length).toBe(1);
  });
  it('drill moves used in tests are legal', () => {
    expect(applyMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e4')).not.toBeNull();
  });
});
