import { useEffect, useState, useCallback } from 'react';
import { DEFAULT_SETTINGS, mergeSettings, type Settings, type SettingsPatch } from './schema';
import { loadSettings, saveSettings, subscribeSettings } from './store';

export function useSettings(): [Settings, (p: SettingsPatch) => Promise<void>, boolean] {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    loadSettings().then((v) => { if (alive) { setS(v); setLoaded(true); } });
    const off = subscribeSettings((v) => alive && setS(v));
    return () => { alive = false; off(); };
  }, []);
  // optimistic: controls reflect the change immediately; storage is the source of truth afterwards
  const update = useCallback(async (p: SettingsPatch) => {
    setS((cur) => mergeSettings(cur, p));
    setS(await saveSettings(p));
  }, []);
  return [s, update, loaded];
}
