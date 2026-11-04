import { DEFAULT_SETTINGS, mergeSettings, migrateSettings, type Settings, type SettingsPatch } from './schema';
import { withProfileTracking } from './profiles';
import { kvGet, kvSet, kvSubscribe } from '@/storage/kv';

// Key kept from v1 so existing installs keep their settings; the schema version lives inside the value.
export const SETTINGS_KEY = 'moth.settings.v1';
export const MIGRATION_KEY = 'moth.settings.migration';

export async function loadSettings(): Promise<Settings> {
  return migrateSettings(await kvGet(SETTINGS_KEY)).settings;
}

/**
 * Run the stored-settings migration once (service worker onInstalled / startup). Writes the upgraded value
 * back and records what changed; the unreadable original is kept under a side key rather than discarded.
 */
export async function migrateStoredSettings(): Promise<{ from: number; changed: string[]; corrupt: boolean }> {
  const raw = await kvGet(SETTINGS_KEY);
  const m = migrateSettings(raw);
  if (raw === undefined || m.changed.length || (raw as any)?.settingsVersion !== m.settings.settingsVersion) {
    if (m.corrupt) await kvSet(`${SETTINGS_KEY}.corrupt`, { at: Date.now(), value: String(raw).slice(0, 2000) });
    await kvSet(SETTINGS_KEY, m.settings);
    if (m.changed.length) await kvSet(MIGRATION_KEY, { at: Date.now(), from: m.from, to: m.settings.settingsVersion, changed: m.changed, corrupt: m.corrupt });
  }
  return { from: m.from, changed: m.changed, corrupt: m.corrupt };
}

// Writes are serialised so rapid successive patches (sliders, toggles) never overwrite each other.
let writeChain: Promise<unknown> = Promise.resolve();
export function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const run = writeChain.then(async () => {
    const cur = await loadSettings();
    const next = mergeSettings(cur, withProfileTracking(cur, patch, mergeSettings));
    await kvSet(SETTINGS_KEY, next);
    return next;
  });
  writeChain = run.catch(() => {});
  return run;
}

export async function resetSettings(): Promise<Settings> {
  // a reset keeps onboarding state so the welcome flow does not reappear
  const cur = await loadSettings();
  const next = { ...DEFAULT_SETTINGS, onboarding: cur.onboarding };
  await kvSet(SETTINGS_KEY, next);
  return next;
}

export function subscribeSettings(cb: (s: Settings) => void) {
  return kvSubscribe(SETTINGS_KEY, (v) => cb(migrateSettings(v).settings));
}
