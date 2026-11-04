// Versioned changelog shown in the Control Center (kept in sync with CHANGELOG.md).
export interface ChangelogEntry { version: string; date: string; title: string; items: string[] }

export const CHANGELOG: ChangelogEntry[] = [
  { version: '2.1.0', date: '2026-11', title: 'Expansion (public beta)', items: [
    'New look: redesigned interface, new MOTH logo, grouped navigation and sectioned settings.',
    'Control Center: engine status and self-checks, performance profile, website status, backups, diagnostics and this changelog.',
    'Performance profiles: Eco, Standard and Performance.',
    'Customisable analysis HUD: compact layout, evaluation bar side, number of arrows, best-move squares, and a panel that keeps itself off the board.',
    'Board recognition follows boards that load late or are replaced, orientation flips and in-page navigation.',
    'Automatic recovery: engine restarts with back-off and stops after repeated failures instead of looping; clear error messages with “Restart engine”.',
    'First-run welcome tour (can be reopened from Settings or the Control Center).',
    'Backup & restore with validation and preview; 2.0 Memory exports are still accepted.',
    'Local diagnostic reports you review before sharing; nothing is uploaded automatically.',
    'Settings are migrated from 2.0 without losing your choices.',
    'Fixed: practice games, latency samples and training runs were exported but not re-imported.',
  ] },
  { version: '2.0.1', date: '2026-11', title: 'Games vs the computer', items: ['On-board suggestions on Chess.com games against the computer (unrated, no human opponent). Clocks still block.'] },
  { version: '2.0.0', date: '2026-11', title: 'Evolution', items: [
    'MOTH Engine: original C++ engine compiled to WebAssembly, with a trained evaluation network and three playing styles.',
    'Play MOTH offline, opening book, learning pipeline with promotion gate, personal adaptation.',
    'Automatic board recognition and on-board suggestions on allowed analysis boards.',
  ] },
  { version: '1.0.0', date: '2026-10', title: 'First release', items: ['Local Stockfish analysis, MOTH Intelligence, Threat Vision, Neural Map, Game Review, Coach and Memory.'] },
];

/** Feature maturity, shown so unfinished parts are clearly identified. */
export const FEATURE_STATUS: { name: string; status: 'Stable' | 'Beta' | 'Experimental'; note: string }[] = [
  { name: 'Analysis board (MOTH Engine / Stockfish)', status: 'Stable', note: 'Fully local; covered by automated tests.' },
  { name: 'Game Review, Coach, Memory, Openings', status: 'Stable', note: '' },
  { name: 'Threat Vision, Neural Map, What-If Simulator', status: 'Stable', note: 'Heuristic explanations are labelled as such.' },
  { name: 'Play MOTH', status: 'Stable', note: '' },
  { name: 'On-board HUD on Lichess', status: 'Beta', note: 'Tested against recorded page structures, not every live variant of the site.' },
  { name: 'On-board HUD on Chess.com', status: 'Beta', note: 'Chess.com does not expose side-to-move on every page; you may be asked to confirm it.' },
  { name: 'Learning Lab (in-browser training)', status: 'Experimental', note: 'Slow on low-end devices; candidates are only promoted when they pass the gate.' },
  { name: 'Personal adaptation', status: 'Beta', note: 'Needs several practice games before it changes anything.' },
  { name: 'Brave support', status: 'Beta', note: 'Verified in automated Brave runs; please report anything Brave-specific.' },
];
