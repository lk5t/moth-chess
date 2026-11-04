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

## Phase 2: Workspace 3.0 (done)

- The 12 flat sections became 5 workspaces (Home, Analyze, Train, Library, Engine Lab), each with a few tabs.
- Progressive disclosure:
  - Simple mode keeps 4 advanced tools under "More tools" and hides Engine Lab.
  - Engine options are collapsed.
  - The FEN/PGN box is collapsed.
- Home has the four main actions, quick analysis, recent items and engine status.
- The interface remembers the last section, and there is a *Reset layout* button.
- The new logo is the lumen moth, with a matching design system.
- Settings went from 10 cards on one page to 6 sections (General, Appearance, Engine performance, Website compatibility, Data management, About & updates).
- The popup is decluttered.
- Smaller windows are supported: the sidebar collapses to icons below 1100 px and the panels stack below 900 px.
- Tests: the workspace e2e test walks every workspace and section in Simple and Full mode and checks that the last section persists.

## Phase 3: Fair-play overhaul (done)

- The `review` rules are new. Finished games and solved or failed puzzles become analysable only when the page shows that state. Until then the page is *pending*: MOTH stays in standby, draws nothing and runs no engine.
- Lessons, the board editor and the explorer are now allowed.
- The content script is now registered on the whole site, which removes the blanket path restriction. The classifier still gates assistance on every page.
- The 800 ms poll was replaced by DOM-change-driven checks (500 ms throttle, 2 s fallback) plus navigation events.
- The disclaimer appears on Home, in the popup, in Settings and in the welcome tour.
- Running clocks, live, rated and tournament games, and timed puzzle modes stay blocked with no unlock.
- Tests:
  - Unit tests cover pending vs supported, clock-beats-evidence, and timed modes that can never unlock.
  - An e2e test checks that a finished game unlocks and that a running clock removes the HUD again.

## Phase 4: MOTH Engine 3.0 (partial)

Search changes:

- countermove heuristic
- history gravity, with a malus for quiet moves that failed
- logarithmic LMR, adjusted by history and the "improving" flag
- futility pruning
- "improving"-aware reverse futility pruning and late-move pruning
- two-slot TT buckets

Measured, all on the same network:

- 120 games at 20k nodes: **+58.5 ± 50.8 Elo** (LOS 98.8%).
- 120 games at 40 ms/move against the 2.0 build: +31.9 ± 52.2 (LOS 88.6%). This is not statistically significant.
- TT buckets alone: 0 ± 46.
- Tactics at 100 ms: 224/235 vs 225/235.
- Nodes to depth 8: −17%. Raw speed: −13% knps.

An evaluation experiment (pawn threats, connected pawns, rook on the 7th) scored +4 Elo over 320 games. That is not measurable, so it was **not shipped**.

Deferred:

- Multithreading. Overlay frames cannot use SharedArrayBuffer.
- Larger evaluation changes. They need a retrained network.

The data is in `docs/bench/engine-3.0.json`.

## Phase 5: Analysis Studio (done)

- New: an evaluation graph by move (analysed positions; click to jump), undo/redo (Ctrl+Z/Y, buttons), collapsed engine options with explanations, an Endgame tab, and an exportable game report.
- Already present and kept: MultiPV, explanations, bookmarks (save position), annotations, FEN/PGN import/export, depth and engine switching.

## Phase 6: Opening Explorer (done)

- Common responses come from MOTH's Stockfish-validated book: eval, games, score and tags such as gambit, trap and mistake.
- "In your games" shows the moves you played at a position and your score with each. It uses the position index, so transpositions are included.
- Typical plans are given per opening family.
- Repertoire: save a line as White or Black, then drill it with spaced repetition in Practice.
- Recognition, search and favourites were already present.
- The repertoire is stored in IndexedDB v4.

## Phase 7: Endgame Intelligence (done, limited by design)

- KPK is exact: a local retrograde bitbase computed in milliseconds and tested on opposition, rook pawn and symmetry positions.
- Rules and theory cover basic mates, KBNK, insufficient material, Philidor and Lucena detection, opposite-coloured bishops, and pawn races by the rule of the square.
- There are 8 training drills, playable against MOTH.
- Syzygy tablebases are **not included**: they are gigabytes. This limit is stated in the UI.

## Phase 8: MOTH Coach (done, extended)

- The existing coach already builds exercises from your mistakes, explains them and shows weaknesses.
- 3.0 adds post-game reports, the Practice recommendations and the DNA link.
- Phase-specific guidance is shown when the data supports it.

## Phase 9: Player DNA (done)

Player DNA covers:

- openings and your score with each
- accuracy and its trend
- mistakes by phase
- missed motifs
- endgame drill results
- training success
- style observations, only from measured data

Charts are included and the profile can be reset. Games are never deleted.

## Phase 10: Adaptive training (done)

- Recommendations come from what is due plus DNA.
- Endgame drill level goes up after 2 successes and down after 2 failures.
- Repertoire drills use Leitner boxes.
- Training history is recorded.
- Generated exercises reuse the reviewed engine positions, so they are legal and engine-verified.

## Phase 11: Play against MOTH (done)

- 3.0 adds: custom starting positions (the current board or an endgame drill), draw offers (MOTH declines when it thinks it is better or before move 20), drill goals that are recorded, and correct PGN SetUp/FEN headers.
- Already present: seven levels that change depth and noise, three styles, clocks, takebacks, resign and review.

## Phase 12: Instant analysis (done)

- Heavy sections are lazy-loaded: 9 panels moved out of the board bundle.
- No engine runs on Home, Play, Practice or Engine Lab.
- Revisited positions are served from the cache. This is measured in `perf.spec`.
- Obsolete searches are cancelled (as before).
- The debounce and idle shutdown are set by the profile.

## Phase 13: Board support (done)

- The largest visible board is used when a page has several.
- The orientation wrapper is observed.
- A document observer catches boards that load late or are replaced.
- Navigation events trigger an immediate re-check.
- Each adapter has an `avoid()` list, so the HUD stays off the site's controls.
- The popup explains unsupported, blocked and pending pages.
- Standalone FEN/PGN analysis is on Home.

## Phase 14: Engine Laboratory (done)

- MOTH vs Stockfish: puzzles solved, nodes/s and depth at the same time per move.
- MOTH-vs-MOTH matches with configurable sides (style, network or classical, nodes or ms).
- Results history with JSON export.
- Offline: `scripts/moth/ab.ts` and `scripts/moth/tactics-ab.ts`.

## Phase 15: Self-play (done)

- Matches run in a dedicated worker, with openings from the book and both colours.
- Games are posted as they finish, so stopping keeps them and *Resume* continues from that game.
- PGNs can be downloaded or saved to the Library, where they become Learning Lab training data.

## Phase 16: Neural evaluation 2.0 (partial)

- Kept from 2.0: the versioned registry, the gate and rollback, the checksum, and the classical fallback.
- Added in 3.0: a missing or unreadable model now produces a visible warning, and MOTH keeps analysing with its classical evaluation. This is e2e-tested.
- Not done: no new network was trained in this cycle, so no improvement is claimed.

## Phase 17: Game Library (done)

- 3.0 adds self-play import and ties the Library to the Explorer, DNA and reports.
- Already present: PGN import (batched), folders, tags, search, favourites, duplicates and export.

## Phase 18: Smart game reports (done)

Reports cover:

- summary and opening
- critical moments
- missed opportunities
- strong moves
- accuracy by phase
- strengths and weaknesses
- training yield
- the documented accuracy method

They can be exported as Markdown.

## Phase 19: Updates (done)

- The installed version is shown.
- A daily GitHub Releases check runs at start-up and can be turned off. A newer release triggers a badge and a notice. MOTH never downloads anything.
- After an upgrade, Home shows "Updated to X" once.
- Store installs use `requestUpdateCheck`.

## Phase 20: Integration (done)

These connections are in place:

- Coach ↔ DNA (`analyseWeaknesses` feeds both).
- DNA ↔ Practice.
- Library ↔ reports.
- Explorer ↔ Analysis (`play` and `loadLine`).
- Endgame ↔ Practice ↔ Play.
- Engine Lab ↔ self-play ↔ Library ↔ Learning Lab.
- Adapters ↔ the HUD.

## Phase 21: Storage and migrations (done)

- Settings: schema v3.
  - Migration from 2.0 keeps every value; tuned engines are marked Custom and 2.0 users get Full mode.
  - Corrupt values are repaired, with the original kept under a side key.
  - Migration runs on install, update and start-up, and is idempotent.
- IndexedDB v4 adds the repertoire and trainingLog tables (additive).
- Backup v3 accepts 2.0 exports and includes the new tables.
- The 2.0 bug where practice, runs and latency were exported but never re-imported is fixed.
- Restore merges records and never deletes.

## Phase 22: Testing (done; all ran in CI, commit 9daa2f7)

- **Unit (Vitest):** 216 pass. They cover:
  - move legality and perft
  - the engine controller, recovery and caching
  - opening recognition
  - endgame and KPK
  - the coach and Player DNA
  - training generation
  - PGN/FEN parsing
  - Library storage and Dexie v1→v4 migrations
  - backup and restore
  - fair-play contexts
  - settings migration and profiles
  - update checks
  - reports
- **Browser (Playwright, Chromium):** 35 pass. They cover:
  - the extension boots
  - workspace navigation in Simple and Full mode
  - analysis and mate-in-one
  - settings persistence
  - fair-play verdicts
  - the HUD on stand-in Lichess pages (arrows, resize, orientation, clock teardown, finished-game unlock)
  - Play MOTH
  - the import → review → coach → DNA workflow
  - What-If isolation
  - missing engine or model files
  - corrupted settings
  - performance
- **Engine:** perft correct on all reference positions.
- **Not run:** the live Lichess and Chess.com sites. The tests use stand-in pages, and the real sites cannot be logged into from CI.

### Performance (CI browser)

| Metric | Result |
|---|---|
| Home visible | 450 ms |
| MOTH first line on a middlegame position | 599 ms |
| MOTH depth 10 | 1.6 s |
| Stockfish first line | 1.1 s |
| Cached revisit | 273 ms |
| JS heap | 4.2 MB at start → 6.4 MB after 20 workspace switches → 5.6 MB after 5 reloads |
| Idle shutdown | 10.5 s with a 10 s setting |

Before 3.0 the engine started on the Home-equivalent screen; it no longer does.

### Bug found by the new tests

A synchronous cache-hit callback in the analysis hook threw `Cannot access 'h' before initialization` whenever an already-analysed position was revisited. It had been present since 2.0 and is now fixed.

## Phase 23: Brave release verification (done)

- CI installs **Brave 156.1.98.63** from Brave's official apt repository.
- It loads `dist/` unpacked through Playwright (`MOTH_BROWSER`) and runs 22 tests. All pass.
- The tests check:
  - MV3 manifest and permissions (no static host permissions)
  - the service worker and dynamic content scripts
  - popup and board navigation
  - WASM engines
  - permitted Lichess contexts and live-game restrictions
  - offline Play MOTH
  - missing assets
- `verify-dist` checks the manifest, the CSP, every worker and asset, and the fair-play origins.
- **Not covered in CI:** a manual install in a desktop Brave profile, an extension reload across a real browser restart, and chess.com pages (stand-in tests cover Lichess markup).

## Phase 24: Final review (done)

- The version is 3.0.0 in `package.json` and the manifest.
- The release notes are in `.github/release-notes/v3.0.0.md`, and the changelog is in `CHANGELOG.md`.
- The release zip contains only `moth-chess-dist`, the README, the changelog, `docs/` and the `fair-play/` rules source.
- Open items:
  - The engine time-control gain is not statistically significant.
  - No new network was trained.
  - Site adapters have not been checked against the live sites.
