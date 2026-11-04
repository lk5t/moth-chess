// MOTH Chess service worker: lifecycle, dynamic content-script registration (only on permitted analysis
// pages), tab-scoped message relay between the content script and the overlay frame, commands, notifications.
import { SITES, classifyUrl, siteForUrl, type SiteDef } from '@/content/detector/sites';
import { PORT_CONTENT, PORT_OVERLAY, type RuntimeRequest, type TabStatus } from '@/utils/messages';
import { loadSettings, SETTINGS_KEY } from '@/settings/store';
import { DEFAULT_SETTINGS } from '@/settings/schema';

const scriptId = (s: SiteDef) => `moth-${s.id}`;

async function grantedSites(): Promise<SiteDef[]> {
  const out: SiteDef[] = [];
  for (const s of SITES) if (await chrome.permissions.contains({ origins: [s.origin] })) out.push(s);
  return out;
}

/** Register content scripts exactly for granted origins, restricted to supported analysis paths. */
export async function syncContentScripts(): Promise<void> {
  const settings = await loadSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ours = existing.filter((s) => s.id.startsWith('moth-')).map((s) => s.id);
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
  if (!settings.enabled) return;
  const granted = await grantedSites();
  if (!granted.length) return;
  await chrome.scripting.registerContentScripts(
    granted.map((s) => ({ id: scriptId(s), matches: s.matches, js: ['content.js'], runAt: 'document_idle' as const, persistAcrossSessions: true, allFrames: false })),
  );
}

// ---------------- tab-scoped relay ----------------

interface TabPorts { content?: chrome.runtime.Port; overlays: Set<chrome.runtime.Port> }
const tabs = new Map<number, TabPorts>();
const entry = (id: number) => { let e = tabs.get(id); if (!e) { e = { overlays: new Set() }; tabs.set(id, e); } return e; };

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  // Only accept connections from our own extension contexts / our content script.
  if (port.sender?.id !== chrome.runtime.id || tabId === undefined) { port.disconnect(); return; }
  const e = entry(tabId);
  if (port.name === PORT_CONTENT) {
    e.content = port;
    port.onMessage.addListener((msg) => e.overlays.forEach((o) => o.postMessage(msg)));
    port.onDisconnect.addListener(() => { if (e.content === port) e.content = undefined; e.overlays.forEach((o) => o.postMessage({ type: 'page', verdict: { status: 'unsupported', reason: 'Page closed or navigated' } })); });
  } else if (port.name === PORT_OVERLAY) {
    // the overlay frame must be our overlay.html
    if (!port.sender?.url?.startsWith(chrome.runtime.getURL('overlay.html'))) { port.disconnect(); return; }
    e.overlays.add(port);
    port.onMessage.addListener((msg) => e.content?.postMessage(msg));
    port.onDisconnect.addListener(() => e.overlays.delete(port));
    e.content?.postMessage({ type: 'request-board' });
  } else port.disconnect();
});

chrome.tabs.onRemoved.addListener((id) => tabs.delete(id));

function broadcastTeardown(reason: string) {
  for (const e of tabs.values()) e.content?.postMessage({ type: 'teardown', reason });
}

// ---------------- lifecycle ----------------

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.local.get(SETTINGS_KEY);
  if (!cur[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  await syncContentScripts();
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('board.html?welcome=1') });
});
chrome.runtime.onStartup.addListener(() => { void syncContentScripts(); });
chrome.permissions.onAdded.addListener(() => { void syncContentScripts(); });
chrome.permissions.onRemoved.addListener(() => { void syncContentScripts(); broadcastTeardown('Site access was removed'); });
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
  const was = changes[SETTINGS_KEY].oldValue?.enabled ?? true;
  const now = changes[SETTINGS_KEY].newValue?.enabled ?? true;
  if (was !== now) {
    await syncContentScripts();
    if (!now) broadcastTeardown('MOTH Chess was disabled');
    await chrome.action.setBadgeText({ text: now ? '' : 'off' });
    await chrome.action.setBadgeBackgroundColor({ color: '#5b4bd6' });
  }
});

// ---------------- commands ----------------

async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }

async function openBoard(params: Record<string, string> = {}) {
  const q = new URLSearchParams(params).toString();
  const url = chrome.runtime.getURL(`board.html${q ? '?' + q : ''}`);
  const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('board.html') + '*' });
  if (existing[0]?.id !== undefined && !q) { await chrome.tabs.update(existing[0].id, { active: true }); return; }
  await chrome.tabs.create({ url });
}

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  const e = tab?.id !== undefined ? tabs.get(tab.id) : undefined;
  if (command === 'open-board') return openBoard();
  if (command === 'toggle-overlay') { e?.content?.postMessage({ type: 'toggle-overlay' }); return; }
  if (command === 'toggle-analysis') {
    if (e?.overlays.size) e.overlays.forEach((o) => o.postMessage({ type: 'command', command: 'toggle-analysis' }));
    else chrome.runtime.sendMessage({ type: 'command', command: 'toggle-analysis' }).catch(() => {});
  }
});

// ---------------- one-shot requests ----------------

async function tabStatus(tabId: number, url?: string): Promise<TabStatus> {
  const s = await loadSettings();
  if (!s.enabled) return { state: 'disabled' };
  const v = classifyUrl(url);
  if (v.status === 'unsupported') return { state: 'unsupported', reason: v.reason };
  if (v.status === 'blocked') return { state: 'blocked', reason: v.reason };
  const site = siteForUrl(url)!;
  if (!(await chrome.permissions.contains({ origins: [site.origin] }))) return { state: 'needs-permission', origin: site.origin, label: site.label };
  return { state: 'ready', label: site.label, injected: !!tabs.get(tabId)?.content };
}

chrome.runtime.onMessage.addListener((msg: RuntimeRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    switch (msg.type) {
      case 'open-board': await openBoard({ ...(msg.fen ? { fen: msg.fen } : {}), ...(msg.tab ? { tab: msg.tab } : {}) }); return { ok: true };
      case 'notify': {
        const s = await loadSettings();
        if (s.general.notifications) chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: msg.title, message: msg.message });
        return { ok: true };
      }
      case 'tab-status': return tabStatus(msg.tabId, msg.url);
      case 'inject': {
        const tab = await chrome.tabs.get(msg.tabId);
        const st = await tabStatus(msg.tabId, tab.url);
        if (st.state !== 'ready') return { ok: false, status: st };
        if (!st.injected) await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['content.js'] });
        else tabs.get(msg.tabId)?.content?.postMessage({ type: 'toggle-overlay' });
        return { ok: true };
      }
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
