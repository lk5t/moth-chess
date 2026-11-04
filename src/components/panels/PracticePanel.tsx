// Train → Practice (3.0): adaptive training. Recommendations come from Player DNA and what is due;
// endgame drills adapt their level; opening repertoire lines are drilled with spaced repetition.
import { useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty } from '../ui';
import { Board } from '../Board';
import { useLiveQuery } from '@/memory/useLiveQuery';
import { db, type RepertoireLine } from '@/memory/db';
import { endgameLevel, loadDna, logTraining, recommend, repertoireQuestions, scheduleRepertoire, type Recommendation } from '@/training/adaptive';
import { ENDGAME_DRILLS } from '@/endgame/endgame';
import { applyMove, START_FEN } from '@/chess/position';

export function PracticePanel() {
  const { setTab, toast } = useApp();
  const [tick, setTick] = useState(0);
  const data = useLiveQuery(async () => {
    const d = db(), now = Date.now();
    const [dna, log, dueEx, rep] = await Promise.all([loadDna(), d.trainingLog.orderBy('at').reverse().limit(200).toArray(), d.exercises.where('dueAt').belowOrEqual(now).count(), d.repertoire.toArray()]);
    const dueRep = rep.filter((r) => r.dueAt <= now);
    return { dna, log, recs: recommend(dna, { exercises: dueEx, repertoire: dueRep.length }, log), dueRep, rep };
  }, [tick], null);
  const [drill, setDrill] = useState<RepertoireLine | null>(null);
  const refresh = () => setTick((t) => t + 1);

  const go = (r: Recommendation) => {
    if (r.kind === 'exercises') setTab('coach');
    else if (r.kind === 'review') setTab('memory');
    else if (r.kind === 'play') setTab('play');
    else if (r.kind === 'endgame' && r.target) startDrill(r.target);
    else if (r.kind === 'repertoire' && data?.dueRep[0]) setDrill(data.dueRep[0]);
  };
  const startDrill = (id: string) => { try { sessionStorage.setItem('moth.play.drill', id); } catch { /* */ } setTab('play'); };

  if (!data) return <Empty>Loading your training plan…</Empty>;
  if (drill) return <RepertoireDrill line={drill} onDone={async (ok) => { await db().repertoire.update(drill.id!, scheduleRepertoire(drill, ok)); await logTraining({ at: Date.now(), kind: 'repertoire', itemId: drill.key, success: ok }); toast(ok ? 'Line played perfectly' : 'Line scheduled again soon'); setDrill(null); refresh(); }} />;
  const level = endgameLevel(data.log);
  const solved = new Set(data.log.filter((l) => l.kind === 'endgame' && l.success).map((l) => l.itemId));
  return (
    <div className="stack">
      <Card glow title="Recommended next">
        {!data.recs.length && <Empty>All caught up. Import or play more games to get new personal training.</Empty>}
        {data.recs.map((r, i) => (
          <div key={i} className="row" style={{ padding: '6px 0', borderTop: i ? '1px solid var(--line)' : undefined }}>
            <div className="grow"><b>{r.title}</b><div className="small muted">{r.why}</div></div>
            <button className={`btn sm ${i === 0 ? 'primary' : ''}`} onClick={() => go(r)}>Start</button>
          </div>
        ))}
      </Card>
      <Card title={<span className="row">Endgame drills<span className="badge neutral">your level: {'★'.repeat(level)}</span></span>}>
        <div className="small muted" style={{ marginBottom: 6 }}>Play the position against MOTH. Two successes in a row raise your level; two misses lower it.</div>
        {ENDGAME_DRILLS.map((d) => (
          <div key={d.id} className="row small" style={{ padding: '4px 0' }}>
            <span className="badge neutral">{'★'.repeat(d.level)}</span>
            <span className="grow">{d.title} <span className="muted">— {d.side === 'w' ? 'White' : 'Black'} to {d.goal}</span></span>
            {solved.has(d.id) && <span className="badge good">solved</span>}
            <button className="btn sm" onClick={() => startDrill(d.id)}>Play</button>
          </div>
        ))}
      </Card>
      <Card title={`Opening repertoire (${data.rep.length})`} actions={<button className="btn sm ghost" onClick={() => setTab('openings')}>Add lines in Openings</button>}>
        {!data.rep.length && <Empty>Save lines from Analyze → Openings (“Add to repertoire”), then drill them here.</Empty>}
        {data.rep.slice(0, 12).map((r) => (
          <div key={r.id} className="row small" style={{ padding: '4px 0' }}>
            <span className="badge neutral">{r.color === 'w' ? 'White' : 'Black'}</span><span className="grow">{r.name}</span>
            <span className="muted">{r.drilled ? `${Math.round((r.correct / r.drilled) * 100)}% of ${r.drilled}` : 'new'}{r.dueAt <= Date.now() ? ' · due' : ''}</span>
            <button className="btn sm" onClick={() => setDrill(r)}>Drill</button>
            <button className="btn sm ghost" aria-label={`Remove ${r.name}`} onClick={async () => { await db().repertoire.delete(r.id!); refresh(); }}>×</button>
          </div>
        ))}
      </Card>
      <Card title="Training history">
        {!data.log.length && <Empty>No training yet.</Empty>}
        {data.log.slice(0, 12).map((l) => (
          <div key={l.id} className="row small"><span className={`badge ${l.success ? 'good' : 'warn'}`}>{l.success ? 'done' : 'retry'}</span><span className="grow">{l.kind} · {ENDGAME_DRILLS.find((d) => d.id === l.itemId)?.title ?? l.itemId}</span><span className="muted">{new Date(l.at).toLocaleDateString()}</span></div>
        ))}
      </Card>
    </div>
  );
}

function RepertoireDrill({ line, onDone }: { line: RepertoireLine; onDone: (ok: boolean) => void }) {
  const qs = useMemo(() => repertoireQuestions(line), [line]);
  const fens = useMemo(() => { const out = [START_FEN]; let f = START_FEN; for (const u of line.uci) { const r = applyMove(f, u); if (!r) break; f = r.fenAfter; out.push(f); } return out; }, [line]);
  const [qi, setQi] = useState(0);
  const [mistakes, setMistakes] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const ply = qs[qi];
  const done = qi >= qs.length;
  return (
    <Card glow title={<span className="row">Repertoire drill: {line.name}<span className="badge neutral">{line.color === 'w' ? 'White' : 'Black'}</span></span>}>
      <div style={{ maxWidth: 420 }}>
        <Board fen={done ? fens[fens.length - 1] : fens[ply]} orientation={line.color === 'w' ? 'white' : 'black'} interactive={!done} ariaLabel="Repertoire drill board"
          onMove={(uci) => {
            if (done) return false;
            const want = line.uci[ply];
            if (uci === want || uci.slice(0, 4) === want.slice(0, 4)) { setMsg('Correct'); setQi(qi + 1); return true; }
            setMistakes((m) => m + 1);
            setMsg(`Not your repertoire move — it is ${applyMove(fens[ply], want)?.san ?? want}. Try again.`);
            return false;
          }} />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="grow small" aria-live="polite">{done ? `Finished with ${mistakes} mistake${mistakes === 1 ? '' : 's'}.` : msg ?? `Your move ${qi + 1} of ${qs.length}`}</span>
        {done ? <button className="btn primary" onClick={() => onDone(mistakes === 0)}>Save result</button> : <button className="btn sm ghost" onClick={() => onDone(false)}>Stop</button>}
      </div>
    </Card>
  );
}
