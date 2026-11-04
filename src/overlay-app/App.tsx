// Overlay frame (runs inside the extension iframe hosted by the content script on permitted analysis pages).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext, type AppCtx, type TabId } from '@/components/AppContext';
import { useSettings } from '@/settings/useSettings';
import { formatScore } from '@/engine/normalize';
import { useAnalysis, arrowsFromResult } from '@/components/useAnalysis';
import { Tabs, EngineStatusBadge, Toggle, useThemeRoot } from '@/components/ui';
import { AnalysisPanel } from '@/components/panels/AnalysisPanel';
import { IntelligencePanel } from '@/components/panels/IntelligencePanel';
import { NeuralMapPanel } from '@/components/panels/NeuralMapPanel';
import { CoachPanel } from '@/components/panels/CoachPanel';
import { MemoryPanel } from '@/components/panels/MemoryPanel';
import { DashboardPanel } from '@/components/panels/DashboardPanel';
import { PORT_OVERLAY, type ContentToOverlay } from '@/utils/messages';
import { composeFen, type BoardReading } from '@/content/adapters/adapters';
import type { PageVerdict } from '@/content/detector/sites';
import { validateFen } from '@/chess/position';
import { analyseThreats } from '@/threat-vision/threats';
import { threatLayers } from '@/threat-vision/layers';
import type { Color, NeuralTree } from '@/types';

type OverlayTab = 'analysis' | 'intelligence' | 'neural' | 'coach' | 'memory' | 'dashboard';

export function OverlayApp() {
  const [settings, updateSettings] = useSettings();
  useThemeRoot(settings);
  const [reading, setReading] = useState<BoardReading | null>(null);
  const [verdict, setVerdict] = useState<PageVerdict | null>(null);
  const [visible, setVisible] = useState(true);
  const [manualTurn, setManualTurn] = useState<Color | undefined>();
  const [manualCastling, setManualCastling] = useState('-');
  const [tab, setTab] = useState<OverlayTab>('analysis');
  const [tree, setTree] = useState<NeuralTree | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hudOpen, setHudOpen] = useState(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: PORT_OVERLAY });
    portRef.current = port;
    port.onMessage.addListener((m: ContentToOverlay | { type: 'command'; command: string }) => {
      if (m.type === 'board') setReading(m.reading);
      else if (m.type === 'page') setVerdict(m.verdict);
      else if (m.type === 'overlay-visibility') setVisible(m.visible);
      else if (m.type === 'command' && m.command === 'toggle-analysis') window.dispatchEvent(new CustomEvent('moth-toggle-analysis'));
    });
    port.postMessage({ type: 'request-board' });
    return () => port.disconnect();
  }, []);

  const supported = verdict?.status === 'supported';
  const composed = useMemo(() => (reading?.verified && reading.fullFen ? { fen: reading.fullFen, problems: [] as string[] } : reading ? composeFen(reading, { turn: manualTurn, castling: manualCastling }) : { fen: null, problems: [] as string[] }), [reading, manualTurn, manualCastling]);
  const fen = composed.fen && validateFen(composed.fen).ok ? validateFen(composed.fen).fen! : null;
  const fenError = composed.fen && !fen ? validateFen(composed.fen).error : null;

  const analysis = useAnalysis(fen, settings, { enabled: supported && visible && settings.enabled && !!fen });
  useEffect(() => {
    const t = () => (analysis.running ? analysis.stop() : analysis.start());
    window.addEventListener('moth-toggle-analysis', t);
    return () => window.removeEventListener('moth-toggle-analysis', t);
  }, [analysis]);

  // push arrows / threat highlights to the page (never moves — only drawing)
  const threats = useMemo(() => (fen && settings.visual.threatVision ? (() => { try { return analyseThreats(fen, analysis.result); } catch { return null; } })() : null), [fen, settings.visual.threatVision, analysis.result]);
  useEffect(() => {
    if (!portRef.current) return;
    if (!supported || !fen) { portRef.current.postMessage({ type: 'draw', arrows: [], highlights: [] }); return; }
    const layers = threatLayers(threats, settings.visual.threatLayers);
    const top = analysis.result?.lines[0]?.whiteScore;
    const evalBar = settings.hud.evalBar !== 'off' && top ? { white: top.type === 'mate' ? (top.value > 0 || (top.value === 0 && top.winner === 'w') ? 1 : 0) : 1 / (1 + Math.pow(10, -top.value / 400)), label: formatScore(top) } : null;
    portRef.current.postMessage({ type: 'draw', arrows: [...arrowsFromResult(analysis.result, settings, settings.hud.arrowCount), ...layers.arrows], highlights: settings.visual.squareHighlights ? layers.highlights : [], evalBar });
  }, [analysis.result, settings, threats, supported, fen]);

  const toast = useCallback((m: string) => { setToastMsg(m); setTimeout(() => setToastMsg(null), 3200); }, []);
  const openFull = useCallback((o: { fen?: string; tab?: TabId }) => { chrome.runtime.sendMessage({ type: 'open-board', fen: o.fen, tab: o.tab }); }, []);
  const noMove = () => { toast('MOTH never moves pieces on the website — play the move on the page board yourself.'); return false; };

  if (verdict && verdict.status !== 'supported') {
    return (
      <div style={{ padding: 14 }} className="stack">
        <div className="banner bad"><b>Analysis disabled on this page.</b><br />{verdict.reason}</div>
        <p className="muted small">MOTH Chess only works on analysis boards and unrated practice, never during live or rated games. You can still use the built-in board.</p>
        <button className="btn" onClick={() => openFull({})}>Open MOTH analysis board</button>
      </div>
    );
  }

  const ctx: AppCtx = {
    surface: 'overlay', fen: fen ?? '8/8/8/8/8/8/8/8 w - - 0 1', rootFen: fen ?? '', moves: [], cursor: 0, headers: {}, orientation: reading?.orientation ?? 'white',
    settings, updateSettings, analysis, play: noMove, goto: () => {}, loadFen: (f) => openFull({ fen: f }), loadPgn: () => openFull({ tab: 'review' }),
    loadLine: (root, uci) => openFull({ fen: root, tab: uci.length ? 'neural' : 'analysis' }), setTab: (t) => (['analysis', 'intelligence', 'neural', 'coach', 'memory', 'dashboard'].includes(t) ? setTab(t as OverlayTab) : openFull({ fen: fen ?? undefined, tab: t })),
    tree, setTree, toast, openFull,
  };

  const needTurn = reading && !reading.verified && !reading.turn;
  const compact = settings.hud.layout === 'compact' && !expanded;
  const top = analysis.result?.lines[0];
  const statusRow = settings.hud.showStatus && (
    <div className="row">
      <EngineStatusBadge status={analysis.status} detail={analysis.statusDetail} />
      <span className="grow" />
      <span className="badge neutral" title="Current mode">{verdict?.status === 'supported' ? verdict.context : '…'}</span>
      {reading && <span className={`badge ${reading.verified ? 'good' : 'warn'}`} title={reading.verified ? 'Side to move, castling and en passant come from the page itself' : 'Only piece placement could be read'}>{reading.verified ? 'Verified' : 'Unverified'}</span>}
    </div>
  );
  const engineError = analysis.status === 'error' && (
    <div className="banner bad small" role="alert">{analysis.statusDetail ?? 'The engine stopped.'}
      <div className="row" style={{ marginTop: 6, gap: 6 }}><button className="btn sm" onClick={analysis.retry}>Restart engine</button>
        <button className="btn sm ghost" onClick={() => updateSettings({ engine: { kind: settings.engine.kind === 'moth' ? 'stockfish' : 'moth' } })}>Use {settings.engine.kind === 'moth' ? 'Stockfish' : 'MOTH Engine'}</button></div>
    </div>
  );
  if (compact) {
    return (
      <AppContext.Provider value={ctx}>
        <div className="stack" style={{ padding: 10, gap: 8, zoom: settings.appearance.overlayScale }} data-hud="compact">
          {statusRow}
          {engineError}
          {!reading && <div className="banner small">Looking for the analysis board on this page…</div>}
          {needTurn && (
            <div className="row small"><span className="grow">Side to move?</span>
              <button className={`btn sm ${manualTurn === 'w' ? 'primary' : ''}`} onClick={() => setManualTurn('w')}>White</button>
              <button className={`btn sm ${manualTurn === 'b' ? 'primary' : ''}`} onClick={() => setManualTurn('b')}>Black</button></div>
          )}
          {fenError && <div className="banner bad small">This board position is not legal: {fenError}</div>}
          {fen && (
            <div className="card" style={{ padding: 10 }}>
              <div className="row">
                <span className="mono" style={{ fontSize: 22, fontWeight: 800 }} aria-live="polite" data-testid="hud-score">{top ? formatScore(top.whiteScore) : '…'}</span>
                <span className="grow" />
                <span className="small muted">{analysis.result ? `depth ${analysis.result.depth}` : analysis.running ? 'thinking…' : 'paused'}</span>
              </div>
              {settings.hud.showPv && top && <div className="pv small" style={{ marginTop: 4 }} data-testid="hud-pv"><b>{top.pvSan[0]}</b> {top.pvSan.slice(1, 8).join(' ')}</div>}
            </div>
          )}
          <div className="row">
            <button className="btn sm" onClick={() => (analysis.running ? analysis.stop() : analysis.start())}>{analysis.running ? 'Pause' : 'Analyse'}</button>
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => setExpanded(true)}>More</button>
            <button className="btn sm ghost" onClick={() => openFull({ fen: fen ?? undefined })} title="Open on the full MOTH board" aria-label="Open full board">⤢</button>
          </div>
        </div>
        {toastMsg && <div className="card glow small" style={{ position: 'fixed', bottom: 8, left: 8, right: 8, padding: 8 }} aria-live="polite">{toastMsg}</div>}
      </AppContext.Provider>
    );
  }
  return (
    <AppContext.Provider value={ctx}>
      <div className="stack" style={{ padding: 10, gap: 8, zoom: settings.appearance.overlayScale }}>
        <div className="row">
          {settings.hud.showStatus ? <EngineStatusBadge status={analysis.status} detail={analysis.statusDetail} /> : null}
          <span className="grow" />
          {settings.hud.showStatus && <span className="badge neutral" title="Current mode">{verdict?.status === 'supported' ? verdict.context : '…'}</span>}
          {settings.hud.layout === 'compact' && <button className="btn sm ghost" onClick={() => setExpanded(false)} title="Back to the compact HUD">Less</button>}
          <button className="btn sm ghost" onClick={() => setHudOpen((o) => !o)} title="Customise the HUD" aria-label="Customise the HUD" aria-expanded={hudOpen}>◧</button>
          <button className="btn sm ghost" onClick={() => chrome.runtime.openOptionsPage()} title="Settings" aria-label="Settings">⚙</button>
          <button className="btn sm ghost" onClick={() => openFull({ fen: fen ?? undefined })} title="Open on the full MOTH board" aria-label="Open full board">⤢</button>
        </div>
        {hudOpen && (
          <div className="card small" style={{ padding: 10 }} data-testid="hud-settings">
            <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
              <span className="muted">Layout</span>
              <div className="seg" role="group" aria-label="HUD layout">
                <button aria-pressed={settings.hud.layout === 'full'} onClick={() => updateSettings({ hud: { layout: 'full' } })}>Full</button>
                <button aria-pressed={settings.hud.layout === 'compact'} onClick={() => { setExpanded(false); updateSettings({ hud: { layout: 'compact' } }); }}>Compact</button>
              </div>
            </div>
            <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
              <span className="muted">Eval bar</span>
              <div className="seg" role="group" aria-label="Evaluation bar position">
                {(['left', 'right', 'off'] as const).map((v) => <button key={v} aria-pressed={settings.hud.evalBar === v} onClick={() => updateSettings({ hud: { evalBar: v } })}>{v === 'off' ? 'Hidden' : v[0].toUpperCase() + v.slice(1)}</button>)}
              </div>
            </div>
            <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
              <span className="muted">Arrows</span>
              <div className="seg" role="group" aria-label="Number of arrows">
                {[0, 1, 2, 3].map((n) => <button key={n} aria-pressed={settings.hud.arrowCount === n} onClick={() => updateSettings({ hud: { arrowCount: n } })}>{n}</button>)}
              </div>
            </div>
            <Toggle checked={settings.hud.bestMoveSquares} onChange={(v) => updateSettings({ hud: { bestMoveSquares: v } })} label="Outline best-move squares" />
            <Toggle checked={settings.hud.showPv} onChange={(v) => updateSettings({ hud: { showPv: v } })} label="Show principal variation" />
            <Toggle checked={settings.hud.showStatus} onChange={(v) => updateSettings({ hud: { showStatus: v } })} label="Show engine status" />
            <Toggle checked={settings.hud.avoidBoard} onChange={(v) => updateSettings({ hud: { avoidBoard: v } })} label="Keep panel off the board" />
            <div className="muted" style={{ marginTop: 4 }}>Drag the title bar to move the panel; ⇆ puts it back beside the board.</div>
          </div>
        )}
        {engineError}
        {!reading && <div className="banner">Looking for the analysis board on this page…</div>}
        {reading && (
          <div className="row small wrap" style={{ gap: 6 }}>
            <span className={`badge ${reading.verified ? 'good' : 'warn'}`} title={reading.verified ? 'Side to move, castling and en passant come from the page itself' : 'Only piece placement could be read'}>
              {reading.verified ? `Verified position · ${reading.source === 'fen' ? 'page FEN' : reading.source === 'history' ? 'move list' : 'URL'}` : 'Unverified · pieces only'}
            </span>
            <label className="row small" style={{ gap: 4 }}>
              <span className="muted">Engine</span>
              <select className="input sm" aria-label="Engine" value={settings.engine.kind} onChange={(e) => updateSettings({ engine: { kind: e.target.value as 'moth' | 'stockfish' } })}>
                <option value="moth">MOTH</option><option value="stockfish">Stockfish</option>
              </select>
            </label>
            {settings.engine.kind === 'moth' && (
              <label className="row small" style={{ gap: 4 }}>
                <span className="muted">Style</span>
                <select className="input sm" aria-label="Playing style" value={settings.moth.style} onChange={(e) => updateSettings({ moth: { style: e.target.value as 'aggressive' | 'balanced' | 'defensive' } })}>
                  <option value="aggressive">Aggressive</option><option value="balanced">Balanced</option><option value="defensive">Defensive</option>
                </select>
              </label>
            )}
          </div>
        )}
        {reading && !reading.verified && (needTurn || reading.castling === null) && (
          <div className="card" style={{ padding: 8 }}>
            {needTurn && (
              <div className="row small" style={{ marginBottom: 4 }}>
                <span className="grow">Side to move (not shown by the page):</span>
                <button className={`btn sm ${manualTurn === 'w' ? 'primary' : ''}`} onClick={() => setManualTurn('w')}>White</button>
                <button className={`btn sm ${manualTurn === 'b' ? 'primary' : ''}`} onClick={() => setManualTurn('b')}>Black</button>
              </div>
            )}
            {reading.castling === null && (
              <div className="row small wrap">
                <span className="grow muted">Castling rights (unknown — set if relevant):</span>
                {(['K', 'Q', 'k', 'q'] as const).map((c) => (
                  <button key={c} className={`btn sm ${manualCastling.includes(c) ? 'primary' : ''}`} aria-pressed={manualCastling.includes(c)}
                    onClick={() => setManualCastling((cur) => { const set = new Set(cur.replace('-', '').split('').filter(Boolean)); set.has(c) ? set.delete(c) : set.add(c); const s = ['K', 'Q', 'k', 'q'].filter((x) => set.has(x)).join(''); return s || '-'; })}>{c}</button>
                ))}
              </div>
            )}
            {composed.problems.filter((p) => p.startsWith('Dropped')).map((p) => <div key={p} className="small muted">{p}</div>)}
          </div>
        )}
        {fenError && <div className="banner bad small">This board position is not legal: {fenError}</div>}
        <div className="row"><Toggle checked={settings.visual.threatVision} onChange={(v) => updateSettings({ visual: { threatVision: v } })} label={<span className="small">Threat Vision on page</span>} /></div>
        <Tabs<OverlayTab> label="Overlay sections" value={tab} onChange={setTab} tabs={[
          { id: 'analysis', label: 'Analysis' }, { id: 'intelligence', label: 'Intelligence' }, { id: 'neural', label: 'Neural Map' },
          { id: 'coach', label: 'Coach' }, { id: 'memory', label: 'Memory' }, { id: 'dashboard', label: 'Dashboard' },
        ]} />
        {fen ? (
          <>
            {tab === 'analysis' && <AnalysisPanel />}
            {tab === 'intelligence' && <IntelligencePanel />}
            {tab === 'neural' && <NeuralMapPanel compact />}
            {tab === 'coach' && <CoachPanel compact />}
            {tab === 'memory' && <MemoryPanel compact />}
            {tab === 'dashboard' && <DashboardPanel compact />}
          </>
        ) : (tab === 'coach' ? <CoachPanel compact /> : tab === 'dashboard' ? <DashboardPanel compact /> : <div className="empty">Waiting for a readable position…</div>)}
        {reading?.warnings.length ? <details className="small muted"><summary>Board reading notes ({reading.source})</summary><ul>{reading.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details> : null}
      </div>
      {toastMsg && <div className="card glow small" style={{ position: 'fixed', bottom: 8, left: 8, right: 8, padding: 8 }} aria-live="polite">{toastMsg}</div>}
    </AppContext.Provider>
  );
}
