// Supported analysis contexts and fair-play classification.
//
// MOTH only integrates with pages where engine assistance is explicitly permitted by the site
// (analysis boards and unrated practice). Anything that looks like a live/rated game — by URL or by
// DOM evidence such as running clocks — is BLOCKED, and the classification fails closed: when in doubt, block.

import rules from '../../../fair-play/sites.json';

// Rules live in /fair-play/sites.json (source) and are compiled in at build time.
export type SiteId = string;

/** Fair-play disclaimer shown on Home, in Settings, onboarding and wherever assistance is unavailable. */
export const DISCLAIMER = 'MOTH Chess is intended for chess education, training, research, and analysis. We do not encourage cheating, unfair competitive advantages, or violations of chess platform rules. Users are responsible for following the rules of the platforms on which they play.';
export type AdapterKind = 'chessground' | 'chesscom';

export interface SiteDef {
  id: SiteId;
  label: string;
  hosts: string[];
  origin: string; // optional host permission
  adapter: AdapterKind;
  /** Content script match patterns (restricted to supported paths). */
  matches: string[];
  liveDom: string[];
  allow: { path: RegExp; context: string }[];
  /** Pages that become analysable only when the page shows a finished state (game over, puzzle solved). */
  review: { path: RegExp; context: string; requireDom: string[]; pendingReason: string }[];
  block: { path: RegExp; reason: string }[];
  unsupportedReason: string;
}

interface RawSite { id: string; label: string; hosts: string[]; origin: string; adapter: string; matches: string[]; liveDom?: string[]; allow?: { path: string; context: string }[]; review?: { path: string; context: string; requireDom: string[]; pendingReason?: string }[]; block?: { path: string; reason: string }[]; unsupportedReason?: string }

export const SITES: SiteDef[] = (rules.sites as RawSite[]).map((r) => ({
  id: r.id, label: r.label, hosts: r.hosts, origin: r.origin,
  adapter: (r.adapter === 'chesscom' ? 'chesscom' : 'chessground') as AdapterKind,
  matches: r.matches, liveDom: r.liveDom ?? [],
  allow: (r.allow ?? []).map((a) => ({ path: new RegExp(a.path), context: a.context })),
  review: (r.review ?? []).map((v) => ({ path: new RegExp(v.path), context: v.context, requireDom: v.requireDom ?? [], pendingReason: v.pendingReason ?? 'Engine help turns on when this page shows a finished game' })),
  block: (r.block ?? []).map((b) => ({ path: new RegExp(b.path), reason: b.reason })),
  unsupportedReason: r.unsupportedReason ?? `Only supported ${r.label} pages`,
}));

export interface PageProbe {
  hostname: string;
  pathname: string;
  /** true if a selector matches in the document */
  has(selector: string): boolean;
}

export type PageVerdict =
  | { status: 'supported'; site: SiteId; context: string }
  /** pending: a review page (game/puzzle) that is not finished yet — re-checked when the page changes. */
  | { status: 'blocked'; site: SiteId; reason: string; pending?: boolean }
  | { status: 'unsupported'; reason: string };

export function siteForHost(hostname: string): SiteDef | undefined {
  const h = hostname.toLowerCase();
  return SITES.find((s) => s.hosts.includes(h));
}

/**
 * Fail closed: live-game DOM evidence blocks first, then allow rules, then review rules (supported only with
 * positive "finished" evidence on the page — uncertain states stay blocked), then block rules, else unsupported.
 * Only engine assistance on the page is gated; nothing else in MOTH depends on this verdict.
 */
export function classifyPage(p: PageProbe): PageVerdict {
  const site = siteForHost(p.hostname);
  if (!site) return { status: 'unsupported', reason: 'MOTH does not integrate with this website' };
  const path = p.pathname || '/';
  for (const sel of site.liveDom) if (p.has(sel)) return { status: 'blocked', site: site.id, reason: 'Live-game elements (running clocks) detected on this page' };
  for (const a of site.allow) if (a.path.test(path)) return { status: 'supported', site: site.id, context: a.context };
  for (const v of site.review) {
    if (!v.path.test(path)) continue;
    if (v.requireDom.some((sel) => p.has(sel))) return { status: 'supported', site: site.id, context: v.context };
    return { status: 'blocked', site: site.id, reason: v.pendingReason, pending: true };
  }
  for (const b of site.block) if (b.path.test(path)) return { status: 'blocked', site: site.id, reason: b.reason };
  return { status: 'unsupported', reason: site.unsupportedReason };
}

export function classifyUrl(url: string | undefined): PageVerdict {
  if (!url) return { status: 'unsupported', reason: 'No URL' };
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return { status: 'unsupported', reason: 'Not an https page' };
    // URL-only probe: DOM checks run again inside the page.
    return classifyPage({ hostname: u.hostname, pathname: u.pathname, has: () => false });
  } catch {
    return { status: 'unsupported', reason: 'Invalid URL' };
  }
}

export function siteById(id: SiteId) { return SITES.find((s) => s.id === id)!; }
export function siteForUrl(url?: string): SiteDef | undefined {
  try { return siteForHost(new URL(url ?? '').hostname); } catch { return undefined; }
}
