# MOTH Chess 3.0 "FREEDOM": development progress

This file records the status of every phase. Status values:

- **done**: implemented and covered by tests that ran in CI.
- **partial**: some parts are implemented; the remaining work is listed.
- **deferred**: not done in 3.0, with the reason given.
- **todo**: not started.

"Tests" always means tests that actually ran in CI (GitHub Actions, Ubuntu, Chromium, plus Brave where noted). Nothing is marked done on the strength of a local guess.

## Phase 1: Repository audit (done)

### Codebase at the start of 3.0

- About 10,800 lines of TypeScript and React.
- The C++ engine (`engine/moth/moth.cpp`), compiled to WebAssembly.
- 174 unit tests and 27 browser tests at v2.0.1.

| Area | Files | State at start |
|---|---|---|
| Chess core | `src/chess/*` (chess.js wrapper, geometry) | Working, tested |
| Stockfish | `public/engines/*`, `src/engine/*` (UCI controller, worker transport) | Working; crash recovery restarted immediately with no backoff, and the restart counter never reset (5 crashes in a whole session disabled analysis) |
| MOTH Engine | `engine/moth`, `src/moth-engine/*` | Working. Perft is verified. Network 2.0.4 is approved through the gate. |
| Training | `src/moth-engine/training/*`, `scripts/moth/*` | Working (CI and local) |
| Analysis UI | `src/board-app`, `src/components/panels/*` | Working, but there were 12 flat sections in a 56 px icon rail with no labels, which made it hard to navigate |
| Overlay / HUD | `src/content/*`, `src/overlay-app/*` | Working. Layout was fixed, the panel could cover the site's move list, and it did not observe the orientation wrapper. |
| Fair play | `fair-play/sites.json`, `src/content/detector/sites.ts` | Working but coarse. All of `chess.com/game/*` and `/puzzles*` were blocked, including finished games. Rated-puzzle review was impossible. |
| Memory | `src/memory/*` (Dexie v3) | Working. **Bug:** the `practice`, `latency` and `runs` tables were exported but never re-imported. |
| Settings | `src/settings/*` | Working. There was no schema version, and "About" still said v1.0. |
| Popup | `src/popup` | Working, but crowded with the shortcuts list. |

### Duplication and debt found

- The Settings page repeated its site-access controls.
- The board header said "MOTH Chess" on every section.
- The welcome banner on the board page duplicated the onboarding.
- The overlay drew a second engine select next to the one in the Analysis panel.

### Background activity found

- The service worker has no timers.
- The content script polls the fair-play status every 800 ms, which is cheap: a URL check plus 4 selector checks.
- Engine workers shut down after 90 s idle.
- No unnecessary background processes were found.

## Phase 2: Workspace 3.0 (todo)
## Phase 3: Fair-play overhaul (todo)
## Phase 4: MOTH Engine 3.0 (todo)
## Phase 5: Analysis Studio (todo)
## Phase 6: Opening Explorer (todo)
## Phase 7: Endgame Intelligence (todo)
## Phase 8: MOTH Coach (todo)
## Phase 9: Player DNA (todo)
## Phase 10: Adaptive training (todo)
## Phase 11: Play against MOTH (todo)
## Phase 12: Instant analysis (todo)
## Phase 13: Board support (todo)
## Phase 14: Engine Laboratory (todo)
## Phase 15: Self-play (todo)
## Phase 16: Neural evaluation 2.0 (todo)
## Phase 17: Game Library (todo)
## Phase 18: Smart game reports (todo)
## Phase 19: Updates (todo)
## Phase 20: Integration (todo)
## Phase 21: Storage and migrations (partial)

The 2.1 groundwork, carried into 3.0:

- A versioned settings schema (`settingsVersion`) and `migrateSettings`.
- Recovery from corrupted settings, with the original kept under a side key.
- Backup format v3, which still accepts 2.0 exports.

## Phase 22: Testing (todo)
## Phase 23: Brave release verification (todo)
## Phase 24: Final review (todo)
