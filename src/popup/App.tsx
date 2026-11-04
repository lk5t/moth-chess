import { useEffect, useState } from 'react';
import { useSettings } from '@/settings/useSettings';
import { Toggle, useThemeRoot } from '@/components/ui';
import type { TabStatus } from '@/utils/messages';

export function PopupApp() {
  const [settings, update] = useSettings();
  useThemeRoot(settings);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [status, setStatus] = useState<TabStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);

  const refresh = async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    setTab(t ?? null);
    if (t?.id !== undefined) setStatus(await chrome.runtime.sendMessage({ type: 'tab-status', tabId: t.id, url: t.url }));
  };
  useEffect(() => { void refresh(); chrome.commands?.getAll?.().then(setCommands).catch(() => {}); }, [settings.enabled]);

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
    <div className="neural-bg" style={{ width: 330, padding: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <img src="icons/icon48.png" width={30} height={30} alt="" />
        <div className="grow">
          <div style={{ fontWeight: 750, fontSize: 15 }}>MOTH Chess</div>
          <div className="muted small">Local Stockfish analysis</div>
        </div>
        <span className="switch" title={settings.enabled ? 'Disable MOTH Chess' : 'Enable MOTH Chess'}>
          <input type="checkbox" role="switch" aria-label="Enable MOTH Chess" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span />
        </span>
      </div>

      <div className="card stack" style={{ padding: 10, gap: 8 }}>
        <div className="small muted">This tab</div>
        {!status && <div className="small">Checking…</div>}
        {status?.state === 'disabled' && <div className="banner warn small">MOTH Chess is disabled. Toggle it on above.</div>}
        {status?.state === 'unsupported' && <div className="small">{status.reason}.</div>}
        {status?.state === 'blocked' && <div className="banner bad small"><b>Blocked for fair play.</b> {status.reason}. MOTH never assists in live or rated games.</div>}
        {status?.state === 'needs-permission' && (
          <>
            <div className="small">Supported: <b>{status.label}</b>. MOTH needs your permission to show its overlay there.</div>
            <button className="btn primary" onClick={grant}>Allow on {new URL(status.origin.replace('*', '')).hostname}</button>
            <div className="muted small">Only analysis pages get the overlay; live-game pages are always excluded.</div>
          </>
        )}
        {status?.state === 'ready' && (
          <>
            <div className="small">✓ {status.label}</div>
            <button className="btn primary" onClick={showOverlay}>{status.injected ? 'Show / hide overlay' : 'Show overlay'}</button>
          </>
        )}
        {msg && <div className="small" aria-live="polite">{msg}</div>}
      </div>

      <div className="stack" style={{ marginTop: 10, gap: 6 }}>
        <button className="btn primary" onClick={() => openBoard()}>Open analysis board</button>
        <div className="row">
          <button className="btn grow" onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>
          <button className="btn grow" onClick={() => { chrome.runtime.sendMessage({ type: 'open-board', tab: 'coach' }); window.close(); }}>Train</button>
        </div>
      </div>

      <div className="card" style={{ padding: 10, marginTop: 10 }}>
        <Toggle label={<span className="small">Auto-analyse positions</span>} checked={settings.general.autoAnalyse} onChange={(v) => update({ general: { autoAnalyse: v } })} />
        <Toggle label={<span className="small">Move arrows</span>} checked={settings.visual.arrows} onChange={(v) => update({ visual: { arrows: v } })} />
        <div className="divider" />
        <div className="small muted" style={{ marginBottom: 4 }}>Shortcuts</div>
        {commands.filter((c) => c.name && c.name !== '_execute_action').map((c) => (
          <div key={c.name} className="row small"><span className="grow">{c.description}</span><span className="kbd">{c.shortcut || 'unset'}</span></div>
        ))}
      </div>
    </div>
  );
}
