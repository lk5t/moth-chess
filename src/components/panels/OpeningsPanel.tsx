import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty } from '../ui';
import { continuations, openingIndex, recogniseOpening, searchOpenings } from '@/openings/eco';
import { toggleFavouriteOpening } from '@/memory/repo';
import { db } from '@/memory/db';
import { START_FEN } from '@/chess/position';
import type { FavouriteOpening } from '@/types';
import { loadBook, bookMoves, myGamesAt, plansFor } from '@/openings/explorer';
import { saveRepertoire } from '@/training/adaptive';
import { useLiveQuery } from '@/memory/useLiveQuery';
import type { OpeningBook } from '@/moth-engine/book';

export function OpeningsPanel() {
  const { rootFen, moves, cursor, fen, play, loadLine, toast } = useApp();
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState<FavouriteOpening[]>([]);
  const rec = useMemo(() => recogniseOpening([rootFen, ...moves.slice(0, cursor).map((m) => m.fenAfter)]), [rootFen, moves, cursor]);
  const conts = useMemo(() => continuations(fen), [fen]);
  const results = useMemo(() => searchOpenings(q).slice(0, 40), [q]);
  const loadFavs = () => db().openings.toArray().then(setFavs).catch(() => {});
  useEffect(() => { void loadFavs(); }, []);
  const isFav = rec.opening && favs.some((f) => f.name === rec.opening!.name);
  const [book, setBook] = useState<OpeningBook | null>(null);
  useEffect(() => { void loadBook().then(setBook); }, []);
  const bm = useMemo(() => bookMoves(book, fen), [book, fen]);
  const mine = useLiveQuery(() => myGamesAt(fen), [fen], { total: 0, moves: [] });
  const line = moves.slice(0, cursor).map((m) => m.uci);
  const addRep = async (color: 'w' | 'b') => {
    if (rootFen !== START_FEN || !line.length) { toast('Repertoire lines start from the standard position — play some moves first.'); return; }
    const ok = await saveRepertoire(color, rec.opening ? `${rec.opening.name} (${line.length} ply)` : moves.slice(0, cursor).map((m) => m.san).join(' '), line);
    toast(ok ? `Added to your ${color === 'w' ? 'White' : 'Black'} repertoire — drill it in Train → Practice` : 'This line is already in your repertoire');
  };

  return (
    <div className="stack">
      <Card glow title="Opening">
        {rec.opening ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row"><span className="badge">{rec.opening.eco}</span><b style={{ fontSize: 15 }}>{rec.opening.name}</b><span className="grow" />
              <button className="btn sm" onClick={async () => { const on = await toggleFavouriteOpening(rec.opening!); toast(on ? 'Added to favourite openings' : 'Removed from favourites'); loadFavs(); }}>{isFav ? '★ Favourite' : '☆ Favourite'}</button>
            </div>
            <div className="mono small muted">{rec.opening.moves}</div>
            <div className="small muted">{rec.inBook ? 'Current position is in the local book.' : `Left book${rec.leftBookAt ? ` at ply ${rec.leftBookAt}` : ''}; last named position at ply ${rec.ply}.`} Recognition is position-based, so transpositions are detected.</div>
          </div>
        ) : <Empty>{rootFen === START_FEN ? 'Play or load moves to identify the opening.' : 'Opening recognition works from the standard starting position.'}</Empty>}
      </Card>
      <div className="row wrap">
        <button className="btn sm" onClick={() => addRep('w')} title="Save the moves played so far as a line you play with White">+ Repertoire (White)</button>
        <button className="btn sm" onClick={() => addRep('b')} title="Save the moves played so far as a line you play with Black">+ Repertoire (Black)</button>
      </div>
      {rec.opening && <Card title="Typical plans"><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{plansFor(rec.opening.name).map((p) => <li key={p}>{p}</li>)}</ul></Card>}
      <Card title="Common responses" actions={<span className="muted small">MOTH book · each move checked by Stockfish</span>}>
        {!bm?.moves.length && <Empty>{book ? 'Out of MOTH\'s book here.' : 'Loading the book…'}</Empty>}
        {bm?.moves.slice(0, 8).map((m) => (
          <div key={m.uci} className="list-item" role="button" tabIndex={0} onClick={() => play(m.uci)} onKeyDown={(e) => e.key === 'Enter' && play(m.uci)}>
            <b className="mono" style={{ width: 56 }}>{m.san}</b>
            <span className="grow small">{m.games ? `${m.games} games · ${Math.round(m.score * 100)}% for the mover` : 'engine move'}{m.tags.length ? ' · ' : ''}{m.tags.map((t) => <span key={t} className={`badge ${t === 'mistake' || t === 'trap' ? 'warn' : 'neutral'}`} style={{ marginLeft: 4 }}>{t}</span>)}</span>
            <span className="mono small">{m.eval > 0 ? '+' : ''}{(m.eval / 100).toFixed(2)}</span>
          </div>
        ))}
      </Card>
      <Card title={`In your games (${mine.total})`}>
        {!mine.moves.length && <Empty>None of your saved games reached this position.</Empty>}
        {mine.moves.map((m) => (
          <div key={m.uci} className="list-item" role="button" tabIndex={0} onClick={() => play(m.uci)}>
            <b className="mono" style={{ width: 56 }}>{m.san}</b><span className="grow small">{m.games} game{m.games > 1 ? 's' : ''}</span><span className="small muted">{m.score === null ? '' : `you scored ${Math.round(m.score * 100)}%`}</span>
          </div>
        ))}
      </Card>
      <Card title="Named continuations" actions={<span className="muted small">local database, not popularity statistics</span>}>
        {!conts.length && <Empty>No book continuations from this position.</Empty>}
        <div className="list">
          {conts.map((c) => (
            <div key={c.uci} className="list-item" role="button" tabIndex={0} onClick={() => play(c.uci)} onKeyDown={(e) => e.key === 'Enter' && play(c.uci)}>
              <b className="mono" style={{ width: 56 }}>{c.san}</b><span className="grow small">{c.opening ? `${c.opening.eco} · ${c.opening.name}` : <span className="muted">continues to deeper book lines</span>}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title={`Opening database (${openingIndex().byKey.size} positions)`}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, ECO code or moves…" aria-label="Search openings" style={{ marginBottom: 8 }} />
        <div className="list scroll" style={{ maxHeight: 280 }}>
          {results.map((o) => {
            const ix = [...openingIndex().byKey.values()].find((x) => x.name === o.name && x.moves === o.moves);
            return (
              <div key={o.eco + o.name + o.moves} className="list-item" role="button" tabIndex={0} onClick={() => ix && loadLine(START_FEN, ix.uci)}>
                <span className="badge">{o.eco}</span><span className="grow">{o.name}</span><span className="mono small muted">{o.moves.split(' ').length} ply</span>
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Favourite openings">
        {!favs.length && <Empty>Star an opening to keep it here.</Empty>}
        <div className="list">
          {favs.map((f) => {
            const ix = [...openingIndex().byKey.values()].find((x) => x.name === f.name);
            return <div key={f.id} className="list-item" role="button" tabIndex={0} onClick={() => ix && loadLine(START_FEN, ix.uci)}><span className="badge">{f.eco}</span><span className="grow">{f.name}</span></div>;
          })}
        </div>
      </Card>
    </div>
  );
}
