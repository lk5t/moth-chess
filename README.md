# MOTH Chess

Local, explainable chess analysis for Brave (and any Chromium browser). It's a Manifest V3 extension with a bundled Stockfish WASM engine, and it needs no server, account or API key.

MOTH Chess is for analysis, study, game review and offline practice. **It never runs during live or rated games** (see [Fair play](#fair-play)).

## Install in Brave

1. Get the `dist/` folder: build it yourself (below), or download the `moth-chess-dist` artifact from the latest green CI run (or the `dist/` folder on the `ci-output` branch).
2. Open `brave://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `dist` folder (the one that contains `manifest.json`).
5. Pin the MOTH icon from the puzzle-piece menu in the toolbar.
6. On first install the built-in analysis board opens. You can also open it from the toolbar popup → **Open analysis board**, or press **Alt+Shift+B**.
7. Analysis starts automatically: the evaluation, the top three moves and arrows appear within a second or two.
8. *(Optional)* Open `https://lichess.org/analysis` or `https://www.chess.com/analysis`, click the MOTH icon → **Allow on …** → **Show overlay** to get the floating overlay on that analysis board.

## Build from source

```bash
npm install        # also copies the Stockfish lite single-threaded WASM build into public/engines/
npm run test       # TypeScript check + Vitest unit tests
npm run build      # produces dist/ (3 Vite passes + manifest/asset verification)
npm run test:e2e   # build + Playwright tests that load dist/ into Chromium
```

Requires Node 20 or newer. The build has no dev-server dependency: `dist/` is self-contained.

## Features

| Area | What it does |
|---|---|
| **Engine** | Stockfish 17.1 lite (single-threaded WASM) in a dedicated worker. UCI layer with MultiPV, depth/time limits, hash, cancellation, stale-result rejection, crash recovery/restart, idle shutdown and an LRU evaluation cache. Defaults: depth 18, MultiPV 3, 1 thread, 64 MB hash. Scores are always shown from **White's perspective** (labelled in the UI). |
| **Analysis board** | Full-page board: legal moves (chess.js), promotion picker, flip, move list, FEN/PGN load, eval bar and coloured arrows (green/blue/orange = lines 1–3). |
| **Floating overlay** | Shadow-DOM-isolated frame on supported analysis pages. You can drag, resize, minimise, close and set its opacity, and its position persists per site. Tabs: Analysis, Intelligence, Neural Map, Coach, Memory, Dashboard. |
| **MOTH Intelligence** | Deterministic, explainable features: material, development, king safety, pawn structure, centre control, hanging pieces, tactics, candidate-move comparison, endgame principles and summaries. Engine-proven facts and heuristic explanations are labelled separately. An `Explainer` interface leaves room for an optional local LLM later. |
| **Neural Map** | Interactive variation graph (SVG). Positions are deduplicated by position key, while distinct move histories are kept. Expand/collapse, zoom/pan, eval colour coding, bounded auto-expansion, save/reopen trees. |
| **MOTH Coach** | Builds exercises from your reviewed games' mistakes (tactical, opening, endgame, missed wins) and runs them on a separate practice board: find the move, get it validated, read the explanation, and the result is saved. Daily and custom sessions, history and topic recommendations. It says so when there isn't enough data. |
| **Threat Vision** | Toggleable layers: attacked squares, undefended/hanging pieces, checks, pins, forks/skewers, king-safety warnings and defensive replies. Geometric threats and engine-validated threats are visually distinct. |
| **What-If Simulator** | Sandbox clone of the current position. Explore lines, compare Stockfish evaluations before and after, save, reset, send to Neural Map or export PGN. It never mutates the source game. |
| **Personal Memory** | IndexedDB (Dexie) storage for games, positions, favourite openings, sessions, trees, exercises, coaching results, annotations, tags and folders. Search, filters, favourites, recents, position linking, duplicate detection, versioned migrations, JSON/PGN import/export and pagination. |
| **Dashboard** | Games reviewed, estimated accuracy (explained formula, not a chess-site metric), blunder/mistake rates, opening/endgame performance, training success, trends, eval graphs. Filters: date, opening, result, colour, category. Small samples are flagged. |
| **Openings & Review** | Local ECO book, matched by position so transpositions count, with explorer and favourites. PGN game review with an eval timeline, mistake/blunder detection, summary, annotated PGN export, and cancellable/resumable analysis. |
| **Settings** | Appearance (theme, accent, opacity, scale, animation), engine, visual analysis, intelligence, memory (usage/export/import/clear) and general (shortcuts, start minimised, notifications, reset). Inputs are validated and saved in `chrome.storage.local`. |

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt+Shift+M | Show/hide the overlay on a supported analysis page |
| Alt+Shift+A | Start/stop analysis |
| Alt+Shift+B | Open the analysis board |
| ← / → / Home / End | Navigate moves (board page) |
| F | Flip board · **Space** start/stop · **Alt+1…9** switch section |

To change the browser-level shortcuts, go to `brave://extensions/shortcuts`.

## Fair play

- No static host permissions. Site access is **optional** and granted per site from the popup.
- The content script is registered only for `lichess.org/analysis*`, `lichess.org/practice/*` and `www.chess.com/analysis*`.
- Inside a page, MOTH re-classifies and **fails closed**. Game, TV, tournament, arena, puzzle-rush/storm/racer and play pages are blocked by URL, and any page showing running clocks is blocked by DOM evidence. When blocked, analysis stops and the overlay tears down.
- MOTH never makes moves on third-party sites. It doesn't hide itself from those sites and doesn't read protected game state. The What-If simulator and Coach run only on MOTH's own boards.
- Everything stays on your machine. MOTH makes no network requests (verified in the Playwright suite).

## Troubleshooting

- **"Manifest file is missing or unreadable"**: you picked the repo folder. Pick `dist/`.
- **Engine status shows "error"**: open the board page's DevTools console. `engines/stockfish.wasm` must exist in `dist/` (run `npm install` again so the postinstall step copies it).
- **No overlay on Lichess/Chess.com**: make sure you're on an *analysis* URL and have clicked **Allow on …** in the popup. Live-game pages are blocked on purpose.
- **Threads slider has no effect**: the bundled build is single-threaded, because overlay frames cannot use SharedArrayBuffer.

## Known limitations

- Single-threaded lite engine (small NNUE). It is strong, but slower than native multi-threaded Stockfish.
- Third-party board adapters read the visible board. Castling rights and en-passant state are never guessed: if the page doesn't expose them, they are left unset and the overlay says so.
- Chess.com and Lichess can change their markup at any time. If an adapter stops detecting the board, the built-in board still works.

## Licensing

- MOTH Chess source code: GPL-3.0-or-later (required because it distributes Stockfish).
- Stockfish: GPL-3.0. Its licence is shipped as `dist/engines/STOCKFISH-LICENSE.txt` and the source is available at <https://github.com/official-stockfish/Stockfish>. The WASM build comes from the `stockfish` npm package (<https://github.com/nmrugg/stockfish.js>).
- chess.js (BSD-2-Clause), Dexie (Apache-2.0), React (MIT).
