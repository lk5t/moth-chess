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
import { LearningPanel } from '@/components/panels/LearningPanel';
import { HomePanel } from '@/components/panels/HomePanel';
import { PlayView } from '@/play/PlayView';
import { analyseThreats } from '@/threat-vision/threats';
import { threatLayers } from '@/threat-vision/layers';
import { START_FEN, validateFen } from '@/chess/position';
import type { NeuralTree, Orientation } from '@/types';
import { recogniseOpening } from '@/openings/eco';

// ---------- Workspace 3.0 information architecture ----------
// Five workspaces in the sidebar; each has a few sections shown as tabs. Advanced tools are tucked behind
// "More tools" (and Engine Lab is hidden) in Simple mode, so first-time users see only the essentials.
export type Workspace = 'home' | 'analyze' | 'train' | 'library' | 'lab';
export const WORKSPACES: { id: Workspace; label: string; icon: ReactNode; hint: string; advanced?: boolean }[] = [
  { id: 'home', label: 'Home', icon: Icon.home, hint: 'Start here: quick analysis, recent games, training' },
  { id: 'analyze', label: 'Analyze', icon: Icon.board, hint: 'Board, evaluation, game review, openings' },
  { id: 'train', label: 'Train', icon: Icon.coach, hint: 'Coach exercises and games against MOTH' },
  { id: 'library', label: 'Library', icon: Icon.memory, hint: 'Saved games, positions and your progress' },
  { id: 'lab', label: 'Engine Lab', icon: Icon.engine, hint: 'Engine benchmarks, models and self-play (advanced)', advanced: true },
];
export const SECTIONS: { id: TabId; ws: Workspace; label: string; hint: string; advanced?: boolean }[] = [
  { id: 'home', ws: 'home', label: 'Home', hint: '' },
  { id: 'analysis', ws: 'analyze', label: 'Evaluate', hint: 'Engine evaluation and the best moves for the position on the board' },
  { id: 'review', ws: 'analyze', label: 'Game review', hint: 'Analyse a whole game: mistakes, accuracy and a report' },
  { id: 'openings', ws: 'analyze', label: 'Openings', hint: 'Opening names, main lines and your repertoire' },
  { id: 'intelligence', ws: 'analyze', label: 'Explain', hint: 'Plain-language explanation of the position', advanced: true },
  { id: 'threats', ws: 'analyze', label: 'Threats', hint: 'Attacked, hanging and pinned pieces drawn on the board', advanced: true },
  { id: 'neural', ws: 'analyze', label: 'Variation tree', hint: 'Explore and save branching lines (Neural Map)', advanced: true },
  { id: 'whatif', ws: 'analyze', label: 'What-if', hint: 'Compare candidate moves side by side', advanced: true },
  { id: 'coach', ws: 'train', label: 'Coach', hint: 'Exercises from your own mistakes, with spaced repetition' },
  { id: 'play', ws: 'train', label: 'Play MOTH', hint: 'Offline games against MOTH at seven levels' },
  { id: 'memory', ws: 'library', label: 'Games', hint: 'Saved games, positions, folders and tags' },
  { id: 'dashboard', ws: 'library', label: 'Progress', hint: 'Accuracy, mistakes and training statistics over time' },
  { id: 'engine', ws: 'lab', label: 'MOTH Engine', hint: 'Engine models, learning, latency and benchmarks' },
];
const sectionOf = (t: TabId) => SECTIONS.find((x) => x.id === t)!;
const isTab = (t: string | null | undefined): t is TabId => !!t && SECTIONS.some((x) => x.id === t);

export function BoardApp() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const initialFen = params.get('fen') && validateFen(params.get('fen')!).ok ? validateFen(params.get('fen')!).fen! : START_FEN;
  const [settings, updateSettings, settingsLoaded] = useSettings();
  useThemeRoot(settings);
  const game = useGame(initialFen);
  const paramTab = params.get('tab');
  const [tab, setTabState] = useState<TabId>(isTab(paramTab) ? paramTab : params.has('fen') ? 'analysis' : 'home');
  const [moreOpen, setMoreOpen] = useState(false);
  // restore the last section once settings are loaded (unless the URL asked for something)
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!settingsLoaded || restored) return;
    setRestored(true);
    if (!paramTab && !params.has('fen') && isTab(settings.ui.lastTab)) setTabState(settings.ui.lastTab);
  }, [settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const setTab = useCallback((t: TabId) => { setTabState(t); setMoreOpen(false); void updateSettings({ ui: { lastTab: t } }); }, [updateSettings]);
  const simple = settings.ui.mode === 'simple';
  const [orientation, setOrientation] = useState<Orientation>('white');
  const [tree, setTree] = useState<NeuralTree | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const [fenInput, setFenInput] = useState('');
  const [welcome, setWelcome] = useState(params.has('welcome'));
  // no background analysis on screens without a board (Home, Play MOTH, Engine Lab)
  const analysis = useAnalysis(game.fen, settings, { enabled: settings.enabled && tab !== 'home' && tab !== 'play' && tab !== 'engine' });

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
      else if (/^[1-5]$/.test(e.key) && e.altKey) { const w = WORKSPACES[Number(e.key) - 1]; const first = w && SECTIONS.find((x) => x.ws === w.id); if (first) setTab(first.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [game, analysis, setTab]);

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
      case 'play': return null;
      case 'home': return null;
    }
  })();

  const st = game.status;
  const sec = sectionOf(tab);
  const ws = WORKSPACES.find((w) => w.id === sec.ws)!;
  const wsSections = SECTIONS.filter((x) => x.ws === ws.id && x.id !== 'home');
  const basic = wsSections.filter((x) => !x.advanced);
  const adv = wsSections.filter((x) => x.advanced);
  const navWorkspaces = WORKSPACES.filter((w) => !(simple && w.advanced) || w.id === ws.id);
  const boardColumn = (
          <div className="stack" style={{ position: 'sticky', top: 16 }}>
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
              <button className="btn" onClick={() => { game.reset(); }} title="Start a new game from the initial position">New</button>
              <span className="grow" />
              {opening && <span className="small muted" title={opening.moves}>{opening.eco} · {opening.name}</span>}
              {st.over && <span className={`badge ${st.checkmate ? 'bad' : 'neutral'}`}>{st.checkmate ? 'Checkmate' : `Draw · ${st.reason?.replace(/-/g, ' ')}`}</span>}
              {!st.over && st.check && <span className="badge warn">Check</span>}
            </div>
            <div className="card" style={{ padding: 10 }}>
              <MoveList moves={game.state.moves} cursor={game.state.cursor} onGoto={game.goto} startFen={game.state.rootFen} />
            </div>
            <details className="card" style={{ padding: 10 }}>
              <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>Load a FEN or PGN</summary>
              <div className="row" style={{ marginTop: 8 }}>
                <input id="moth-fen" aria-label="FEN / PGN" className="input mono" value={fenInput} placeholder={game.fen} onChange={(e) => setFenInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget.nextSibling as HTMLButtonElement)?.click(); }} />
                <button className="btn" onClick={() => {
                  const v = fenInput.trim();
                  if (!v) return;
                  if (validateFen(v).ok) { ctx.loadFen(v); setFenInput(''); toast('Position loaded'); }
                  else if (/\d+\.\s*\S/.test(v) || v.startsWith('[')) { ctx.loadPgn(v); setFenInput(''); toast('Game loaded'); }
                  else toast(`Invalid FEN: ${validateFen(v).error}`);
                }}>Load</button>
                <button className="btn ghost" onClick={() => { navigator.clipboard?.writeText(game.fen); toast('FEN copied'); }} title="Copy current FEN">Copy</button>
              </div>
            </details>
          </div>
  );
  return (
    <AppContext.Provider value={ctx}>
      <div className="app neural-bg">
        <nav className="rail" aria-label="MOTH workspaces">
          <div className="brand"><img src="icons/moth.svg" alt="" /><span className="word">MOTH<small>Chess · public beta</small></span></div>
          {navWorkspaces.map((w, i) => {
            const first = w.id === 'home' ? 'home' : SECTIONS.find((x) => x.ws === w.id && !x.advanced)!.id;
            return <button key={w.id} aria-current={ws.id === w.id ? 'page' : undefined} onClick={() => setTab(ws.id === w.id && w.id !== 'home' ? tab : first)} title={`${w.hint} (Alt+${i + 1})`} aria-label={w.label}>{w.icon}<span className="lbl">{w.label}</span></button>;
          })}
          <span className="spacer" />
          <button onClick={() => (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage ? chrome.runtime.openOptionsPage() : open('options.html'))} title="Settings" aria-label="Settings">{Icon.gear}<span className="lbl">Settings</span></button>
        </nav>
        <div className="workspace">
          <div className="workspace-head page-head">
            <h1>{ws.label}</h1>
            <span className="badge" style={{ display: tab === 'home' ? 'none' : undefined }}>{sec.label}</span>
            <span className="grow" />
            {simple && settings.ui.tips && tab !== 'home' && <span className="small muted">{sec.hint}</span>}
          </div>
          {tab !== 'home' && (
            <div className="sections" role="tablist" aria-label={`${ws.label} sections`}>
              {basic.map((x) => <button key={x.id} role="tab" aria-selected={tab === x.id} title={x.hint} onClick={() => setTab(x.id)}>{x.label}</button>)}
              {adv.length > 0 && !simple && adv.map((x) => <button key={x.id} role="tab" aria-selected={tab === x.id} title={x.hint} onClick={() => setTab(x.id)}>{x.label}</button>)}
              {adv.length > 0 && simple && (
                <span style={{ position: 'relative' }}>
                  <button aria-haspopup="menu" aria-expanded={moreOpen} aria-selected={adv.some((x) => x.id === tab)} onClick={() => setMoreOpen((o) => !o)}>{adv.find((x) => x.id === tab)?.label ?? 'More tools'} ▾</button>
                  {moreOpen && (
                    <div className="menu" role="menu" style={{ top: '100%', left: 0 }}>
                      {adv.map((x) => <button key={x.id} role="menuitem" onClick={() => setTab(x.id)}><b>{x.label}</b><span className="small muted">{x.hint}</span></button>)}
                    </div>
                  )}
                </span>
              )}
            </div>
          )}
          {welcome && (
            <div className="banner good" style={{ marginBottom: 12 }}>
              <b>Welcome to MOTH Chess.</b> Everything runs locally. Pick something to do below — you can always come back here with <b>Home</b>.
              <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => setWelcome(false)}>Dismiss</button>
            </div>
          )}
          <div key={tab} className="fade-in">
            {tab === 'home' ? <HomePanel /> : tab === 'play' ? <PlayView /> : tab === 'engine' ? <LearningPanel /> : (
              <main className="main">
                {boardColumn}
                <div className="stack" style={{ minWidth: 0 }}>{panel}</div>
              </main>
            )}
          </div>
        </div>
      </div>
      <div style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 6, zIndex: 50 }} aria-live="polite">
        {toasts.map((t) => <div key={t.id} className="card glow small" style={{ padding: '8px 12px', boxShadow: 'var(--shadow)' }}>{t.msg}</div>)}
      </div>
    </AppContext.Provider>
  );
}
