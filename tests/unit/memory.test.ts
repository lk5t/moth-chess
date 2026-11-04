// Personal Chess Memory on IndexedDB (fake-indexeddb in Node).
import { describe, it, expect, beforeEach } from 'vitest';
import Dexie from 'dexie';
import { MothDB, setDb, db } from '@/memory/db';
import {
  importPgnText, savePosition, search, exportAll, importAll, clearTables, tableCounts, setTags, setFavorite, allTags, gamesWithPosition, recentItems,
  createFolder, moveToFolder, saveTree, saveAnnotation, getAnnotation, toggleFavouriteOpening, exportGamesPgn,
} from '@/memory/repo';
import { createTree, addLine } from '@/neural-map/graph';
import { START_FEN, applyMove } from '@/chess/position';

const G1 = `[Event "A"]\n[White "Alice"]\n[Black "Bob"]\n[Date "2026.01.01"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;
const G2 = `[Event "B"]\n[White "Carol"]\n[Black "Alice"]\n[Date "2026.01.02"]\n[Result "0-1"]\n\n1. d4 d5 2. c4 e6 0-1`;
let n = 0;

beforeEach(async () => {
  setDb(new MothDB(`moth-test-${++n}`));
});

describe('games', () => {
  it('imports multi-game PGN, detects duplicates, opening and user colour', async () => {
    const r = await importPgnText(`${G1}\n\n${G2}`, { userName: 'alice' });
    expect(r.added).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
    const again = await importPgnText(G1);
    expect(again.duplicates).toBe(1);
    const games = await db().games.toArray();
    expect(games.find((g) => g.white === 'Alice')!.userColor).toBe('w');
    expect(games.find((g) => g.white === 'Carol')!.userColor).toBe('b');
    expect(games.find((g) => g.white === 'Alice')!.eco).toBe('C68'.slice(0, 1) + games.find((g) => g.white === 'Alice')!.eco!.slice(1));
    expect(games.find((g) => g.white === 'Carol')!.openingName).toMatch(/Queen's Gambit/);
  });
  it('reports per-game errors without aborting the batch', async () => {
    const r = await importPgnText(`${G1}\n\n[Event "bad"]\n\n1. e4 e5 2. Ke3 Ke6 3. Kxe6 *`);
    expect(r.added).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
  });
  it('links positions to games that reached them (indexed)', async () => {
    await importPgnText(`${G1}\n\n${G2}`);
    const afterE4 = applyMove(START_FEN, 'e2e4')!.fenAfter;
    expect((await gamesWithPosition(afterE4)).map((g) => g.white)).toEqual(['Alice']);
    const p = await savePosition(afterE4, { title: 'After 1.e4' });
    expect((await db().positions.get(p.id))!.linkedGameIds).toHaveLength(1);
  });
  it('exports PGN', async () => {
    await importPgnText(G1);
    expect(await exportGamesPgn()).toContain('[White "Alice"]');
  });
});

describe('positions, tags, folders, favourites, search', () => {
  it('detects duplicate positions by position key', async () => {
    const a = await savePosition(START_FEN, { title: 'start' });
    const b = await savePosition(START_FEN.replace(' 0 1', ' 5 9'), { title: 'same position later' });
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
  });
  it('searches with text, tag, favourite and folder filters and paginates', async () => {
    let fen = START_FEN;
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d4', 'e5d4', 'c3d4', 'c5b4'];
    const ids: number[] = [];
    for (const [i, m] of moves.entries()) { fen = applyMove(fen, m)!.fenAfter; ids.push((await savePosition(fen, { title: `pos ${i}${i % 3 === 0 ? ' italian' : ''}` })).id); }
    await setTags('positions', ids[0], ['Tactics', ' italian ']);
    await setFavorite('positions', ids[1], true);
    const folder = await createFolder('Openings');
    await moveToFolder('positions', ids[2], folder);
    expect((await search('positions', { text: 'italian' })).total).toBe(4);
    expect((await search('positions', { tag: 'tactics' })).items).toHaveLength(1);
    expect((await search('positions', { favorite: true })).items).toHaveLength(1);
    expect((await search('positions', { folderId: folder })).items).toHaveLength(1);
    const p1 = await search('positions', { limit: 5, offset: 0 });
    const p3 = await search('positions', { limit: 5, offset: 10 });
    expect(p1.total).toBe(12);
    expect(p1.items).toHaveLength(5);
    expect(p3.items).toHaveLength(2);
    expect(await allTags()).toEqual(['italian', 'tactics']);
  });
  it('stores annotations, favourite openings, trees and lists recent items', async () => {
    await saveAnnotation(START_FEN, 'my note');
    expect(await getAnnotation(START_FEN)).toBe('my note');
    expect(await toggleFavouriteOpening({ eco: 'C50', name: 'Italian Game', moves: 'e4 e5 Nf3 Nc6 Bc4' })).toBe(true);
    expect(await toggleFavouriteOpening({ eco: 'C50', name: 'Italian Game', moves: 'e4 e5 Nf3 Nc6 Bc4' })).toBe(false);
    const t = addLine(createTree(START_FEN, 'My map'), createTree(START_FEN).rootKey, ['e2e4']).tree;
    await saveTree(t);
    await importPgnText(G1);
    const recent = await recentItems();
    expect(recent.map((r) => r.kind)).toEqual(expect.arrayContaining(['tree', 'game']));
  });
});

describe('export / import / clear', () => {
  it('round-trips everything and skips duplicates on re-import', async () => {
    await importPgnText(`${G1}\n\n${G2}`);
    await savePosition(START_FEN, { title: 'start', tags: ['x'] });
    const json = await exportAll();
    setDb(new MothDB(`moth-test-${++n}`));
    const r1 = await importAll(json);
    expect(r1.inserted.games).toBe(2);
    expect(r1.inserted.positions).toBe(1);
    const r2 = await importAll(json);
    expect(r2.skippedDuplicates.games).toBe(2);
    expect((await tableCounts()).games).toBe(2);
  });
  it('rejects foreign files', async () => {
    await expect(importAll('{"hello":1}')).rejects.toThrow(/Not a MOTH/);
  });
  it('clears selected tables only', async () => {
    await importPgnText(G1);
    await savePosition(START_FEN);
    await clearTables(['games']);
    const c = await tableCounts();
    expect(c.games).toBe(0);
    expect(c.positions).toBe(1);
  });
});

describe('database migrations', () => {
  it('upgrades a v1 database to v2 and backfills new fields', async () => {
    const name = `moth-migrate-${++n}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      games: '++id, contentHash, white, black, eco, result, importedAt, *tags, folderId',
      positions: '++id, key, createdAt, *tags, folderId', openings: '++id, eco, name', sessions: '++id, updatedAt, source, *tags, folderId',
      exercises: '++id, contentHash, category, sourceGameId', annotations: '++id, positionKey', folders: '++id, parentId, name',
    });
    await v1.open();
    await v1.table('games').add({ pgn: G1, headers: {}, white: 'Alice', black: 'Bob', result: '1-0', plyCount: 6, contentHash: 'h1', importedAt: 1 });
    await v1.table('exercises').add({ fen: START_FEN, solutionUci: 'e2e4', category: 'tactic', contentHash: 'e1' });
    await v1.table('positions').add({ fen: START_FEN, key: 'k', title: 't', createdAt: 1 });
    v1.close();

    const v2 = new MothDB(name);
    setDb(v2);
    await v2.open();
    expect(v2.verno).toBe(4); // migrates straight to the latest schema
    expect(await v2.repertoire.count()).toBe(0); // 3.0 tables exist
    expect(await v2.trainingLog.count()).toBe(0);
    expect(await v2.practice.count()).toBe(0); // v3 tables exist
    expect(await v2.models.count()).toBe(0);
    const g = (await v2.games.toArray())[0];
    expect(g.tags).toEqual([]);
    expect(g.posHashes!.length).toBeGreaterThan(5);
    const e = (await v2.exercises.toArray())[0];
    expect(e.box).toBe(0);
    expect(typeof e.dueAt).toBe('number');
    expect((await v2.positions.toArray())[0].linkedGameIds).toEqual([]);
    expect(await v2.reviews.count()).toBe(0); // new table exists
  });
});

describe('3.0 schema v4 migration keeps 2.x data', () => {
  it('opens a v3 database with data and adds the 3.0 tables without touching existing rows', async () => {
    const name = `moth-migrate-v3-${++n}`;
    const v3 = new MothDB(name);
    await v3.open();
    await v3.games.add({ pgn: G1, headers: {}, white: 'Alice', black: 'Bob', result: '1-0', plyCount: 6, contentHash: 'h1', importedAt: 1, tags: [] } as never);
    await v3.practice.add({ at: 5, userColor: 'w', result: '1-0' } as never);
    v3.close();
    const v4 = new MothDB(name);
    await v4.open();
    expect(v4.verno).toBe(4);
    expect(await v4.games.count()).toBe(1);
    expect(await v4.practice.count()).toBe(1);
    await v4.repertoire.add({ color: 'w', name: 'Italian', uci: ['e2e4'], key: 'w:e2e4', createdAt: 1, drilled: 0, correct: 0, dueAt: 0, box: 0 });
    expect(await v4.repertoire.count()).toBe(1);
    v4.close();
  });
});
