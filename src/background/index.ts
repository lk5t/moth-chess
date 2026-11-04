// MOTH Chess service worker: lifecycle, dynamic content-script registration (only on permitted analysis
// pages), tab-scoped message relay between the content script and the overlay frame, commands, notifications.
import { SITES, classifyUrl, siteForUrl, type SiteDef } from '@/content/detector/sites';
import { PORT_CONTENT, PORT_OVERLAY, type RuntimeRequest, type TabStatus } from '@/utils/messages';
import { loadSettings, migrateStoredSettings, SETTINGS_KEY } from '@/settings/store';
import { logError } from '@/diagnostics/log';
import { checkForUpdate, recordInstalled, updateAvailable } from '@/updates/updates';

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

// Settings are migrated in place (never reset) on install/update and at browser start-up, which also repairs
// unreadable settings. Content-script registration failures are logged locally, not thrown away.
async function safeSync() { try { await syncContentScripts(); } catch (e) { await logError('service worker', `content script registration failed: ${String((e as Error)?.message ?? e)}`); } }
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const m = await migrateStoredSettings();
    if (m.corrupt) await logError('settings', 'Stored settings were unreadable and were reset to defaults (the original was kept for diagnostics).');
  } catch (e) { await logError('settings', `migration failed: ${String((e as Error)?.message ?? e)}`); }
  await safeSync();
  if (details.reason === 'update' || details.reason === 'install') await recordInstalled(chrome.runtime.getManifest().version, details.previousVersion);
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});
// Browser start: repair settings, then (if enabled) a once-a-day release check that only sets a badge.
chrome.runtime.onStartup.addListener(async () => {
  try { await migrateStoredSettings(); } catch { /* logged on next install */ }
  void safeSync();
  try {
    if (!(await loadSettings()).updates.auto) return;
    const v = chrome.runtime.getManifest().version;
    if (updateAvailable(await checkForUpdate(v), v)) { await chrome.action.setBadgeText({ text: 'new' }); await chrome.action.setBadgeBackgroundColor({ color: '#6d4dff' }); }
  } catch { /* offline */ }
});
chrome.permissions.onAdded.addListener(() => { void safeSync(); });
chrome.permissions.onRemoved.addListener(() => { void safeSync(); broadcastTeardown('Site access was removed'); });
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
  if (v.status === 'blocked' && !v.pending) return { state: 'blocked', reason: v.reason };
  const site = siteForUrl(url)!;
  if (!(await chrome.permissions.contains({ origins: [site.origin] }))) return { state: 'needs-permission', origin: site.origin, label: site.label };
  const injected = !!tabs.get(tabId)?.content;
  // review pages: the URL alone cannot show "finished", so ask the page (its DOM check is authoritative)
  if (v.status === 'blocked') return injected ? { state: 'ready', label: site.label, injected } : { state: 'pending', reason: v.reason, label: site.label };
  return { state: 'ready', label: site.label, injected };
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
