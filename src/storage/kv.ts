// chrome.storage.local wrapper with an in-memory fallback (tests / non-extension contexts).
const mem = new Map<string, unknown>();
const memListeners = new Set<(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void>();

const hasChrome = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;

export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (hasChrome()) {
    const r = await chrome.storage.local.get(key);
    return r[key] as T | undefined;
  }
  return mem.get(key) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  if (hasChrome()) return chrome.storage.local.set({ [key]: value });
  const old = mem.get(key);
  mem.set(key, value);
  memListeners.forEach((l) => l({ [key]: { newValue: value, oldValue: old } }));
}

export async function kvRemove(key: string): Promise<void> {
  if (hasChrome()) return chrome.storage.local.remove(key);
  mem.delete(key);
}

export function kvSubscribe(key: string, cb: (v: unknown) => void): () => void {
  if (hasChrome()) {
    const l = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && key in changes) cb(changes[key].newValue);
    };
    chrome.storage.onChanged.addListener(l);
    return () => chrome.storage.onChanged.removeListener(l);
  }
  const l = (changes: Record<string, { newValue?: unknown }>) => { if (key in changes) cb(changes[key].newValue); };
  memListeners.add(l);
  return () => memListeners.delete(l);
}

export async function kvBytesInUse(): Promise<number | undefined> {
  if (hasChrome() && chrome.storage.local.getBytesInUse) return chrome.storage.local.getBytesInUse(null);
  return undefined;
}
