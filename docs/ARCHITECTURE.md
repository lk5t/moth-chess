# MOTH Chess architecture (3.0)

MOTH Chess is a Manifest V3 extension. Everything runs locally: there is no server, no account and no telemetry.

```
public/manifest.json          MV3 manifest (no static host permissions; sites are opt-in)
src/background/               service worker: content-script registration, tab relay, commands, migrations, update notice
src/content/                  content script (permitted pages only)
  detector/sites.ts           fair-play classifier (rules compiled from fair-play/sites.json)
  adapters/                   board readers: chessground (Lichess), chesscom
  overlay/layout.ts           HUD geometry: drag/resize/clamp, placement that avoids the board and site controls
src/overlay-app/              the HUD panel (iframe inside a closed shadow root)
src/board-app/                the MOTH workspace (board.html): Home / Analyze / Train / Library / Engine Lab
src/components/               UI kit, panels, shared Settings/Control Center pieces
src/engine/                   UCI controller shared by both engines (queue, stale-result rejection, cache, recovery)
src/moth-engine/              MOTH Engine host: wasm bindings, UCI front end, workers (engine, training, lab)
engine/moth/moth.cpp          MOTH Engine (C++ → freestanding wasm32)
src/endgame/                  endgame classification, exact KPK bitbase, drills
src/openings/                 ECO recognition, explorer data (book, your games, plans)
src/review/                   game review, smart game reports
src/coach/, src/training/     exercises, spaced repetition, Player DNA, adaptive recommendations, repertoire
src/memory/                   IndexedDB (Dexie) schema v4 and repository
src/settings/                 schema v3 + migration, profiles, settings UI
src/backup/, src/diagnostics/ backup/restore with validation, local error log and diagnostic reports
src/updates/                  version and release notice (GitHub Releases, opt-out)
```

## Workspace (Phase 2)

The workspace has five areas in the sidebar:

- **Home** has the four main actions, quick analysis, recent items and engine status.
- **Analyze** has Evaluate, Game review, Openings and Endgame, plus Explain, Threats, Variation tree and What-if behind "More tools".
- **Train** has Coach, Practice and Play MOTH.
- **Library** has Games and Player DNA.
- **Engine Lab** has MOTH Engine and Benchmarks. It only appears in *Full* mode.

Simple mode is the default for new installs. Users upgrading from 2.x get Full mode. The last section, interface mode and HUD layout are stored in settings, and Settings → General → *Reset layout* restores the defaults.

Engine analysis only runs on screens that show a board. Home, Play, Practice and Engine Lab start no analysis worker.

## Fair play (Phase 3)

`classifyPage` checks a page in this order:

1. `liveDom`: a running clock always blocks.
2. `allow`
3. `review`: allowed only with positive "finished" evidence, otherwise *pending*.
4. `block`
5. Everything else is *unsupported*.

Uncertain states fail closed. The content script runs in one of two modes:

- **Active:** HUD and board reading. A DOM-change-driven check, throttled to 500 ms with a 2 s fallback, tears the HUD down the moment the page leaves a permitted state.
- **Standby:** nothing is drawn and no engine runs. A throttled check (≤1/s) on DOM changes and navigation starts the HUD when the page becomes permitted.

No other feature depends on the verdict.

## Engines

`StockfishEngine` (`src/engine/engine.ts`) drives both bundled engines over UCI in Web Workers.

- **Recovery:** exponential back-off (300 ms doubling, at most 8 s). The engine stops after 4 consecutive failures and waits for the user to press *Restart engine*. A missing engine file fails fast with a plain-language message.
- **Profiles** (Eco, Standard, Performance) set hash, depth, MultiPV, MOTH move time, pondering, the analysis debounce and the idle shutdown.

MOTH Engine 3.0 search changes, measured with `scripts/moth/ab.ts` (see `docs/PROGRESS.md`):

- countermove heuristic
- history gravity with a malus for quiet moves that failed
- logarithmic LMR, adjusted by history and the "improving" flag
- futility pruning
- "improving"-aware reverse futility pruning and late-move pruning
- two-slot transposition-table buckets

Multithreading is not used. Overlay frames cannot use SharedArrayBuffer, and the single-threaded build behaves the same everywhere.

## Storage

| Store | Content | Versioning |
|---|---|---|
| `chrome.storage.local` `moth.settings.v1` | settings | `settingsVersion` 3 + `migrateSettings` (v2.0 → v3 keeps every value; corrupt data is replaced and kept under `.corrupt`) |
| `chrome.storage.local` other keys | HUD position, error log, update state, lab history | additive |
| IndexedDB `moth-chess` | games, reviews, positions, exercises, attempts, models, practice, repertoire, trainingLog, … | Dexie v1→v4 upgrade functions; v4 (3.0) only adds tables |

Backups use the `moth-chess-backup` v3 format and contain settings plus all tables except binary models. 2.0 `moth-chess-export` files are still accepted. Restore merges records and skips duplicates; it never deletes anything.

## Updates

Browsers update store-installed extensions themselves. MOTH is distributed as an unpacked build, which never self-updates.

- At browser start-up, the service worker can check GitHub Releases at most once a day. The check is on by default and can be turned off in Settings.
- When a newer release exists, it only shows a badge and a notice that links to the release.
- After an upgrade, Home shows "Updated to X" once.
