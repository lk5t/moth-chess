import { DEFAULT_SETTINGS, mergeSettings, validateSettings, type Settings, type SettingsPatch } from './schema';
import { kvGet, kvSet, kvSubscribe } from '@/storage/kv';

export const SETTINGS_KEY = 'moth.settings.v1';

export async function loadSettings(): Promise<Settings> {
  return validateSettings(await kvGet(SETTINGS_KEY));
}

// Writes are serialised so rapid successive patches (sliders, toggles) never overwrite each other.
let writeChain: Promise<unknown> = Promise.resolve();
export function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const run = writeChain.then(async () => {
    const next = mergeSettings(await loadSettings(), patch);
    await kvSet(SETTINGS_KEY, next);
    return next;
  });
  writeChain = run.catch(() => {});
  return run;
}

export async function resetSettings(): Promise<Settings> {
  await kvSet(SETTINGS_KEY, DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export function subscribeSettings(cb: (s: Settings) => void) {
  return kvSubscribe(SETTINGS_KEY, (v) => cb(validateSettings(v)));
}

