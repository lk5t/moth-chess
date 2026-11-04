// Updates (v3). Browsers update store-installed extensions themselves; MOTH Chess is distributed as an
// unpacked build from GitHub Releases, which browsers never update automatically. So MOTH:
//   • shows the installed version and its release notes,
//   • optionally checks GitHub's public releases API (at most once a day, no identifiers sent) and shows a
//     notice with a link to the release — the user downloads and reloads it themselves,
//   • for store installs, asks the browser's own updater (chrome.runtime.requestUpdateCheck).
// It never downloads or installs code by itself.
import { kvGet, kvSet } from '@/storage/kv';

export const RELEASES_API = 'https://api.github.com/repos/lk5t/moth-chess/releases/latest';
export const RELEASES_PAGE = 'https://github.com/lk5t/moth-chess/releases';
export const UPDATE_KEY = 'moth.update.v1';
const DAY = 24 * 3600e3;

export interface UpdateState { checkedAt?: number; latest?: string; url?: string; notes?: string; error?: string; installed?: { from?: string; to: string; at: number; seen: boolean } }

/** Numeric semver compare: 1 if a > b, -1 if a < b, 0 if equal. Ignores a leading "v" and pre-release tags. */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

export async function readUpdateState(): Promise<UpdateState> { return ((await kvGet<UpdateState>(UPDATE_KEY)) ?? {}) as UpdateState; }
async function patch(p: Partial<UpdateState>) { await kvSet(UPDATE_KEY, { ...(await readUpdateState()), ...p }); }

/** Record an install/upgrade so the UI can show “Updated to X — what's new” once. */
export async function recordInstalled(to: string, from?: string) { await patch({ installed: { from, to, at: Date.now(), seen: false } }); }
export async function markInstalledSeen() { const s = await readUpdateState(); if (s.installed) await patch({ installed: { ...s.installed, seen: true } }); }

export function isStoreInstall(): boolean {
  try { return !!chrome.runtime.getManifest().update_url; } catch { return false; }
}

/** Check GitHub for a newer release. `force` ignores the once-a-day limit (user pressed the button). */
export async function checkForUpdate(current: string, opts: { force?: boolean; fetcher?: typeof fetch } = {}): Promise<UpdateState> {
  const st = await readUpdateState();
  if (!opts.force && st.checkedAt && Date.now() - st.checkedAt < DAY) return st;
  try {
    const r = await (opts.fetcher ?? fetch)(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const j = (await r.json()) as { tag_name?: string; html_url?: string; body?: string };
    const latest = String(j.tag_name ?? '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error('No release version found');
    await patch({ checkedAt: Date.now(), latest, url: j.html_url ?? RELEASES_PAGE, notes: (j.body ?? '').slice(0, 4000), error: undefined });
  } catch (e) {
    await patch({ checkedAt: Date.now(), error: String((e as Error)?.message ?? e) });
  }
  const out = await readUpdateState();
  void current;
  return out;
}

export const updateAvailable = (st: UpdateState, current: string) => !!st.latest && compareVersions(st.latest, current) > 0;
