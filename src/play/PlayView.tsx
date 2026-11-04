// Play against MOTH: offline games with clocks, styles, levels, takebacks, resign, save & review.
// MOTH's moves come from the real engine (dedicated worker, UCI move requests, pondering).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from '@/components/Board';
import { MoveList } from '@/components/MoveList';
import { useApp } from '@/components/AppContext';
import { applyMove, gameStatus, START_FEN } from '@/chess/position';
import type { MoveRecord, Orientation } from '@/types';
import { MothPlayClient, type Clock } from './client';
import { analyseUserMoves, buildProfile, practiceGames, preparation, savePractice } from './adaptation';
import { importPgnText } from '@/memory/repo';
import { recogniseOpening } from '@/openings/eco';
import { getBatchEngine } from '@/engine/worker-transport';
import { formatScore } from '@/engine/normalize';
import { toWhite } from '@/engine/normalize';

const LEVELS = [
  { id: 1, name: 'Beginner', skill: 0, movetime: 60 },
  { id: 2, name: 'Novice', skill: 3, movetime: 80 },
  { id: 3, name: 'Casual', skill: 6, movetime: 100 },
  { id: 4, name: 'Club', skill: 10, movetime: 100 },
  { id: 5, name: 'Strong', skill: 14, movetime: 150 },
  { id: 6, name: 'Expert', skill: 17, movetime: 300 },
  { id: 7, name: 'Maximum', skill: 20, movetime: 1000 },
];
const CLOCKS = [
  { id: 'none', label: 'No clock', base: 0, inc: 0 },
  { id: '1+0', label: '1 + 0', base: 60_000, inc: 0 },
  { id: '3+2', label: '3 + 2', base: 180_000, inc: 2000 },
  { id: '5+3', label: '5 + 3', base: 300_000, inc: 3000 },
  { id: '10+5', label: '10 + 5', base: 600_000, inc: 5000 },
  { id: '15+10', label: '15 + 10', base: 900_000, inc: 10_000 },
];
type Style = 'aggressive' | 'balanced' | 'defensive';
type Phase = 'setup' | 'playing' | 'over';

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return ms < 10_000 ? `${Math.floor(ms / 1000)}.${Math.floor((ms % 1000) / 100)}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function PlayView() {
  const app = useApp();
  const { settings } = app;
  const [phase, setPhase] = useState<Phase>('setup');
  const [color, setColor] = useState<'w' | 'b' | 'random'>('w');
  const [userColor, setUserColor] = useState<'w' | 'b'>('w');
  const [style, setStyle] = useState<Style>(settings.moth.style);
  const [level, setLevel] = useState(4);
  const [clockId, setClockId] = useState('5+3');
  const [allowUndo, setAllowUndo] = useState(true);
  const [moves, setMoves] = useState<MoveRecord[]>([]);
  const [clock, setClock] = useState<{ w: number; b: number } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState<{ result: '1-0' | '0-1' | '1/2-1/2'; reason: string } | null>(null);
  const [info, setInfo] = useState<string>('');
  const [savedId, setSavedId] = useState<number | null>(null);
  const [lastLatency, setLastLatency] = useState<{ ms: number; source: string } | null>(null);
  const [adapting, setAdapting] = useState(false);
  const client = useRef<MothPlayClient | null>(null);
  const turnStart = useRef(0);
  const gameToken = useRef(0);

  const lv = LEVELS.find((l) => l.id === level)!;
  const tc = CLOCKS.find((c) => c.id === clockId)!;
  const fen = moves.length ? moves[moves.length - 1].fenAfter : START_FEN;
  const history = useMemo(() => [START_FEN, ...moves.map((m) => m.fenAfter)].slice(0, -1), [moves]);
  const status = useMemo(() => gameStatus(fen, history), [fen, history]);
  const turn = fen.split(' ')[1] as 'w' | 'b';
  const orientation: Orientation = userColor === 'w' ? 'white' : 'black';
  const mothName = `MOTH Engine (${style[0].toUpperCase() + style.slice(1)}, ${lv.name})`;

  useEffect(() => () => { client.current?.terminate(); }, []);

  // ---- clocks ----
  useEffect(() => {
    if (phase !== 'playing' || !clock) return;
    const t = setInterval(() => {
      setClock((c) => {
        if (!c) return c;
        const now = performance.now();
        const spent = now - turnStart.current;
        turnStart.current = now;
        const next = { ...c, [turn]: c[turn] - spent };
        if (next[turn] <= 0) {
          next[turn] = 0;
          const opp = turn === 'w' ? 'b' : 'w';
          // flag: loss on time unless the opponent cannot possibly mate
          const pieces = fen.split(' ')[0];
          const oppMaterial = opp === 'w' ? pieces.replace(/[^PNBRQ]/g, '') : pieces.replace(/[^pnbrq]/g, '');
          const canMate = /[PRQprq]/.test(oppMaterial) || oppMaterial.length >= 2;
          finish(canMate ? (turn === 'w' ? '0-1' : '1-0') : '1/2-1/2', canMate ? `${turn === 'w' ? 'White' : 'Black'} lost on time` : 'timeout vs insufficient material');
        }
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, [phase, turn, clock === null, fen]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = useCallback((res: '1-0' | '0-1' | '1/2-1/2', reason: string) => {
    gameToken.current++;
    void client.current?.cancelPonder();
    setThinking(false);
    setResult({ result: res, reason });
    setPhase('over');
  }, []);

  useEffect(() => {
    if (phase === 'playing' && status.over) {
      const res = status.checkmate ? (status.winner === 'w' ? '1-0' : '0-1') : '1/2-1/2';
      finish(res, status.checkmate ? 'checkmate' : (status.reason ?? 'draw').replace(/-/g, ' '));
    }
  }, [phase, status, finish]);

  // ---- MOTH's turn ----
  const mothMove = useCallback(async (mv: MoveRecord[], clk: { w: number; b: number } | null) => {
    const token = gameToken.current;
    const c = client.current!;
    setThinking(true);
    const uci = mv.map((m) => m.uci);
    const clockArg: Clock | null = clk ? { wtime: clk.w, btime: clk.b, winc: tc.inc, binc: tc.inc } : null;
    const r = await c.requestMove(START_FEN, uci, clockArg, lv.movetime);
    if (token !== gameToken.current) return; // game ended / restarted meanwhile
    const cur = mv.length ? mv[mv.length - 1].fenAfter : START_FEN;
    const rec = applyMove(cur, r.best);
    setThinking(false);
    if (!rec) { setInfo('MOTH returned no legal move'); return; }
    setLastLatency({ ms: r.ms, source: r.source });
    const stm = cur.split(' ')[1] as 'w' | 'b';
    const score = r.mate !== undefined ? toWhite({ type: 'mate', value: r.mate }, stm) : r.scoreCp !== undefined ? toWhite({ type: 'cp', value: r.scoreCp }, stm) : undefined;
    setInfo(`${r.book ? `Book: ${r.book}` : r.source === 'ponder' ? 'Predicted your move (pondering)' : r.source === 'cache' ? 'Prepared reply' : `Searched${r.depth ? ` to depth ${r.depth}` : ''}`}${score ? ` · eval ${formatScore(score)}` : ''}`);
    const next = [...mv, rec];
    setMoves(next);
    if (clk) {
      setClock((cc) => (cc ? { ...cc, [stm]: cc[stm] - 0 + tc.inc } : cc));
    }
    turnStart.current = performance.now();
    // predictive pondering on the user's time (only MOTH's own offline game)
    if (settings.moth.ponder && r.ponder && !gameStatus(rec.fenAfter).over) {
      const nextClock = clk ? { wtime: clk.w, btime: clk.b, winc: tc.inc, binc: tc.inc } : null;
      c.startPonder(START_FEN, [...next.map((m) => m.uci), r.ponder], nextClock, lv.movetime);
    }
  }, [lv.movetime, tc.inc, settings.moth.ponder]);

  const start = async () => {
    const uc = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    gameToken.current++;
    client.current?.terminate();
    const prep = settings.moth.learning ? preparation(await practiceGames()) : '';
    client.current = new MothPlayClient({ style, skill: lv.skill, model: settings.moth.model, ownBook: settings.moth.ownBook, prepare: prep });
    await client.current.newGame();
    setUserColor(uc); setMoves([]); setResult(null); setSavedId(null); setInfo(''); setLastLatency(null);
    const clk = tc.base ? { w: tc.base, b: tc.base } : null;
    setClock(clk);
    setPhase('playing');
    turnStart.current = performance.now();
    if (uc === 'b') void mothMove([], clk);
  };

  const onUserMove = (uci: string): boolean => {
    if (phase !== 'playing' || turn !== userColor || thinking) return false;
    const rec = applyMove(fen, uci);
    if (!rec) return false;
    const next = [...moves, rec];
    let clk = clock;
    if (clock) {
      const spent = performance.now() - turnStart.current;
      clk = { ...clock, [userColor]: clock[userColor] - spent + tc.inc };
      setClock(clk);
    }
    turnStart.current = performance.now();
    setMoves(next);
    if (!gameStatus(rec.fenAfter, [...history, fen]).over) void mothMove(next, clk);
    return true;
  };

  const undo = async () => {
    if (!allowUndo || thinking || phase !== 'playing') return;
    await client.current?.cancelPonder();
    // take back the user's last move and MOTH's reply
    const back = turn === userColor ? 2 : 1;
    setMoves((m) => m.slice(0, Math.max(0, m.length - back)));
  };

  const resign = () => finish(userColor === 'w' ? '0-1' : '1-0', `${userColor === 'w' ? 'White' : 'Black'} resigned`);

  const pgn = useMemo(() => {
    const h: Record<string, string> = {
      Event: 'MOTH Practice', Site: 'MOTH Chess (offline)', Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      White: userColor === 'w' ? 'You' : mothName, Black: userColor === 'b' ? 'You' : mothName,
      Result: result?.result ?? '*', TimeControl: tc.base ? `${tc.base / 1000}+${tc.inc / 1000}` : '-', Termination: result?.reason ?? '',
    };
    const head = Object.entries(h).map(([k, v]) => `[${k} "${v}"]`).join('\n');
    const body = moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m.san}` : m.san)).join(' ');
    return `${head}\n\n${body} ${result?.result ?? '*'}`;
  }, [moves, result, userColor, mothName, tc]);

  // when the game ends: save to Memory, then (if learning is on) analyse it for personal adaptation
  useEffect(() => {
    if (phase !== 'over' || !result || savedId !== null || moves.length < 2) return;
    let cancelled = false;
    (async () => {
      const rep = await importPgnText(pgn, { userName: 'You', tags: ['practice', 'vs-moth'] });
      const id = rep.added[0] ?? null;
      if (cancelled) return;
      setSavedId(id ?? -1);
      if (!settings.moth.learning) return;
      setAdapting(true);
      try {
        const uci = moves.map((m) => m.uci);
        const userMoves = await analyseUserMoves(getBatchEngine('moth', { Style: 'Balanced', EvalFile: settings.moth.model }), uci, userColor, 9);
        const op = recogniseOpening([START_FEN, ...moves.map((m) => m.fenAfter)]).opening;
        await savePractice({ gameId: id ?? undefined, at: Date.now(), userColor, style, level, timeControl: tc.id, result: result.result, reason: result.reason, uci, openingKey: uci.slice(0, 8).join(' '), openingName: op?.name, eco: op?.eco, userMoves });
        const prof = buildProfile(await practiceGames());
        if (!cancelled) app.toast(`Saved to Memory · personal profile updated (${prof.games} practice game${prof.games === 1 ? '' : 's'})`);
      } finally { if (!cancelled) setAdapting(false); }
    })();
    return () => { cancelled = true; };
  }, [phase, result]); // eslint-disable-line react-hooks/exhaustive-deps

  const userClock = clock?.[userColor], mothClock = clock?.[userColor === 'w' ? 'b' : 'w'];
  return (
    <div className="play-view" style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 640px) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
      <div className="stack">
        <div className="row card" style={{ padding: '8px 12px' }} aria-label="MOTH clock">
          <b className="grow">{mothName}</b>
          {thinking && <span className="badge" aria-live="polite">thinking…</span>}
          {clock && <span className={`clock mono ${turn !== userColor && phase === 'playing' ? 'running' : ''}`} data-testid="moth-clock">{fmtClock(mothClock!)}</span>}
        </div>
        <Board fen={fen} orientation={orientation} onMove={onUserMove} interactive={phase === 'playing' && turn === userColor && !thinking}
          lastMove={moves.length ? [moves[moves.length - 1].from, moves[moves.length - 1].to] : undefined} ariaLabel="Play board" />
        <div className="row card" style={{ padding: '8px 12px' }} aria-label="Your clock">
          <b className="grow">You ({userColor === 'w' ? 'White' : 'Black'})</b>
          {clock && <span className={`clock mono ${turn === userColor && phase === 'playing' ? 'running' : ''}`} data-testid="user-clock">{fmtClock(userClock!)}</span>}
        </div>
      </div>
      <div className="stack">
        {phase === 'setup' && (
          <div className="card stack" aria-label="New game setup">
            <h2 style={{ margin: 0 }}>Play against MOTH</h2>
            <p className="small muted" style={{ margin: 0 }}>Offline practice against the MOTH Engine. Nothing leaves your device.</p>
            <label className="label">Your colour</label>
            <div className="row">
              {(['w', 'b', 'random'] as const).map((c) => <button key={c} className={`btn ${color === c ? 'primary' : ''}`} aria-pressed={color === c} onClick={() => setColor(c)}>{c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}</button>)}
            </div>
            <label className="label">Style</label>
            <div className="row">
              {(['aggressive', 'balanced', 'defensive'] as const).map((s) => <button key={s} className={`btn ${style === s ? 'primary' : ''}`} aria-pressed={style === s} onClick={() => setStyle(s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}
            </div>
            <label className="label" htmlFor="moth-level">Difficulty: {lv.name}</label>
            <input id="moth-level" type="range" min={1} max={7} value={level} onChange={(e) => setLevel(Number(e.target.value))} aria-valuetext={lv.name} />
            <label className="label" htmlFor="moth-clock-sel">Clock</label>
            <select id="moth-clock-sel" className="input" value={clockId} onChange={(e) => setClockId(e.target.value)}>
              {CLOCKS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <label className="row small"><input type="checkbox" checked={allowUndo} onChange={(e) => setAllowUndo(e.target.checked)} /> Allow takebacks</label>
            <button className="btn primary" onClick={() => void start()}>Start game</button>
          </div>
        )}
        {phase !== 'setup' && (
          <div className="card stack">
            <div className="row wrap">
              <button className="btn" onClick={() => void undo()} disabled={!allowUndo || phase !== 'playing' || thinking || moves.length < (userColor === 'w' ? 1 : 2)}>Take back</button>
              <button className="btn danger" onClick={resign} disabled={phase !== 'playing'}>Resign</button>
              <button className="btn" onClick={() => { client.current?.terminate(); client.current = null; setPhase('setup'); }}>New game</button>
              {phase === 'over' && <button className="btn primary" disabled={!savedId || savedId < 0} onClick={() => { app.loadPgn(pgn, savedId ?? undefined); app.setTab('review'); }}>Review game</button>}
            </div>
            {info && <div className="small muted" aria-live="polite">{info}</div>}
            {lastLatency && <div className="small muted">MOTH answered in <b data-testid="latency">{lastLatency.ms.toFixed(1)} ms</b> ({lastLatency.source})</div>}
            {phase === 'over' && result && (
              <div className="banner" role="status"><b>{result.result === '1/2-1/2' ? 'Draw' : (result.result === '1-0') === (userColor === 'w') ? 'You won' : 'MOTH won'}</b> · {result.reason}{savedId && savedId > 0 ? ' · saved to Memory' : ''}{adapting ? ' · analysing for your profile…' : ''}</div>
            )}
            {status.check && phase === 'playing' && <span className="badge warn">Check</span>}
          </div>
        )}
        {phase !== 'setup' && (
          <div className="card" style={{ padding: 10 }}>
            <MoveList moves={moves} cursor={moves.length} onGoto={() => {}} startFen={START_FEN} />
          </div>
        )}
      </div>
    </div>
  );
}
