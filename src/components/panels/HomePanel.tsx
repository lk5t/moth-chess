// Home (v3): the first screen. Engine status, quick analysis, recent games, continue training.
import { useState } from 'react';
import { useApp } from '../AppContext';
import { Card, EngineStatusBadge, Icon } from '../ui';
import { ProfilePicker, openExt } from '../shared';
import { useLiveQuery } from '@/memory/useLiveQuery';
import { db } from '@/memory/db';
import { recentItems, type RecentItem } from '@/memory/repo';
import { validateFen } from '@/chess/position';
import { DISCLAIMER } from '@/content/detector/sites';
import { markInstalledSeen, readUpdateState, updateAvailable, RELEASES_PAGE } from '@/updates/updates';
import { appVersion } from '../shared';

export function HomePanel() {
  const { analysis, settings, updateSettings, loadFen, loadPgn, setTab, toast } = useApp();
  const [paste, setPaste] = useState('');
  const recent = useLiveQuery<RecentItem[]>(() => recentItems(6), [], []);
  const stats = useLiveQuery(async () => {
    const d = db(), now = Date.now();
    const [games, reviews, due, total] = await Promise.all([d.games.count(), d.reviews.count(), d.exercises.where('dueAt').belowOrEqual(now).count(), d.exercises.count()]);
    return { games, reviews, due, total };
  }, [], { games: 0, reviews: 0, due: 0, total: 0 });

  const [upd, setUpd] = useState(0);
  const ust = useLiveQuery(() => readUpdateState(), [upd], {});
  const analysePaste = () => {
    const v = paste.trim();
    if (!v) { setTab('analysis'); return; }
    if (validateFen(v).ok) { loadFen(v); setTab('analysis'); }
    else if (/\d+\.\s*\S/.test(v) || v.startsWith('[')) { loadPgn(v); setTab('review'); }
    else { toast(`That is neither a FEN nor a PGN: ${validateFen(v).error}`); return; }
    setPaste('');
  };
  const openItem = async (it: RecentItem) => {
    if (it.kind === 'game') { const g = await db().games.get(it.id); if (g) { loadPgn(g.pgn, g.id); setTab('review'); } }
    else if (it.fen) { loadFen(it.fen); setTab('analysis'); }
  };

  return (
    <div className="home stack" style={{ gap: 16 }}>
      {ust.installed && !ust.installed.seen && ust.installed.from && (
        <div className="banner good" data-testid="updated-banner">
          <b>Updated to MOTH Chess {ust.installed.to}</b> (from {ust.installed.from}). Your settings, games and training data were kept.
          <a href="#" style={{ marginLeft: 8 }} onClick={(e) => { e.preventDefault(); openExt('control.html#changelog'); }}>What's new</a>
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={async () => { await markInstalledSeen(); setUpd((n) => n + 1); }}>Dismiss</button>
        </div>
      )}
      {updateAvailable(ust, appVersion()) && <div className="banner small">MOTH Chess {ust.latest} is available — <a href={ust.url ?? RELEASES_PAGE} target="_blank" rel="noreferrer">download it from GitHub</a>, replace the extension folder and press reload.</div>}
      <div className="status-grid">
        <button className="tile action" onClick={() => setTab('analysis')}>
          <span className="ic">{Icon.board}</span><b>Analyze a position</b><span className="small muted">Board with engine evaluation and best moves.</span>
        </button>
        <button className="tile action" onClick={() => setTab('review')}>
          <span className="ic">{Icon.review}</span><b>Review a game</b><span className="small muted">Paste a PGN — find mistakes, see accuracy and a report.</span>
        </button>
        <button className="tile action" onClick={() => setTab('coach')}>
          <span className="ic">{Icon.coach}</span><b>Train</b><span className="small muted">{stats.due ? `${stats.due} exercise${stats.due > 1 ? 's' : ''} due today.` : stats.total ? 'Nothing due — try a custom session.' : 'Exercises are made from your reviewed games.'}</span>
        </button>
        <button className="tile action" onClick={() => setTab('play')}>
          <span className="ic">{Icon.play}</span><b>Play MOTH</b><span className="small muted">Offline games at seven levels, with a review afterwards.</span>
        </button>
      </div>

      <Card title="Quick analysis">
        <div className="row">
          <input className="input mono" aria-label="FEN or PGN" placeholder="Paste a FEN or PGN — or leave empty for the starting position" value={paste} onChange={(e) => setPaste(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && analysePaste()} />
          <button className="btn primary" onClick={analysePaste}>Analyze</button>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Recent" actions={<button className="btn sm ghost" onClick={() => setTab('memory')}>Library</button>}>
          {!recent.length && <div className="empty">Nothing yet. Games you import, review or play appear here.</div>}
          {recent.map((r) => (
            <button key={`${r.kind}-${r.id}`} className="list-row" onClick={() => openItem(r)}>
              <span className="badge neutral">{r.kind}</span><span className="grow" style={{ textAlign: 'left' }}>{r.title || 'Untitled'}</span><span className="small muted">{new Date(r.at).toLocaleDateString()}</span>
            </button>
          ))}
        </Card>
        <Card title={<span className="row">Engine <EngineStatusBadge status={analysis.status} detail={analysis.statusDetail} /></span>}>
          <div className="seg" role="group" aria-label="Analysis engine" style={{ marginBottom: 8 }}>
            <button aria-pressed={settings.engine.kind === 'moth'} onClick={() => updateSettings({ engine: { kind: 'moth' } })}>MOTH Engine</button>
            <button aria-pressed={settings.engine.kind === 'stockfish'} onClick={() => updateSettings({ engine: { kind: 'stockfish' } })}>Stockfish</button>
          </div>
          <ProfilePicker settings={settings} update={updateSettings} />
          {analysis.status === 'error' && <button className="btn sm" style={{ marginTop: 8 }} onClick={analysis.retry}>Restart engine</button>}
          <div className="small muted" style={{ marginTop: 8 }}>{stats.games} saved game{stats.games === 1 ? '' : 's'} · {stats.reviews} review{stats.reviews === 1 ? '' : 's'} · <a href="#" onClick={(e) => { e.preventDefault(); openExt('control.html'); }}>System status</a></div>
        </Card>
      </div>
      <p className="small muted" role="note" style={{ margin: 0 }}>{DISCLAIMER}</p>
    </div>
  );
}
