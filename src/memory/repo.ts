// Memory repository: import/export, search, tags, folders, favourites, duplicates, position linking.
import type { AnalysisSession, Color, NeuralTree, SavedGame, SavedPosition, Simulation, FavouriteOpening, Folder, Annotation, WhiteScore } from '@/types';
import { db, positionHashesForPgn, TABLES, type StoredGame, type TableName } from './db';
import { buildPgn, parsePgn, positionKey, splitPgn, validateFen } from '@/chess/position';
import { contentHash, fnv1a } from '@/utils/hash';
import { recogniseOpening } from '@/openings/eco';

// ---------------- games ----------------

export interface ImportReport { added: number[]; duplicates: number; errors: { index: number; message: string }[] }

export function gameHash(headers: Record<string, string>, uciMoves: string[], startFen: string): string {
  return contentHash([startFen, uciMoves.join(' '), headers.White ?? '', headers.Black ?? '', headers.Date ?? '', headers.Round ?? ''].join('|'));
}

export async function importPgnText(text: string, opts: { userName?: string; tags?: string[]; folderId?: number } = {}): Promise<ImportReport> {
  const report: ImportReport = { added: [], duplicates: 0, errors: [] };
  const chunks = splitPgn(text);
  const d = db();
  for (let i = 0; i < chunks.length; i++) {
    const pgn = chunks[i];
    try {
      const g = parsePgn(pgn);
      if (!g.moves.length) throw new Error('Game has no moves');
      const hash = gameHash(g.headers, g.moves.map((m) => m.uci), g.startFen);
      if (await d.games.where('contentHash').equals(hash).count()) { report.duplicates++; continue; }
      const rec = recogniseOpening([g.startFen, ...g.moves.map((m) => m.fenAfter)]);
      const user = opts.userName?.trim().toLowerCase();
      let userColor: Color | undefined;
      if (user && g.headers.White?.toLowerCase() === user) userColor = 'w';
      else if (user && g.headers.Black?.toLowerCase() === user) userColor = 'b';
      const game: StoredGame = {
        pgn,
        headers: g.headers,
        white: g.headers.White ?? '?',
        black: g.headers.Black ?? '?',
        result: g.result,
        date: g.headers.Date,
        eco: g.headers.ECO ?? rec.opening?.eco,
        openingName: g.headers.Opening ?? rec.opening?.name,
        plyCount: g.moves.length,
        contentHash: hash,
        importedAt: Date.now(),
        userColor,
        tags: opts.tags ?? [],
        folderId: opts.folderId,
        posHashes: positionHashesForPgn(pgn),
      };
      report.added.push(await d.games.add(game));
    } catch (e) {
      report.errors.push({ index: i, message: (e as Error).message });
    }
  }
  return report;
}

export async function gamesWithPosition(fen: string): Promise<SavedGame[]> {
  return db().games.where('posHashes').equals(fnv1a(positionKey(fen))).toArray();
}

export async function exportGamesPgn(ids?: number[]): Promise<string> {
  const games = ids ? (await db().games.bulkGet(ids)).filter(Boolean) as SavedGame[] : await db().games.toArray();
  return games.map((g) => g.pgn.trim()).join('\n\n') + '\n';
}

// ---------------- positions ----------------

export async function savePosition(fen: string, opts: { title?: string; note?: string; tags?: string[]; lastEval?: WhiteScore; folderId?: number } = {}): Promise<{ id: number; duplicate: boolean }> {
  const v = validateFen(fen);
  if (!v.ok || !v.fen) throw new Error(v.error ?? 'Invalid FEN');
  const key = positionKey(v.fen);
  const existing = await db().positions.where('key').equals(key).first();
  if (existing?.id) return { id: existing.id, duplicate: true };
  const linked = (await gamesWithPosition(v.fen)).map((g) => g.id!).filter(Boolean);
  const id = await db().positions.add({
    fen: v.fen, key, title: opts.title?.trim() || `Position ${new Date().toLocaleString()}`, note: opts.note, createdAt: Date.now(),
    tags: opts.tags ?? [], folderId: opts.folderId, linkedGameIds: linked, lastEval: opts.lastEval,
  } as SavedPosition);
  return { id, duplicate: false };
}

/** Refresh links between a saved position and every stored game that reached it. */
export async function relinkPosition(id: number): Promise<number[]> {
  const p = await db().positions.get(id);
  if (!p) return [];
  const linked = (await gamesWithPosition(p.fen)).map((g) => g.id!);
  await db().positions.update(id, { linkedGameIds: linked });
  return linked;
}

// ---------------- sessions / trees / simulations / openings ----------------

export async function saveSession(s: Omit<AnalysisSession, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }): Promise<number> {
  const now = Date.now();
  if (s.id) { await db().sessions.update(s.id, { ...s, updatedAt: now }); return s.id; }
  return db().sessions.add({ ...s, createdAt: now, updatedAt: now } as AnalysisSession);
}

export async function saveTree(t: Omit<NeuralTree, 'createdAt' | 'updatedAt'> & { id?: number }): Promise<number> {
  const now = Date.now();
  if (t.id) { await db().trees.update(t.id, { ...t, updatedAt: now }); return t.id; }
  return db().trees.add({ ...t, createdAt: now, updatedAt: now } as NeuralTree);
}

export async function saveSimulation(s: Omit<Simulation, 'id' | 'createdAt'>): Promise<number> {
  return db().simulations.add({ ...s, createdAt: Date.now() } as Simulation);
}

export async function toggleFavouriteOpening(o: { eco: string; name: string; moves: string }): Promise<boolean> {
  const ex = await db().openings.where('name').equals(o.name).first();
  if (ex?.id) { await db().openings.delete(ex.id); return false; }
  await db().openings.add({ ...o, createdAt: Date.now() } as FavouriteOpening);
  return true;
}

export async function saveAnnotation(fen: string, text: string): Promise<void> {
  const key = positionKey(fen);
  const ex = await db().annotations.where('positionKey').equals(key).first();
  const now = Date.now();
  if (ex?.id) { if (text.trim()) await db().annotations.update(ex.id, { text, updatedAt: now }); else await db().annotations.delete(ex.id); }
  else if (text.trim()) await db().annotations.add({ positionKey: key, text, createdAt: now, updatedAt: now } as Annotation);
}

export async function getAnnotation(fen: string): Promise<string> {
  return (await db().annotations.where('positionKey').equals(positionKey(fen)).first())?.text ?? '';
}

// ---------------- folders / tags / favourites ----------------

export async function createFolder(name: string, parentId?: number): Promise<number> {
  return db().folders.add({ name: name.trim() || 'Folder', parentId, createdAt: Date.now() } as Folder);
}

type Taggable = 'games' | 'positions' | 'sessions' | 'trees';

export async function setTags(table: Taggable, id: number, tags: string[]) {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  await (db()[table] as any).update(id, { tags: clean });
}
export async function setFavorite(table: Taggable, id: number, favorite: boolean) { await (db()[table] as any).update(id, { favorite }); }
export async function moveToFolder(table: Taggable, id: number, folderId?: number) { await (db()[table] as any).update(id, { folderId }); }

export async function allTags(): Promise<string[]> {
  const d = db();
  const sets = await Promise.all((['games', 'positions', 'sessions', 'trees'] as Taggable[]).map((t) => (d[t] as any).orderBy('tags').uniqueKeys() as Promise<string[]>));
  return [...new Set(sets.flat())].sort();
}

// ---------------- search / pagination ----------------

export interface Query { text?: string; tag?: string; folderId?: number | null; favorite?: boolean; offset?: number; limit?: number }
export interface Page<T> { items: T[]; total: number; offset: number; limit: number }

function textOf(table: Taggable, r: any): string {
  switch (table) {
    case 'games': return `${r.white} ${r.black} ${r.eco ?? ''} ${r.openingName ?? ''} ${r.date ?? ''} ${r.headers?.Event ?? ''} ${(r.tags ?? []).join(' ')}`;
    case 'positions': return `${r.title} ${r.note ?? ''} ${r.fen} ${(r.tags ?? []).join(' ')}`;
    case 'sessions': return `${r.title} ${r.rootFen} ${(r.tags ?? []).join(' ')}`;
    case 'trees': return `${r.title} ${(r.tags ?? []).join(' ')}`;
  }
}

/** Paginated filtered search. Uses an index for tag filters; text filtering runs over the narrowed set lazily. */
export async function search<T>(table: Taggable, q: Query = {}): Promise<Page<T>> {
  const t = db()[table] as any;
  const limit = Math.max(1, Math.min(200, q.limit ?? 25));
  const offset = Math.max(0, q.offset ?? 0);
  let coll = q.tag ? t.where('tags').equals(q.tag.toLowerCase()) : t.toCollection();
  const needle = q.text?.trim().toLowerCase();
  const pred = (r: any) =>
    (!needle || textOf(table, r).toLowerCase().includes(needle)) &&
    (q.favorite === undefined || !!r.favorite === q.favorite) &&
    (q.folderId === undefined || (q.folderId === null ? r.folderId == null : r.folderId === q.folderId));
  coll = coll.filter(pred);
  const total = await coll.count();
  const items = (await coll.reverse().offset(offset).limit(limit).toArray()) as T[];
  return { items, total, offset, limit };
}

export interface RecentItem { kind: 'game' | 'position' | 'session' | 'tree' | 'simulation'; id: number; title: string; at: number; fen?: string }

export async function recentItems(limit = 12): Promise<RecentItem[]> {
  const d = db();
  const [g, p, s, t, sim] = await Promise.all([
    d.games.orderBy('importedAt').reverse().limit(limit).toArray(),
    d.positions.orderBy('createdAt').reverse().limit(limit).toArray(),
    d.sessions.orderBy('updatedAt').reverse().limit(limit).toArray(),
    d.trees.orderBy('updatedAt').reverse().limit(limit).toArray(),
    d.simulations.orderBy('createdAt').reverse().limit(limit).toArray(),
  ]);
  return [
    ...g.map((x) => ({ kind: 'game' as const, id: x.id!, title: `${x.white} – ${x.black} ${x.result}`, at: x.importedAt })),
    ...p.map((x) => ({ kind: 'position' as const, id: x.id!, title: x.title, at: x.createdAt, fen: x.fen })),
    ...s.map((x) => ({ kind: 'session' as const, id: x.id!, title: x.title, at: x.updatedAt, fen: x.rootFen })),
    ...t.map((x) => ({ kind: 'tree' as const, id: x.id!, title: x.title, at: x.updatedAt, fen: x.nodes[x.rootKey]?.fen })),
    ...sim.map((x) => ({ kind: 'simulation' as const, id: x.id!, title: x.title, at: x.createdAt, fen: x.baseFen })),
  ].sort((a, b) => b.at - a.at).slice(0, limit);
}

// ---------------- export / import / clear / usage ----------------

export const EXPORT_FORMAT = 'moth-chess-export';
export const EXPORT_VERSION = 2;

/** Binary model weights are exported as .mothnn files from the Learning Lab, not inside the JSON backup. */
export const JSON_EXPORT_TABLES = TABLES.filter((t) => t !== 'models');

export async function exportAll(tables: readonly TableName[] = JSON_EXPORT_TABLES): Promise<string> {
  const d = db();
  const data: Record<string, unknown[]> = {};
  for (const t of tables) { if (t === 'models') continue; data[t] = await (d as any)[t].toArray(); }
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), data }, null, 1);
}

export interface RestoreReport { inserted: Record<string, number>; skippedDuplicates: Record<string, number> }

/** Merge an export into the current database, skipping duplicates (by content hash / position key). IDs are remapped. */
export async function importAll(json: string): Promise<RestoreReport> {
  const parsed = JSON.parse(json);
  if (parsed?.format !== EXPORT_FORMAT || typeof parsed.data !== 'object') throw new Error('Not a MOTH Chess export file');
  if (parsed.version > EXPORT_VERSION) throw new Error(`Export version ${parsed.version} is newer than this extension supports`);
  const d = db();
  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const gameIdMap = new Map<number, number>();
  const exerciseIdMap = new Map<number, number>();
  const folderIdMap = new Map<number, number>();
  await d.transaction('rw', d.tables, async () => {
    const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
    for (const f of (parsed.data.folders ?? []) as Folder[]) {
      const { id, ...rest } = f;
      folderIdMap.set(id!, await d.folders.add(rest as Folder)); bump(inserted, 'folders');
    }
    const fid = (x?: number) => (x == null ? undefined : folderIdMap.get(x));
    for (const g of (parsed.data.games ?? []) as StoredGame[]) {
      const { id, ...rest } = g;
      const ex = await d.games.where('contentHash').equals(g.contentHash).first();
      if (ex) { gameIdMap.set(id!, ex.id!); bump(skipped, 'games'); continue; }
      gameIdMap.set(id!, await d.games.add({ ...rest, folderId: fid(rest.folderId), posHashes: rest.posHashes ?? positionHashesForPgn(rest.pgn) } as StoredGame));
      bump(inserted, 'games');
    }
    for (const r of (parsed.data.reviews ?? []) as any[]) {
      const { id, ...rest } = r; void id;
      const gid = gameIdMap.get(rest.gameId);
      if (!gid || (await d.reviews.where('gameId').equals(gid).count())) { bump(skipped, 'reviews'); continue; }
      await d.reviews.add({ ...rest, gameId: gid }); bump(inserted, 'reviews');
    }
    for (const p of (parsed.data.positions ?? []) as SavedPosition[]) {
      const { id, ...rest } = p; void id;
      if (await d.positions.where('key').equals(p.key).count()) { bump(skipped, 'positions'); continue; }
      await d.positions.add({ ...rest, folderId: fid(rest.folderId), linkedGameIds: (rest.linkedGameIds ?? []).map((x) => gameIdMap.get(x)).filter(Boolean) as number[] });
      bump(inserted, 'positions');
    }
    for (const e of (parsed.data.exercises ?? []) as any[]) {
      const { id, ...rest } = e;
      const ex = await d.exercises.where('contentHash').equals(e.contentHash).first();
      if (ex) { exerciseIdMap.set(id, ex.id!); bump(skipped, 'exercises'); continue; }
      exerciseIdMap.set(id, await d.exercises.add({ ...rest, sourceGameId: rest.sourceGameId ? gameIdMap.get(rest.sourceGameId) : undefined }));
      bump(inserted, 'exercises');
    }
    for (const a of (parsed.data.attempts ?? []) as any[]) {
      const { id, ...rest } = a; void id;
      const eid = exerciseIdMap.get(rest.exerciseId);
      if (!eid) { bump(skipped, 'attempts'); continue; }
      await d.attempts.add({ ...rest, exerciseId: eid }); bump(inserted, 'attempts');
    }
    for (const o of (parsed.data.openings ?? []) as any[]) {
      const { id, ...rest } = o; void id;
      if (await d.openings.where('name').equals(rest.name).count()) { bump(skipped, 'openings'); continue; }
      await d.openings.add(rest); bump(inserted, 'openings');
    }
    for (const a of (parsed.data.annotations ?? []) as any[]) {
      const { id, ...rest } = a; void id;
      if (await d.annotations.where('positionKey').equals(rest.positionKey).count()) { bump(skipped, 'annotations'); continue; }
      await d.annotations.add(rest); bump(inserted, 'annotations');
    }
    // v3 tables (MOTH Engine): practice games, latency samples, training runs. Exported since 2.0 but not
    // re-imported before 2.1. Duplicates are recognised by timestamp (+ distinguishing field).
    for (const p of (parsed.data.practice ?? []) as any[]) {
      const { id, ...rest } = p; void id;
      if (typeof rest.at !== 'number' || (await d.practice.where('at').equals(rest.at).count())) { bump(skipped, 'practice'); continue; }
      await d.practice.add({ ...rest, gameId: rest.gameId ? gameIdMap.get(rest.gameId) : undefined }); bump(inserted, 'practice');
    }
    for (const t of ['latency', 'runs'] as const) {
      for (const r of (parsed.data[t] ?? []) as any[]) {
        const { id, ...rest } = r; void id;
        if (typeof rest.at !== 'number' || (await (d as any)[t].where('at').equals(rest.at).count())) { bump(skipped, t); continue; }
        await (d as any)[t].add(rest); bump(inserted, t);
      }
    }
    for (const t of ['sessions', 'trees', 'simulations'] as const) {
      for (const r of (parsed.data[t] ?? []) as any[]) {
        const { id, ...rest } = r; void id;
        await (d as any)[t].add({ ...rest, folderId: fid(rest.folderId) }); bump(inserted, t);
      }
    }
  });
  return { inserted, skippedDuplicates: skipped };
}

export async function clearTables(tables: readonly TableName[]) {
  const d = db();
  await d.transaction('rw', tables.map((t) => (d as any)[t]), async () => { for (const t of tables) await (d as any)[t].clear(); });
}

export async function tableCounts(): Promise<Record<TableName, number>> {
  const d = db();
  const out = {} as Record<TableName, number>;
  for (const t of TABLES) out[t] = await (d as any)[t].count();
  return out;
}

export async function storageEstimate(): Promise<{ usage?: number; quota?: number }> {
  try { return (await navigator.storage?.estimate?.()) ?? {}; } catch { return {}; }
}

export function downloadText(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export { buildPgn };
