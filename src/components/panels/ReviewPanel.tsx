import { useEffect, useRef, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty, Slider } from '../ui';
import { LineChart } from '../charts';
import { importPgnText, downloadText } from '@/memory/repo';
import { db } from '@/memory/db';
import { reviewFor, runReview } from '@/review/service';
import { annotatedPgn, countClasses } from '@/review/review';
import type { GameReview, SavedGame } from '@/types';
import { formatScore } from '@/engine/normalize';

export function ReviewPanel() {
  const { gameId, loadPgn, goto, cursor, settings, updateSettings, toast } = useApp();
  const [pgnText, setPgnText] = useState('');
  const [user, setUser] = useState(() => localStorage.getItem('moth.username') ?? '');
  const [game, setGame] = useState<SavedGame | null>(null);
  const [review, setReview] = useState<GameReview | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [recent, setRecent] = useState<SavedGame[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = async () => {
    setRecent(await db().games.orderBy('importedAt').reverse().limit(8).toArray());
    if (gameId) { setGame((await db().games.get(gameId)) ?? null); setReview((await reviewFor(gameId)) ?? null); }
    else { setGame(null); setReview(null); }
  };
  useEffect(() => { void refresh(); }, [gameId]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const doImport = async (text: string) => {
    try { localStorage.setItem('moth.username', user); } catch { /* storage may be unavailable */ }
    const r = await importPgnText(text, { userName: user || undefined });
    if (r.errors.length && !r.added.length && !r.duplicates) { toast(`Import failed: ${r.errors[0].message}`); return; }
    toast(`Imported ${r.added.length} game${r.added.length === 1 ? '' : 's'}${r.duplicates ? `, ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped` : ''}${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`);
    const first = r.added[0];
    if (first) { const g = await db().games.get(first); if (g) loadPgn(g.pgn, first, 0); }
    setPgnText('');
    await refresh();
  };

  const start = async () => {
    if (!gameId) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setProgress({ done: review?.evals?.length ?? 0, total: (game?.plyCount ?? 0) + 1 });
    try {
      const r = await runReview(gameId, settings.review.depth, { signal: ac.signal, onProgress: (done, total) => setProgress({ done, total }) });
      setReview(r);
      if (r.status === 'complete') {
        toast('Review complete');
        chrome.runtime?.sendMessage?.({ type: 'notify', title: 'MOTH Chess — review complete', message: r.summary?.[0] ?? 'Your game review is ready.' }).catch?.(() => {});
      } else toast('Review paused — you can resume it later');
    } catch (e) { toast(`Review failed: ${(e as Error).message}`); }
    finally { setProgress(null); abortRef.current = null; await refresh(); }
  };

  const winSeries = review?.moves.map((m) => (m.color === 'w' ? m.winAfter : 100 - m.winAfter)) ?? [];
  const cw = review ? countClasses(review.moves, 'w') : null;
  const cb = review ? countClasses(review.moves, 'b') : null;

  return (
    <div className="stack">
      <Card glow title="Game review">
        {!game && <Empty>Import a PGN below or open a game from Memory to review it.</Empty>}
        {game && (
          <div className="stack">
            <div className="row wrap">
              <b>{game.white}</b> – <b>{game.black}</b> <span className="badge neutral">{game.result}</span>
              {game.eco && <span className="badge">{game.eco} {game.openingName}</span>}
              <span className="muted small">{game.plyCount} plies{game.date ? ` · ${game.date}` : ''}</span>
            </div>
            <Slider label="Review depth" value={settings.review.depth} min={8} max={22} onChange={(v) => updateSettings({ review: { depth: v } })} hint="Higher is more accurate but slower. Each position is analysed on a background engine." />
            <div className="row wrap">
              {!progress && <button className="btn primary" onClick={start}>{review?.status === 'paused' ? '▶ Resume review' : review?.status === 'complete' ? '↻ Re-run review' : '▶ Review game'}</button>}
              {progress && <button className="btn danger" onClick={() => abortRef.current?.abort()}>■ Cancel (keeps progress)</button>}
              {review?.status === 'complete' && game && <button className="btn" onClick={() => downloadText(`moth-review-${game.id}.pgn`, annotatedPgn(review, game.headers, game.headers.FEN), 'application/x-chess-pgn')}>Export annotated PGN</button>}
            </div>
            {progress && (
              <div aria-live="polite">
                <div className="small muted">Analysing position {progress.done} of {progress.total}…</div>
                <div style={{ height: 6, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden' }}><div style={{ width: `${(progress.done / progress.total) * 100}%`, height: '100%', background: 'var(--accent-strong)', transition: 'width .2s' }} /></div>
              </div>
            )}
            {review?.status === 'paused' && !progress && <div className="banner warn">Review paused at {review.progressPly}/{review.totalPly} positions.</div>}
          </div>
        )}
      </Card>

      {review?.status === 'complete' && (
        <>
          <Card title="Evaluation timeline" actions={<span className="muted small">White's win probability · click to jump</span>}>
            <LineChart values={winSeries} min={0} max={100} mid={50} area height={130} current={cursor - 1} onPick={(i) => goto(i + 1)} marks={review.moves.map((m) => m.classification)} label="Evaluation timeline" />
          </Card>
          <div className="grid-2">
            {(['w', 'b'] as const).map((c) => {
              const cc = c === 'w' ? cw! : cb!;
              const acc = c === 'w' ? review.accuracyWhite : review.accuracyBlack;
              return (
                <Card key={c} title={c === 'w' ? game?.white ?? 'White' : game?.black ?? 'Black'}>
                  <div className="row"><span style={{ fontSize: 22, fontWeight: 800 }}>{acc ?? '—'}%</span><span className="muted small">est. accuracy</span></div>
                  <div className="row wrap small" style={{ marginTop: 6 }}>
                    <span className="badge bad">{cc.blunder} blunders</span><span className="badge warn">{cc.mistake} mistakes</span><span className="badge neutral">{cc.inaccuracy} inaccuracies</span><span className="badge good">{cc.best} best</span><span className="badge info">{cc.book} book</span>
                  </div>
                </Card>
              );
            })}
          </div>
          <Card title="Summary">
            <ul style={{ margin: 0, paddingLeft: 18 }} className="stack small">{review.summary?.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </Card>
          <Card title="Critical moments">
            {review.moves.filter((m) => ['blunder', 'mistake'].includes(m.classification)).length === 0 && <Empty>No mistakes or blunders found.</Empty>}
            {review.moves.filter((m) => ['blunder', 'mistake', 'inaccuracy'].includes(m.classification)).map((m) => (
              <div key={m.ply} className="list-item" role="button" tabIndex={0} onClick={() => goto(m.ply - 1)} title="Show the position before the move">
                <span className={`cls-${m.classification} mono`}>{Math.ceil(m.ply / 2)}{m.color === 'w' ? '.' : '…'}{m.san}</span>
                <span className="badge neutral">{m.classification}</span>
                <span className="grow small muted">{formatScore(m.evalBefore)} → {formatScore(m.evalAfter)}{m.bestMoveSan ? ` · best ${m.bestMoveSan}` : ''}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      <Card title="Import PGN">
        <label className="label" htmlFor="moth-user">Your username (optional — lets Coach focus on your moves)</label>
        <input id="moth-user" className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="e.g. MagnusFan99" style={{ marginBottom: 8 }} />
        <textarea className="textarea" rows={5} value={pgnText} onChange={(e) => setPgnText(e.target.value)} placeholder='[Event "..."]&#10;1. e4 e5 2. Nf3 ...' aria-label="PGN text" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={!pgnText.trim()} onClick={() => doImport(pgnText)}>Import</button>
          <label className="btn">Open .pgn file<input type="file" accept=".pgn,text/plain" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) await doImport(await f.text()); e.target.value = ''; }} /></label>
        </div>
      </Card>
      <Card title="Recent games">
        {!recent.length && <Empty>No games imported yet.</Empty>}
        <div className="list">
          {recent.map((g) => (
            <div key={g.id} className={`list-item ${g.id === gameId ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => loadPgn(g.pgn, g.id, 0)}>
              <span className="grow">{g.white} – {g.black}</span><span className="badge neutral">{g.result}</span>{g.reviewId && <span className="badge good">reviewed</span>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
