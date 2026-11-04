import { DEFAULT_SETTINGS, mergeSettings, validateSettings, type Settings, type SettingsPatch } from './schema';
import { kvGet, kvSet, kvSubscribe } from '@/storage/kv';

export const SETTINGS_KEY = 'moth.settings.v1';

export async function loadSettings(): Promise<Settings> {
  return validateSettings(await kvGet(SETTINGS_KEY));
}

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const next = mergeSettings(await loadSettings(), patch);
  await kvSet(SETTINGS_KEY, next);
  return next;
}

export async function resetSettings(): Promise<Settings> {
  await kvSet(SETTINGS_KEY, DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export function subscribeSettings(cb: (s: Settings) => void) {
  return kvSubscribe(SETTINGS_KEY, (v) => cb(validateSettings(v)));
}

