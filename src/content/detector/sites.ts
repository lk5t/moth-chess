// Supported analysis contexts and fair-play classification.
//
// MOTH only integrates with pages where engine assistance is explicitly permitted by the site
// (analysis boards and unrated practice). Anything that looks like a live/rated game — by URL or by
// DOM evidence such as running clocks — is BLOCKED, and the classification fails closed: when in doubt, block.

export type SiteId = 'lichess' | 'chesscom';

export interface SiteDef {
  id: SiteId;
  label: string;
  origin: string; // optional host permission
  /** Content script match patterns (restricted to analysis paths). */
  matches: string[];
}

export const SITES: SiteDef[] = [
  { id: 'lichess', label: 'Lichess analysis board, studies & practice', origin: 'https://lichess.org/*', matches: ['https://lichess.org/analysis*', 'https://lichess.org/practice/*', 'https://lichess.org/study/*'] },
  { id: 'chesscom', label: 'Chess.com analysis board', origin: 'https://www.chess.com/*', matches: ['https://www.chess.com/analysis*'] },
];

export interface PageProbe {
  hostname: string;
  pathname: string;
  /** true if a selector matches in the document */
  has(selector: string): boolean;
}

export type PageVerdict =
  | { status: 'supported'; site: SiteId; context: 'analysis' | 'practice' | 'study' }
  | { status: 'blocked'; site: SiteId; reason: string }
  | { status: 'unsupported'; reason: string };

const LICHESS_BLOCKED_PATHS: [RegExp, string][] = [
  [/^\/(tv|games|training|streak|storm|racer|tournament|swiss|simul|broadcast|setup|challenge)\b/, 'Live, rated or competitive Lichess page'],
  [/^\/[A-Za-z0-9]{8}(\/(white|black))?\/?$/, 'Lichess game page (live or finished game view)'],
  [/^\/[A-Za-z0-9]{12}\/?$/, 'Lichess game page (player view)'],
];
const LICHESS_LIVE_DOM = ['.rclock', '.round__app', 'main.round', '.ricons', '.follow-up .fbt.new-opponent'];

const CHESSCOM_BLOCKED_PATHS: [RegExp, string][] = [
  [/^\/(play|live|game\/live|game\/daily|daily|tournament|arena|puzzles|puzzle-rush|puzzle-battle|variants|lessons\/quiz)\b/, 'Live, rated or competitive Chess.com page'],
];
const CHESSCOM_LIVE_DOM = ['.clock-component.clock-player-turn', '.clock-player-turn', '[data-cy="clock-running"]', '.board-layout-player .clock-running'];

export function classifyPage(p: PageProbe): PageVerdict {
  const host = p.hostname.replace(/^www\./, '');
  const path = p.pathname || '/';
  if (host === 'lichess.org') {
    // Fail closed: DOM evidence of a live game blocks every Lichess page, including analysis URLs.
    for (const sel of LICHESS_LIVE_DOM) if (p.has(sel)) return { status: 'blocked', site: 'lichess', reason: 'Live-game elements (clocks) detected on this page' };
    // Reserved Lichess routes are recognised before the game-ID patterns ("/analysis" is 8 characters long,
    // exactly like a game ID).
    if (/^\/analysis(\/|$)/.test(path)) return { status: 'supported', site: 'lichess', context: 'analysis' };
    if (/^\/practice\//.test(path)) return { status: 'supported', site: 'lichess', context: 'practice' };
    // studies are analysis documents (not games); the clock check above still applies
    if (/^\/study\/(?!broadcast)[A-Za-z0-9]{8}(\/[A-Za-z0-9]{8})?\/?$/.test(path)) return { status: 'supported', site: 'lichess', context: 'study' };
    for (const [re, reason] of LICHESS_BLOCKED_PATHS) if (re.test(path)) return { status: 'blocked', site: 'lichess', reason };
    return { status: 'unsupported', reason: 'Only the Lichess analysis board, studies and Practice are supported' };
  }
  if (host === 'chess.com') {
    for (const [re, reason] of CHESSCOM_BLOCKED_PATHS) if (re.test(path)) return { status: 'blocked', site: 'chesscom', reason };
    for (const sel of CHESSCOM_LIVE_DOM) if (p.has(sel)) return { status: 'blocked', site: 'chesscom', reason: 'A running clock was detected on this page' };
    if (/^\/analysis(\/|$)/.test(path)) return { status: 'supported', site: 'chesscom', context: 'analysis' };
    return { status: 'unsupported', reason: 'Only the Chess.com analysis board is supported' };
  }
  return { status: 'unsupported', reason: 'MOTH does not integrate with this website' };
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
  try {
    const h = new URL(url ?? '').hostname.replace(/^www\./, '');
    return h === 'lichess.org' ? siteById('lichess') : h === 'chess.com' ? siteById('chesscom') : undefined;
  } catch { return undefined; }
}
