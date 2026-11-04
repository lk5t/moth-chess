import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppContext, type AppCtx, type TabId } from '@/components/AppContext';
import { useSettings } from '@/settings/useSettings';
import { useAnalysis, arrowsFromResult } from '@/components/useAnalysis';
import { useGame } from './useGame';
import { Board } from '@/components/Board';
import { EvalBar } from '@/components/charts';
import { MoveList } from '@/components/MoveList';
import { Icon, useThemeRoot } from '@/components/ui';
import { AnalysisPanel } from '@/components/panels/AnalysisPanel';
import { IntelligencePanel } from '@/components/panels/IntelligencePanel';
import { ThreatPanel } from '@/components/panels/ThreatPanel';
import { NeuralMapPanel } from '@/components/panels/NeuralMapPanel';
import { WhatIfPanel } from '@/components/panels/WhatIfPanel';
import { ReviewPanel } from '@/components/panels/ReviewPanel';
import { OpeningsPanel } from '@/components/panels/OpeningsPanel';
import { CoachPanel } from '@/components/panels/CoachPanel';
import { MemoryPanel } from '@/components/panels/MemoryPanel';
import { DashboardPanel } from '@/components/panels/DashboardPanel';
import { analyseThreats } from '@/threat-vision/threats';
import { threatLayers } from '@/threat-vision/layers';
import { START_FEN, validateFen } from '@/chess/position';
import type { NeuralTree, Orientation } from '@/types';
import { recogniseOpening } from '@/openings/eco';

const NAV: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: 'analysis', label: 'Analysis', icon: Icon.board },
  { id: 'intelligence', label: 'MOTH Intelligence', icon: Icon.brain },
  { id: 'threats', label: 'Threat Vision', icon: Icon.shield },
  { id: 'neural', label: 'Neural Map', icon: Icon.map },
  { id: 'whatif', label: 'What-If Simulator', icon: Icon.flask },
  { id: 'review', label: 'Game Review', icon: Icon.review },
  { id: 'openings', label: 'Openings', icon: Icon.book },
  { id: 'coach', label: 'MOTH Coach', icon: Icon.coach },
  { id: 'memory', label: 'Memory', icon: Icon.memory },
  { id: 'dashboard', label: 'Dashboard', icon: Icon.chart },
];

export function BoardApp() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const initialFen = params.get('fen') && validateFen(params.get('fen')!).ok ? validateFen(params.get('fen')!).fen! : START_FEN;
  const [settings, updateSettings] = useSettings();
  useThemeRoot(settings);
  const game = useGame(initialFen);
  const [tab, setTab] = useState<TabId>((NAV.find((n) => n.id === params.get('tab'))?.id) ?? 'analysis');
  const [orientation, setOrientation] = useState<Orientation>('white');
  const [tree, setTree] = useState<NeuralTree | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const [fenInput, setFenInput] = useState('');
  const [welcome, setWelcome] = useState(params.has('welcome'));
  const analysis = useAnalysis(game.fen, settings, { enabled: settings.enabled });

  const toast = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') { game.step(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { game.step(1); e.preventDefault(); }
      else if (e.key === 'Home') game.goto(0);
      else if (e.key === 'End') game.goto(Infinity);
      else if (e.key === 'f') setOrientation((o) => (o === 'white' ? 'black' : 'white'));
      else if (e.key === ' ') { e.preventDefault(); analysis.running ? analysis.stop() : analysis.start(); }
      else if (/^[1-9]$/.test(e.key) && e.altKey) { const n = NAV[Number(e.key) - 1]; if (n) setTab(n.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [game, analysis]);

  // Alt+Shift+A from the background
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const l = (m: { type?: string; command?: string }) => { if (m?.type === 'command' && m.command === 'toggle-analysis') analysis.running ? analysis.stop() : analysis.start(); };
    chrome.runtime.onMessage.addListener(l);
    return () => chrome.runtime.onMessage.removeListener(l);
  }, [analysis]);

  const threats = useMemo(() => {
    if (!(settings.visual.threatVision || tab === 'threats')) return null;
    try { return analyseThreats(game.fen, analysis.result); } catch { return null; }
  }, [settings.visual.threatVision, tab, game.fen, analysis.result]);
  const layers = useMemo(() => threatLayers(threats, settings.visual.threatLayers), [threats, settings.visual.threatLayers]);
  const arrows = useMemo(() => [...arrowsFromResult(analysis.result, settings), ...layers.arrows], [analysis.result, settings, layers.arrows]);
  const opening = useMemo(() => recogniseOpening([game.state.rootFen, ...game.state.moves.slice(0, game.state.cursor).map((m) => m.fenAfter)]).opening, [game.state]);

  const ctx: AppCtx = {
    surface: 'board',
    fen: game.fen, rootFen: game.state.rootFen, moves: game.state.moves, cursor: game.state.cursor, headers: game.state.headers, gameId: game.state.gameId,
    orientation, settings, updateSettings, analysis,
    play: game.play, goto: game.goto,
    loadFen: (f) => { try { game.loadFen(f); } catch (e) { toast((e as Error).message); } },
    loadPgn: (p, id, ply) => { try { game.loadPgn(p, id, ply); } catch (e) { toast((e as Error).message); } },
    loadLine: game.loadLine, setTab, tree, setTree, toast,
  };

  const panel = (() => {
    switch (tab) {
      case 'analysis': return <AnalysisPanel />;
      case 'intelligence': return <IntelligencePanel />;
      case 'threats': return <ThreatPanel />;
      case 'neural': return <NeuralMapPanel />;
      case 'whatif': return <WhatIfPanel />;
      case 'review': return <ReviewPanel />;
      case 'openings': return <OpeningsPanel />;
      case 'coach': return <CoachPanel />;
      case 'memory': return <MemoryPanel />;
      case 'dashboard': return <DashboardPanel />;
    }
  })();

  const st = game.status;
  return (
    <AppContext.Provider value={ctx}>
      <div className="app neural-bg">
        <nav className="rail" aria-label="MOTH sections">
          <img src="icons/icon48.png" alt="MOTH Chess" />
          {NAV.map((n, i) => (
            <button key={n.id} aria-current={tab === n.id ? 'page' : undefined} onClick={() => setTab(n.id)} title={`${n.label}${i < 9 ? ` (Alt+${i + 1})` : ''}`} aria-label={n.label}>{n.icon}</button>
          ))}
          <span className="spacer" />
          <button onClick={() => (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage ? chrome.runtime.openOptionsPage() : open('options.html'))} title="Settings" aria-label="Settings">{Icon.gear}</button>
        </nav>
        <main className={`main ${tab === 'dashboard' || tab === 'memory' ? '' : ''}`}>
          <div className="stack" style={{ position: 'sticky', top: 16 }}>
            <div className="page-head">
              <h1>MOTH Chess</h1>
              <span className="badge">{NAV.find((n) => n.id === tab)?.label}</span>
              <span className="grow" />
              {opening && <span className="small muted" title={opening.moves}>{opening.eco} · {opening.name}</span>}
            </div>
            {welcome && (
              <div className="banner good">
                <b>Welcome to MOTH Chess.</b> Everything runs locally with Stockfish WASM. Use this board for analysis, reviews and training; to use the overlay on Lichess or Chess.com analysis boards, grant access from the toolbar popup. MOTH never runs during live games.
                <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => setWelcome(false)}>Dismiss</button>
              </div>
            )}
            <div className="row" style={{ alignItems: 'stretch', gap: 10 }}>
              {settings.visual.evalBar && <EvalBar score={analysis.result?.lines[0]?.whiteScore} flipped={orientation === 'black'} />}
              <div className="grow">
                <Board fen={game.fen} orientation={orientation} onMove={game.play} arrows={arrows} highlights={settings.visual.squareHighlights ? layers.highlights : []} lastMove={game.lastMove} />
              </div>
            </div>
            <div className="row wrap">
              <button className="btn icon" onClick={() => game.goto(0)} aria-label="First move" title="Start (Home)">«</button>
              <button className="btn icon" onClick={() => game.step(-1)} aria-label="Previous move" title="Back (←)">‹</button>
              <button className="btn icon" onClick={() => game.step(1)} aria-label="Next move" title="Forward (→)">›</button>
              <button className="btn icon" onClick={() => game.goto(Infinity)} aria-label="Last move" title="End">»</button>
              <button className="btn icon" onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))} aria-label="Flip board" title="Flip (F)">{Icon.flip}</button>
              <button className="btn" onClick={() => { game.reset(); }}>New</button>
              <span className="grow" />
              {st.over && <span className={`badge ${st.checkmate ? 'bad' : 'neutral'}`}>{st.checkmate ? 'Checkmate' : `Draw · ${st.reason?.replace(/-/g, ' ')}`}</span>}
              {!st.over && st.check && <span className="badge warn">Check</span>}
            </div>
            <div className="card" style={{ padding: 10 }}>
              <MoveList moves={game.state.moves} cursor={game.state.cursor} onGoto={game.goto} startFen={game.state.rootFen} />
            </div>
            <div className="card" style={{ padding: 10 }}>
              <label className="label" htmlFor="moth-fen">FEN / PGN</label>
              <div className="row">
                <input id="moth-fen" className="input mono" value={fenInput} placeholder={game.fen} onChange={(e) => setFenInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget.nextSibling as HTMLButtonElement)?.click(); }} />
                <button className="btn" onClick={() => {
                  const v = fenInput.trim();
                  if (!v) return;
                  if (validateFen(v).ok) { ctx.loadFen(v); setFenInput(''); toast('Position loaded'); }
                  else if (/\d+\.\s*\S/.test(v) || v.startsWith('[')) { ctx.loadPgn(v); setFenInput(''); }
                  else toast(`Invalid FEN: ${validateFen(v).error}`);
                }}>Load</button>
                <button className="btn ghost" onClick={() => { navigator.clipboard?.writeText(game.fen); toast('FEN copied'); }} title="Copy current FEN">Copy</button>
              </div>
            </div>
          </div>
          <div className="stack" style={{ minWidth: 0 }}>{panel}</div>
        </main>
      </div>
      <div style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 6, zIndex: 50 }} aria-live="polite">
        {toasts.map((t) => <div key={t.id} className="card glow small" style={{ padding: '8px 12px', boxShadow: 'var(--shadow)' }}>{t.msg}</div>)}
      </div>
    </AppContext.Provider>
  );
}
