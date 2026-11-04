import { useEffect, useState } from 'react';
import { useSettings } from '@/settings/useSettings';
import { Toggle, useThemeRoot, BetaBadge } from '@/components/ui';
import { ProfilePicker, profileLabel, openExt } from '@/components/shared';
import type { TabStatus } from '@/utils/messages';

export function PopupApp() {
  const [settings, update] = useSettings();
  useThemeRoot(settings);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [status, setStatus] = useState<TabStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    setTab(t ?? null);
    if (t?.id !== undefined) setStatus(await chrome.runtime.sendMessage({ type: 'tab-status', tabId: t.id, url: t.url }));
  };
  useEffect(() => { void refresh(); }, [settings.enabled]);

  const grant = async () => {
    if (status?.state !== 'needs-permission' || tab?.id === undefined) return;
    const ok = await chrome.permissions.request({ origins: [status.origin] });
    if (!ok) { setMsg('Permission not granted.'); return; }
    const r = await chrome.runtime.sendMessage({ type: 'inject', tabId: tab.id });
    setMsg(r?.ok ? 'Overlay added to this analysis board.' : 'Access granted — reload the page if the overlay does not appear.');
    await refresh();
  };
  const showOverlay = async () => {
    if (tab?.id === undefined) return;
    const r = await chrome.runtime.sendMessage({ type: 'inject', tabId: tab.id });
    setMsg(r?.ok ? 'Overlay toggled.' : `Could not show overlay${r?.error ? `: ${r.error}` : ''}`);
    await refresh();
  };
  const openBoard = (fen?: string) => { chrome.runtime.sendMessage({ type: 'open-board', fen }); window.close(); };

  return (
    <div className="neural-bg" style={{ width: 340, padding: 14 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <img src="icons/moth.svg" width={32} height={32} alt="" />
        <div className="grow">
          <div className="row" style={{ gap: 6 }}><span style={{ fontWeight: 800, letterSpacing: '0.1em', fontSize: 14 }}>MOTH</span><span className="muted small">Chess</span><BetaBadge /></div>
          <div className="muted small">{settings.engine.kind === 'moth' ? 'MOTH Engine' : 'Stockfish'} · {profileLabel(settings.performance.profile)} · local</div>
        </div>
        <span className="switch" title={settings.enabled ? 'Disable MOTH Chess' : 'Enable MOTH Chess'}>
          <input type="checkbox" role="switch" aria-label="Enable MOTH Chess" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span />
        </span>
      </div>

      <div className="card stack" style={{ padding: 12, gap: 8 }}>
        <div className="small muted" style={{ fontWeight: 650 }}>This tab</div>
        {!status && <div className="small">Checking…</div>}
        {status?.state === 'disabled' && <div className="banner warn small">MOTH Chess is turned off. Use the switch above.</div>}
        {status?.state === 'unsupported' && <div className="small">{status.reason}.</div>}
        {status?.state === 'blocked' && <div className="banner bad small"><b>Blocked for fair play.</b> {status.reason}. MOTH never assists in live or rated games.</div>}
        {status?.state === 'needs-permission' && (
          <>
            <div className="small">Supported: <b>{status.label}</b>. Allow MOTH to show its analysis here.</div>
            <button className="btn primary" onClick={grant}>Allow on {new URL(status.origin.replace('*', '')).hostname}</button>
            <div className="muted small">Only analysis pages get the HUD; live-game pages are always excluded.</div>
          </>
        )}
        {status?.state === 'ready' && (
          <>
            <div className="small"><span className="dot ready" style={{ marginRight: 6 }} />{status.label}</div>
            <button className="btn primary" onClick={showOverlay}>{status.injected ? 'Show / hide analysis' : 'Show analysis'}</button>
          </>
        )}
        {msg && <div className="small" aria-live="polite">{msg}</div>}
      </div>

      <button className="btn primary" style={{ width: '100%', marginTop: 10 }} onClick={() => openBoard()}>Open analysis board</button>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn grow" onClick={() => { chrome.runtime.sendMessage({ type: 'open-board', tab: 'play' }); window.close(); }}>Play MOTH</button>
        <button className="btn grow" onClick={() => { chrome.runtime.sendMessage({ type: 'open-board', tab: 'coach' }); window.close(); }}>Train</button>
      </div>

      <div className="card" style={{ padding: 12, marginTop: 10 }}>
        <div className="small muted" style={{ fontWeight: 650, marginBottom: 6 }}>Performance</div>
        <ProfilePicker settings={settings} update={update} compact />
        <div className="divider" />
        <Toggle label={<span className="small">Auto-analyse positions</span>} checked={settings.general.autoAnalyse} onChange={(v) => update({ general: { autoAnalyse: v } })} />
        <Toggle label={<span className="small">Move arrows</span>} checked={settings.visual.arrows} onChange={(v) => update({ visual: { arrows: v } })} />
      </div>

      <div className="row small" style={{ marginTop: 10, justifyContent: 'space-between' }}>
        <button className="btn sm ghost" onClick={() => { openExt('control.html'); window.close(); }}>Control Center</button>
        <button className="btn sm ghost" onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>
        <button className="btn sm ghost" onClick={() => { openExt('control.html#feedback'); window.close(); }}>Report a bug</button>
      </div>
    </div>
  );
}
