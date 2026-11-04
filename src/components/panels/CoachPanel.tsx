import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty, Select, Stat } from '../ui';
import { Board } from '../Board';
import { db } from '@/memory/db';
import { analyseWeaknesses, checkExerciseMove, dailySession, exercisesFromReview, scheduleAfterAttempt, type MoveCheck, type WeaknessReport } from '@/coach/coach';
import { queuedEvaluate } from '@/engine/queue';
import { applyMove } from '@/chess/position';
import { toCp } from '@/engine/normalize';
import type { Color, ExerciseCategory, TrainingExercise } from '@/types';

const CATS: { value: ExerciseCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All categories' }, { value: 'tactic', label: 'Tactics' }, { value: 'opening', label: 'Opening' }, { value: 'middlegame', label: 'Middlegame' },
  { value: 'endgame', label: 'Endgame' }, { value: 'missed-win', label: 'Missed wins' }, { value: 'defence', label: 'Defence' },
];

export function CoachPanel({ compact }: { compact?: boolean }) {
  const { settings, toast, openFull } = useApp();
  const [report, setReport] = useState<WeaknessReport | null>(null);
  const [exercises, setExercises] = useState<TrainingExercise[]>([]);
  const [cat, setCat] = useState<ExerciseCategory | 'all'>('all');
  const [session, setSession] = useState<TrainingExercise[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [feedback, setFeedback] = useState<(MoveCheck & { fenAfter?: string }) | null>(null);
  const [checking, setChecking] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [history, setHistory] = useState<{ at: number; correct: boolean }[]>([]);

  const load = async () => {
    const d = db();
    const [reviews, exs, attempts, games] = await Promise.all([d.reviews.toArray(), d.exercises.toArray(), d.attempts.toArray(), d.games.toArray()]);
    const colors = new Map<number, Color | undefined>(games.map((g) => [g.id!, g.userColor]));
    setExercises(exs);
    setReport(analyseWeaknesses(reviews, exs, attempts, colors));
    setHistory(attempts.slice(-200).map((a) => ({ at: a.at, correct: a.correct })));
  };
  useEffect(() => { void load(); }, []);

  const regenerate = async () => {
    const d = db();
    const [reviews, games] = await Promise.all([d.reviews.where('status').equals('complete').toArray(), d.games.toArray()]);
    const byId = new Map(games.map((g) => [g.id!, g]));
    let added = 0;
    for (const r of reviews) {
      for (const ex of exercisesFromReview(r, { userColor: byId.get(r.gameId)?.userColor, gameId: r.gameId })) {
        if (!(await d.exercises.where('contentHash').equals(ex.contentHash).count())) { await d.exercises.add(ex); added++; }
      }
    }
    toast(added ? `Generated ${added} new exercise${added === 1 ? '' : 's'}` : 'No new exercises — review more games to create some');
    await load();
  };

  const startSession = (kind: 'daily' | 'all') => {
    const pool = cat === 'all' ? exercises : exercises.filter((e) => e.category === cat);
    const s = kind === 'daily' ? dailySession(pool, { size: 10 }) : [...pool].sort(() => Math.random() - 0.5).slice(0, 15);
    if (!s.length) { toast(kind === 'daily' ? 'Nothing due right now — great job, or try a custom session' : 'No exercises in this category yet'); return; }
    setSession(s); setIdx(0); setFeedback(null); setStartedAt(Date.now());
  };

  const ex = session?.[idx];
  const attempt = async (uci: string) => {
    if (!ex || feedback) return false;
    setChecking(true);
    let altLoss: number | undefined;
    try {
      if (uci !== ex.solutionUci) {
        const rec = applyMove(ex.fen, uci);
        if (rec) {
          // quick engine check so a near-equal alternative isn't marked wrong
          const [best, after] = await Promise.all([queuedEvaluate(ex.fen, 12, 1), queuedEvaluate(rec.fenAfter, 12, 1)]);
          const bestCp = best.lines[0] ? toCp(best.lines[0].score) : undefined;
          const afterCp = after.lines[0] ? -toCp(after.lines[0].score) : undefined; // opponent's view → mover's view
          if (bestCp !== undefined && afterCp !== undefined) altLoss = Math.max(0, bestCp - afterCp);
        }
      }
    } catch { /* engine unavailable → strict check */ }
    const res = checkExerciseMove(ex, uci, altLoss);
    setChecking(false);
    if (res.result === 'illegal') { toast(res.feedback); return false; }
    const correct = res.result === 'correct' || res.result === 'alternative';
    setFeedback({ ...res, fenAfter: applyMove(ex.fen, uci)?.fenAfter });
    const d = db();
    await d.attempts.add({ exerciseId: ex.id!, at: Date.now(), correct, movePlayedUci: uci, timeMs: Date.now() - startedAt, category: ex.category, motifs: ex.motifs });
    await d.exercises.update(ex.id!, scheduleAfterAttempt(ex, correct));
    return true;
  };
  const next = () => {
    if (!session) return;
    if (idx + 1 >= session.length) { setSession(null); toast('Session complete'); void load(); return; }
    setIdx(idx + 1); setFeedback(null); setStartedAt(Date.now());
  };

  const due = useMemo(() => dailySession(exercises, { size: 1000 }).length, [exercises]);
  const solveRate = history.length ? Math.round((history.filter((h) => h.correct).length / history.length) * 100) : null;

  if (ex) {
    const orientation = ex.fen.split(' ')[1] === 'w' ? 'white' : 'black';
    return (
      <div className="stack">
        <Card glow title={<span className="row">Exercise {idx + 1}/{session!.length} <span className="badge">{ex.category}</span>{ex.motifs.map((m) => <span key={m} className="badge neutral">{m}</span>)}</span>}
          actions={<button className="btn sm ghost" onClick={() => setSession(null)}>End session</button>}>
          <p style={{ marginTop: 0 }}><b>{ex.fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move.</b> Find the strongest move{ex.playedSan ? ` (in your game ${ex.playedSan} was played)` : ''}.</p>
          <div style={{ maxWidth: compact ? 320 : 460 }}>
            <Board fen={feedback?.fenAfter ?? ex.fen} orientation={orientation} interactive={!feedback && !checking} onMove={(u) => { void attempt(u); return true; }} ariaLabel="Practice board" />
          </div>
          {checking && <div className="small muted" style={{ marginTop: 6 }}>Checking with the engine…</div>}
          {feedback && (
            <div className={`banner ${feedback.result === 'incorrect' ? 'bad' : 'good'}`} style={{ marginTop: 8 }}>
              <b>{feedback.result === 'correct' ? 'Correct!' : feedback.result === 'alternative' ? 'Good alternative.' : 'Not quite.'}</b> {feedback.feedback}
              {feedback.result === 'incorrect' && <div style={{ marginTop: 4 }}>Solution: <b>{ex.solutionSan}</b>. {ex.explanation}</div>}
            </div>
          )}
          {feedback && <div className="row" style={{ marginTop: 8 }}><button className="btn primary" onClick={next}>{idx + 1 >= session!.length ? 'Finish' : 'Next exercise →'}</button></div>}
        </Card>
      </div>
    );
  }

  return (
    <div className="stack">
      <Card glow title="MOTH Coach">
        <div className="grid-3">
          <Stat label="Exercises" value={exercises.length} />
          <Stat label="Due now" value={due} />
          <Stat label="Solve rate" value={solveRate === null ? '—' : `${solveRate}%`} low={history.length > 0 && history.length < 5} hint={history.length ? `${history.length} attempts` : undefined} />
        </div>
        <div className="row wrap" style={{ marginTop: 10 }}>
          {compact ? <button className="btn primary" onClick={() => openFull?.({ tab: 'coach' })}>Open training on the full board</button> : <>
            <div style={{ width: 170 }}><Select value={cat} options={CATS} onChange={setCat} /></div>
            <button className="btn primary" onClick={() => startSession('daily')}>Daily session</button>
            <button className="btn" onClick={() => startSession('all')}>Custom session</button>
            <button className="btn ghost" onClick={regenerate}>Regenerate from reviews</button>
          </>}
        </div>
      </Card>
      {report && (
        <>
          <Card title="What your games say">
            {!report.sufficientData && <div className="banner warn">{report.recommendations[0]}</div>}
            {report.sufficientData && (
              <ul style={{ margin: 0, paddingLeft: 18 }} className="stack small">
                {report.recurring.map((r, i) => <li key={i}>{r}</li>)}
                {!report.recurring.length && <li>No recurring pattern reaches the minimum sample size yet.</li>}
              </ul>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>Based on {report.gamesReviewed} reviewed game{report.gamesReviewed === 1 ? '' : 's'} and {report.mistakesAnalysed} mistakes/blunders. Patterns need at least 3 occurrences before MOTH reports them.</p>
          </Card>
          {settings.intelligence.coachingRecommendations && report.sufficientData && (
            <Card title="Recommended training">
              <ul style={{ margin: 0, paddingLeft: 18 }} className="stack small">{report.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </Card>
          )}
          {!compact && (
            <div className="grid-2">
              <Card title="Mistakes by phase">
                {report.byPhase.map((p) => <div key={p.phase} className="row small"><span className="grow">{p.phase}</span><span className="mono">{p.count}</span><span className="muted">avg −{p.avgLoss.toFixed(0)}%</span></div>)}
              </Card>
              <Card title="Missed motifs">
                {!report.byMotif.length && <Empty>Review games to see motifs.</Empty>}
                {report.byMotif.slice(0, 8).map((m) => <div key={m.motif} className="row small"><span className="grow">{m.motif}</span><span className="mono">{m.count}</span></div>)}
              </Card>
            </div>
          )}
          {report.trend && <Card title="Improvement trend"><div className="small">Accuracy in earlier reviews: <b>{report.trend.earlierAccuracy.toFixed(1)}%</b> → recent: <b>{report.trend.recentAccuracy.toFixed(1)}%</b> ({report.trend.n} games).</div></Card>}
        </>
      )}
    </div>
  );
}
