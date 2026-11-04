import { useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty, Tabs } from '../ui';
import {
  allTags, createFolder, downloadText, exportAll, exportGamesPgn, getAnnotation, importAll, importPgnText, recentItems, relinkPosition, saveAnnotation, savePosition,
  search, setFavorite, setTags, moveToFolder, type Page, type RecentItem,
} from '@/memory/repo';
import { db } from '@/memory/db';
import type { AnalysisSession, Folder, NeuralTree, SavedGame, SavedPosition } from '@/types';
import { formatScore } from '@/engine/normalize';

type Kind = 'recent' | 'games' | 'positions' | 'sessions' | 'trees';

export function MemoryPanel({ compact }: { compact?: boolean }) {
  const { fen, analysis, loadPgn, loadFen, setTree, setTab, toast, moves, cursor, rootFen, openFull } = useApp();
  const [kind, setKind] = useState<Kind>('recent');
  const [text, setText] = useState('');
  const [tag, setTag] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [folder, setFolder] = useState<number | null | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page<any> | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [tags, setTagList] = useState<string[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [note, setNote] = useState('');
  const [nonce, setNonce] = useState(0);
  const limit = compact ? 6 : 12;

  useEffect(() => { getAnnotation(fen).then(setNote).catch(() => setNote('')); }, [fen]);
  useEffect(() => {
    allTags().then(setTagList).catch(() => {});
    db().folders.toArray().then(setFolders).catch(() => {});
    if (kind === 'recent') { recentItems(compact ? 6 : 14).then(setRecent).catch(() => {}); return; }
    search(kind, { text, tag: tag || undefined, favorite: favOnly ? true : undefined, folderId: folder, offset, limit }).then(setPage).catch(() => setPage(null));
  }, [kind, text, tag, favOnly, folder, offset, nonce, limit, compact]);
  const refresh = () => setNonce((n) => n + 1);

  const openItem = async (k: string, id: number) => {
    const d = db();
    if (k === 'game') { const g = await d.games.get(id); if (g) { loadPgn(g.pgn, g.id, 0); setTab('review'); } }
    if (k === 'position') { const p = await d.positions.get(id); if (p) loadFen(p.fen); }
    if (k === 'session') { const s = await d.sessions.get(id); if (s) loadFen(s.rootFen); }
    if (k === 'tree') { const t = await d.trees.get(id); if (t) { setTree(t); loadFen(t.nodes[t.rootKey].fen); setTab('neural'); } }
    if (k === 'simulation') { const s = await d.simulations.get(id); if (s) { loadFen(s.baseFen); setTab('whatif'); } }
  };

  const table = (kind === 'recent' ? 'games' : kind) as 'games' | 'positions' | 'sessions' | 'trees';
  const editTags = async (id: number, cur: string[]) => {
    const v = prompt('Tags (comma separated)', cur.join(', '));
    if (v !== null) { await setTags(table, id, v.split(',')); refresh(); }
  };
  const del = async (id: number) => { if (confirm('Delete this item permanently?')) { await (db() as any)[table].delete(id); refresh(); } };

  const saveCurrent = async () => {
    const title = prompt('Title for this position', `Position after ${Math.ceil(cursor / 2)}${cursor % 2 ? '.' : '…'}`);
    if (title === null) return;
    const r = await savePosition(fen, { title, lastEval: analysis.result?.lines[0]?.whiteScore });
    toast(r.duplicate ? 'Already saved — this position is in Memory' : 'Position saved');
    refresh();
  };
  const saveSessionNow = async () => {
    const { saveSession } = await import('@/memory/repo');
    await saveSession({ title: `Analysis ${new Date().toLocaleString()}`, rootFen: fen, variations: (analysis.result?.lines ?? []).map((l) => ({ id: `${l.multipv}`, rootFen: fen, moves: l.pv, san: l.pvSan, evalWhite: l.whiteScore })), lastResult: analysis.result ?? undefined, source: compact ? 'overlay' : 'board', tags: [] });
    toast('Analysis session saved'); refresh();
  };

  return (
    <div className="stack">
      <Card glow title="Personal Chess Memory" actions={<span className="muted small">stored only on this device</span>}>
        <div className="row wrap">
          <button className="btn sm primary" onClick={saveCurrent}>☆ Save position</button>
          <button className="btn sm" onClick={saveSessionNow} disabled={!analysis.result}>Save analysis session</button>
          {!compact && <button className="btn sm" onClick={async () => { const pgn = prompt('Paste PGN to import'); if (pgn) { const r = await importPgnText(pgn); toast(`Imported ${r.added.length}, duplicates ${r.duplicates}`); refresh(); } }}>Import PGN</button>}
          {compact && <button className="btn sm ghost" onClick={() => openFull?.({ fen, tab: 'memory' })}>Open full Memory</button>}
        </div>
        <label className="label" style={{ marginTop: 10 }} htmlFor="moth-note">Note for this position</label>
        <textarea id="moth-note" className="textarea" style={{ fontFamily: 'var(--font)', minHeight: 50 }} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => saveAnnotation(fen, note)} placeholder="Your annotation (saved automatically)…" />
      </Card>

      <Card>
        <Tabs label="Memory sections" value={kind} onChange={(k) => { setKind(k); setOffset(0); }} tabs={[
          { id: 'recent', label: 'Recent' }, { id: 'games', label: 'Games' }, { id: 'positions', label: 'Positions' }, { id: 'sessions', label: 'Sessions' }, { id: 'trees', label: 'Maps' },
        ]} />
        {kind !== 'recent' && (
          <div className="row wrap" style={{ margin: '10px 0' }}>
            <input className="input grow" style={{ minWidth: 140 }} placeholder="Search…" value={text} onChange={(e) => { setText(e.target.value); setOffset(0); }} aria-label="Search memory" />
            <select className="select" style={{ width: 'auto' }} value={tag} onChange={(e) => { setTag(e.target.value); setOffset(0); }} aria-label="Filter by tag">
              <option value="">All tags</option>{tags.map((t) => <option key={t} value={t}>#{t}</option>)}
            </select>
            <select className="select" style={{ width: 'auto' }} value={folder === undefined ? '' : folder === null ? 'none' : String(folder)} aria-label="Filter by folder"
              onChange={(e) => { const v = e.target.value; setFolder(v === '' ? undefined : v === 'none' ? null : Number(v)); setOffset(0); }}>
              <option value="">All folders</option><option value="none">No folder</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <button className={`btn sm ${favOnly ? 'primary' : ''}`} onClick={() => setFavOnly(!favOnly)} aria-pressed={favOnly}>★ Favourites</button>
            {!compact && <button className="btn sm ghost" onClick={async () => { const n = prompt('Folder name'); if (n) { await createFolder(n); refresh(); } }}>+ Folder</button>}
          </div>
        )}
        {kind === 'recent' && (
          <div className="list" style={{ marginTop: 8 }}>
            {!recent.length && <Empty>Nothing saved yet.</Empty>}
            {recent.map((r) => (
              <div key={r.kind + r.id} className="list-item" role="button" tabIndex={0} onClick={() => openItem(r.kind, r.id)}>
                <span className="badge neutral">{r.kind}</span><span className="grow">{r.title}</span><span className="muted small">{new Date(r.at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
        {kind !== 'recent' && page && (
          <>
            {!page.items.length && <Empty>No matching items.</Empty>}
            <div className="list">
              {page.items.map((it: any) => (
                <div key={it.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <button className="btn sm ghost icon" aria-label={it.favorite ? 'Unfavourite' : 'Favourite'} onClick={async () => { await setFavorite(table, it.id, !it.favorite); refresh(); }}>{it.favorite ? '★' : '☆'}</button>
                  <div className="grow" role="button" tabIndex={0} onClick={() => openItem(kind === 'games' ? 'game' : kind === 'positions' ? 'position' : kind === 'sessions' ? 'session' : 'tree', it.id)} style={{ cursor: 'pointer' }}>
                    <div>{rowTitle(kind, it)}</div>
                    <div className="muted small">{rowMeta(kind, it)} {(it.tags ?? []).map((t: string) => <span key={t} className="badge neutral" style={{ marginLeft: 4 }}>#{t}</span>)}</div>
                  </div>
                  {!compact && <>
                    <button className="btn sm ghost" onClick={() => editTags(it.id, it.tags ?? [])}>tags</button>
                    {folders.length > 0 && <select className="select" style={{ width: 90, height: 24, padding: '0 4px' }} value={it.folderId ?? ''} aria-label="Move to folder"
                      onChange={async (e) => { await moveToFolder(table, it.id, e.target.value ? Number(e.target.value) : undefined); refresh(); }}>
                      <option value="">—</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>}
                    {kind === 'positions' && <button className="btn sm ghost" title="Find stored games that reached this position" onClick={async () => { const l = await relinkPosition(it.id); toast(`${l.length} game${l.length === 1 ? '' : 's'} reached this position`); refresh(); }}>link</button>}
                    <button className="btn sm ghost danger" onClick={() => del(it.id)} aria-label="Delete">✕</button>
                  </>}
                </div>
              ))}
            </div>
            {page.total > page.limit && (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>‹ Prev</button>
                <span className="muted small grow" style={{ textAlign: 'center' }}>{offset + 1}–{Math.min(offset + limit, page.total)} of {page.total}</span>
                <button className="btn sm" disabled={offset + limit >= page.total} onClick={() => setOffset(offset + limit)}>Next ›</button>
              </div>
            )}
          </>
        )}
      </Card>

      {!compact && (
        <Card title="Import / export">
          <div className="row wrap">
            <button className="btn sm" onClick={async () => downloadText(`moth-chess-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export everything (JSON)</button>
            <button className="btn sm" onClick={async () => downloadText('moth-chess-games.pgn', await exportGamesPgn(), 'application/x-chess-pgn')}>Export games (PGN)</button>
            <label className="btn sm">Restore JSON backup<input type="file" accept=".json,application/json" hidden onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return;
              try { const r = await importAll(await f.text()); toast(`Restored: ${Object.entries(r.inserted).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new'}; duplicates skipped: ${Object.values(r.skippedDuplicates).reduce((a, b) => a + b, 0)}`); refresh(); }
              catch (err) { toast(`Restore failed: ${(err as Error).message}`); }
              e.target.value = '';
            }} /></label>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>Restores merge into your current data and skip duplicates. Nothing is ever uploaded. Current line: {moves.slice(0, cursor).length} moves from {rootFen === fen && !cursor ? 'this position' : 'the root'}.</p>
        </Card>
      )}
    </div>
  );
}

function rowTitle(kind: Kind, it: any): string {
  switch (kind) {
    case 'games': { const g = it as SavedGame; return `${g.white} – ${g.black} (${g.result})`; }
    case 'positions': return (it as SavedPosition).title;
    case 'sessions': return (it as AnalysisSession).title;
    case 'trees': return (it as NeuralTree).title;
    default: return '';
  }
}
function rowMeta(kind: Kind, it: any): string {
  switch (kind) {
    case 'games': { const g = it as SavedGame; return [g.eco && `${g.eco} ${g.openingName ?? ''}`, g.date, `${g.plyCount} plies`, g.reviewId ? 'reviewed' : ''].filter(Boolean).join(' · '); }
    case 'positions': { const p = it as SavedPosition; return [p.lastEval && formatScore(p.lastEval), p.linkedGameIds?.length ? `${p.linkedGameIds.length} linked games` : '', new Date(p.createdAt).toLocaleDateString()].filter(Boolean).join(' · '); }
    case 'sessions': { const s = it as AnalysisSession; return `${s.variations.length} lines · ${new Date(s.updatedAt).toLocaleString()}`; }
    case 'trees': { const t = it as NeuralTree; return `${Object.keys(t.nodes).length} positions · ${new Date(t.updatedAt).toLocaleDateString()}`; }
    default: return '';
  }
}
