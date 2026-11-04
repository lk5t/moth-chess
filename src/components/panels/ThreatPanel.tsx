import { useMemo } from 'react';
import { useApp } from '../AppContext';
import { Card, Empty, SourceTag, Toggle } from '../ui';
import { analyseThreats } from '@/threat-vision/threats';
import { LAYER_COLORS } from '@/threat-vision/layers';
import type { Settings } from '@/settings/schema';

const LAYERS: { key: keyof Settings['visual']['threatLayers']; label: string }[] = [
  { key: 'hanging', label: 'Hanging pieces' }, { key: 'undefended', label: 'Undefended pieces' }, { key: 'attacked', label: 'Attacked squares' },
  { key: 'checks', label: 'Checking moves' }, { key: 'pins', label: 'Pins' }, { key: 'forks', label: 'Forks' }, { key: 'skewers', label: 'Skewers' },
  { key: 'kingSafety', label: 'King-safety warnings' }, { key: 'defences', label: 'Defensive responses' },
];

export function ThreatPanel() {
  const { fen, analysis, settings, updateSettings, play } = useApp();
  const r = useMemo(() => { try { return analyseThreats(fen, analysis.result); } catch { return null; } }, [fen, analysis.result]);
  const layers = settings.visual.threatLayers;
  const set = (k: keyof typeof layers, v: boolean) => updateSettings({ visual: { threatLayers: { [k]: v } } });
  if (!r) return <Card title="Threat Vision"><div className="banner bad">Invalid position.</div></Card>;
  const side = (c: 'w' | 'b') => (c === 'w' ? 'White' : 'Black');
  return (
    <div className="stack">
      <Card glow title="Threat Vision" actions={<Toggle checked={settings.visual.threatVision} onChange={(v) => updateSettings({ visual: { threatVision: v } })} label={<span className="small">Show on board</span>} />}>
        <div className="grid-2" style={{ gap: 0 }}>
          {LAYERS.map((l) => (
            <Toggle key={l.key} checked={layers[l.key]} onChange={(v) => set(l.key, v)} label={<span className="row small"><span className="dot" style={{ background: LAYER_COLORS[l.key] }} />{l.label}</span>} />
          ))}
        </div>
        <p className="muted small" style={{ margin: '6px 0 0' }}><SourceTag source="geometric" /> = attack geometry only. <SourceTag source="engine" /> = the move also appears among Stockfish's best lines (or is checkmate by the rules).</p>
      </Card>

      {r.kingWarnings.length > 0 && <div className="banner bad">{r.kingWarnings.map((w) => w.message).join(' · ')}</div>}

      <Card title={`Material at risk`}>
        {!r.hanging.length && <Empty>No piece can currently be won by a simple capture sequence.</Empty>}
        {r.hanging.map((h) => <div key={h.square} className="row small"><span className="badge bad">{h.square}</span>{side(h.color)}'s {h.type.toUpperCase()} — {h.reason.replace(/-/g, ' ')} (≈{h.gain} pawn{h.gain === 1 ? '' : 's'})</div>)}
        {r.materialThreats.length > 0 && <>
          <div className="divider" />
          <div className="small muted">{side(r.turn)} can win material with:</div>
          {r.materialThreats.slice(0, 5).map((m) => <div key={m.uci} className="row small"><button className="btn sm" onClick={() => play(m.uci)}>{m.san}</button>+{m.gain}<SourceTag source={m.kind === 'engine-validated' ? 'engine' : 'geometric'} /></div>)}
        </>}
        {r.opponentMaterialThreats.length > 0 && <>
          <div className="divider" />
          <div className="small muted">If it were {side(r.turn === 'w' ? 'b' : 'w')}'s move they could play:</div>
          {r.opponentMaterialThreats.slice(0, 4).map((m) => <div key={m.uci} className="row small"><span className="badge warn">{m.san}</span>+{m.gain}<SourceTag source="geometric" /></div>)}
        </>}
      </Card>

      <div className="grid-2">
        <Card title="Forks & skewers">
          {!r.forks.length && !r.opponentForks.length && !r.skewers.length && <Empty>None detected.</Empty>}
          {r.forks.map((f) => <div key={f.uci} className="row small"><button className="btn sm" onClick={() => play(f.uci)}>{f.san}</button>forks {f.targets.join(', ')}<SourceTag source={f.kind === 'engine-validated' ? 'engine' : 'geometric'} /></div>)}
          {r.opponentForks.map((f) => <div key={'o' + f.uci} className="row small"><span className="badge warn">{f.san}</span>threat: forks {f.targets.join(', ')}<SourceTag source="geometric" /></div>)}
          {r.skewers.map((s, i) => <div key={'s' + i} className="row small"><span className="badge">{s.attacker}</span>skewers {s.front} → {s.back}<SourceTag source="geometric" /></div>)}
        </Card>
        <Card title="Pins">
          {!r.pins.length && <Empty>No pins.</Empty>}
          {r.pins.map((p, i) => <div key={i} className="row small"><span className="badge">{p.pinned}</span>{p.absolute ? 'pinned to king' : `pinned against ${p.to}`} by {p.pinner}</div>)}
        </Card>
        <Card title="Checks available">
          {!r.checks.length && <Empty>No checking moves.</Empty>}
          {r.checks.slice(0, 8).map((c) => <div key={c.uci} className="row small"><button className="btn sm" onClick={() => play(c.uci)}>{c.san}</button>{c.mate && <span className="badge good">mate</span>}<SourceTag source={c.kind === 'engine-validated' ? 'engine' : 'geometric'} /></div>)}
        </Card>
        <Card title="Defensive responses">
          {!r.defences.length && <Empty>{r.inCheck ? '' : 'Nothing urgent to defend.'}</Empty>}
          {r.defences.map((d) => <div key={d.uci} className="row small"><button className="btn sm" onClick={() => play(d.uci)}>{d.san}</button><span className="muted">{d.reason}</span></div>)}
        </Card>
      </div>
    </div>
  );
}
