# MOTH Chess

Local chess analysis and training for Brave (and any Chromium browser), built around **MOTH Engine**, an original chess engine written in C++ and compiled to WebAssembly. Stockfish 17.1 is bundled as a separate, optional engine. MOTH Chess is a Manifest V3 extension and needs no server, account or API key: everything runs on your machine.

MOTH Chess is for analysis, study, game review, puzzles you solve yourself, and offline practice. **It never assists in live or rated games** (see [Fair play](#fair-play)).

## Install in Brave

1. Download `moth-chess-v2.0.zip` from the [latest release](https://github.com/lk5t/moth-chess/releases/latest) and unzip it, or build `dist/` yourself (below).
2. Open `brave://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `moth-chess-dist` folder (the one that contains `manifest.json`).
4. Pin the MOTH icon from the puzzle-piece menu in the toolbar.
5. The built-in analysis board opens on first install; it is also under the toolbar popup or **Alt+Shift+B**. Analysis starts at once with MOTH Engine.
6. **Play MOTH** (rail icon) to play offline games against the engine; **MOTH Engine** (rail icon) shows the learning dashboard.
7. *(Optional, on-board suggestions)* Open `https://lichess.org/analysis` (or a Lichess study, or `https://www.chess.com/analysis`), click the MOTH icon → **Allow on …**. From then on MOTH recognises the board automatically and draws its moves, square highlights and an evaluation bar directly on the site's board.

## Build from source

```bash
npm install        # also copies the Stockfish lite single-threaded WASM build into public/engines/
npm run test       # TypeScript check + Vitest unit tests (run the real WASM engines)
npm run build      # produces dist/ (Vite passes + manifest/asset verification)
npm run test:e2e   # build + Playwright tests that load dist/ into Chromium

sh engine/moth/build.sh                                         # rebuild MOTH Engine (clang ≥ 15 with wasm32 + wasm-ld)
node --experimental-strip-types scripts/moth/perft.ts           # move-generator correctness
```

Requires Node 22 (the MOTH tools run TypeScript directly with `--experimental-strip-types`). The compiled engine (`public/moth-engine/moth.wasm`), opening book, tactical suite and trained models are committed, so a normal build needs no C++ toolchain. `dist/` is self-contained and needs no dev server.

### Training pipeline (offline, optional)

```bash
# data: Lichess open database samples (CC0) — the `data` branch, produced by .github/workflows/data.yml
node --experimental-strip-types scripts/moth/build-book.ts <chess-openings-dir> <games.pgn.gz> 12   # validated opening book
node --experimental-strip-types scripts/moth/build-tactics.ts <puzzles.csv.gz>                     # tactical suite
STOCKFISH_JS=<stockfish.js> node --experimental-strip-types scripts/moth/train.ts --games <games.pgn.gz> --puzzles <puzzles.csv.gz>
STOCKFISH_JS=<stockfish.js> node --experimental-strip-types scripts/moth/bench.ts <games.pgn.gz> <puzzles.csv.gz>
```

## MOTH Engine

| | |
|---|---|
| **Core** | C++17, freestanding WebAssembly (no libc, ~50 KB). Bitboards + mailbox, incremental Zobrist keys, fully legal move generation (castling, en passant, all promotions), checkmate / stalemate / 50-move / threefold / insufficient-material detection. Perft-verified against the six standard reference positions. |
| **Search** | Iterative deepening, aspiration windows, principal variation search, quiescence search with check evasions, transposition table, null-move pruning, late-move reductions, reverse futility and late-move pruning, check extensions, killer + history move ordering, static exchange evaluation, mate-distance scoring, MultiPV, PV extraction. |
| **Evaluation** | Tapered classical evaluation (material, piece-square tables, mobility, king attack and shelter, pawn structure, passed pawns, bishop pair, rooks on open files, space) **plus a trained NNUE-style network** (768 → 2×64 → 1, clipped ReLU, incrementally updated accumulators) used as a bounded residual (±250 cp) on top of the classical score. |
| **Styles** | **Aggressive**, **Balanced**, **Defensive** share one search and one network. A style re-weights evaluation terms and adds a small root tie-break bonus (≤ 12 cp, never applied to decided positions), so it only chooses between moves the search considers close. Forced wins and necessary defences are never overridden. In the opening, styles choose different *sound* book moves (gambits for Aggressive, solid systems for Defensive). |
| **Fast answers** | Opening book → position cache → time-managed search (stops early once the best move is stable, never starts an iteration it can't finish) → legal fallback. Default move deadline 100 ms. Predictive pondering on your time in Play mode. |
| **UCI** | MOTH speaks UCI in its own Web Worker (`uci`, `setoption`, `position`, `go depth/movetime/nodes/wtime…/infinite/ponder`, `stop`, `ponderhit`), so it shares the engine controller with Stockfish. |
| **Opening knowledge** | Position-keyed book (transpositions resolve to one entry) from the Lichess `chess-openings` list (CC0) and human statistics from 24,000 Lichess games (CC0). Every candidate move is validated by Stockfish. Gambits, traps, known opening mistakes and their refutations are tagged. Popularity is shown but never outranks soundness. |

### Learning, measured

- **Human games:** 24,000 rated Lichess games (both players ≥ 1800, CC0). Each is validated by replaying it through MOTH's move generator, positions are deduplicated by Zobrist key, and train/validation are split **by game**. Moves are judged by the teacher engine's evaluation before and after the move, never by who won.
- **Labels:** Stockfish 17.1 (depth 8) labels every position; the target blends Stockfish's evaluation (75%) with the game result (25%). Only **quiet** positions (not in check, no material-winning capture) are used for training. Without that filter the network learned to double-count pending captures and lost ~200 Elo, a failure the gate caught.
- **Self-play and augmentation:** self-play games of the current model plus off-distribution positions (random legal moves from human positions) keep the network sane in the positions search actually visits.
- **Promotion gate:** a candidate is promoted only if (1) its validation loss improves on the parent's, (2) it beats the parent in a 400-game paired-opening match with ≥ 80% likelihood of superiority, and (3) it doesn't regress on the tactical suite. Rejected models are kept with their reasons; older models remain for rollback.
- **History so far:** five candidates, one promoted (`moth-nn-2.0.4`: −3.5% validation loss, **+22.6 ± 29.9 Elo** vs the classical evaluation over 400 games, LOS 93%). The other four were rejected, including a fine-tuned successor that measured −25 Elo against 2.0.4.
- **Learning Lab:** the same pipeline runs inside the extension on the games in your Memory, with a deeper MOTH search as the teacher. It has its own worker, separate from play and analysis.
- **Personal adaptation:** your games against MOTH build a profile (openings, recurring mistakes, phase-by-phase loss, gambit results). It steers which sound book lines MOTH prepares against you and what MOTH Coach recommends, and it never touches the engine model. You can switch it off or delete the history.

## Measured performance

Measured in Node (WebAssembly, single thread) on the 2-core build machine with model `moth-nn-2.0.4`. The dashboard shows the same file plus your browser's own measurements.

| Move requests, 100 ms deadline | n | P50 | P95 | P99 | max | target |
|---|---:|---:|---:|---:|---:|---|
| Cached position | 280 | 0.07 ms | 0.11 ms | 0.15 ms | 0.33 ms | 1–5 ms |
| Known opening (book) | 80 | 1.3 ms | 46 ms¹ | 87 ms | 87 ms | 1–10 ms |
| Opening, out of book | 60 | 40 ms | 98 ms | 98 ms | 98 ms | 10–50 ms |
| Middlegame | 80 | 47 ms | 98 ms | 98 ms | 98 ms | 10–50 ms |
| Endgame | 60 | 35 ms | 81 ms | 98 ms | 98 ms | 10–50 ms |
| Tactical (puzzles) | 80 | 26 ms | 73 ms | 78 ms | 78 ms | 20–100 ms |

¹ Book positions where no move passes the soundness filter fall back to a search.

- **Tactics:** 225/235 Lichess puzzles (26 themes) at 100 ms per puzzle; Stockfish 17.1 lite solved 235/235 on the same machine and budget.
- **Speed:** about 1.1 M nodes/s, on par with Stockfish lite's node rate (its larger network evaluates far more per node).
- **Strength estimate:** about **2705 (95% interval 2590–2815) on Stockfish's UCI_Elo scale**, from 112 games at 50 ms/move against Stockfish 17.1 limited to UCI_Elo 1350–3000. Results: 63/64 up to 2100, 14/16 at 2400, 10.5/16 at 2700, 0/16 at 3000. This is a rough scale, not a FIDE rating.
- **Styles:** Aggressive and Defensive choose a different move from Balanced in 32% and 35% of 60 middlegame positions. All three styles found the forced mate in 57/57 mate-in-1/2 puzzles.
- **Correctness:** perft matches all six standard reference positions (16.6 M nodes, about 32 M nodes/s).

## Features

| Area | What it does |
|---|---|
| **Engines** | MOTH Engine (default) and Stockfish 17.1 lite, each in its own worker, switchable in the overlay, on the board and in Settings. Game review / coach use Stockfish by default (stronger evaluations), configurable. Shared controller: MultiPV, depth/time limits, cancellation, stale-result rejection, crash recovery, idle shutdown, evaluation cache. |
| **On-board suggestions** | On supported analysis boards MOTH recognises the board automatically (no copying FENs). A position counts as **verified** only when the site's own FEN field or its move list, replayed legally, reproduces exactly the pieces on the board. Otherwise it is shown as *unverified* and side to move / castling are asked for, never guessed. Arrows, start/destination highlights and an evaluation bar are drawn in a transparent, click-through SVG layer that tracks orientation, resizing, scrolling and zoom. |
| **Play MOTH** | Offline games as White or Black, any style, seven levels, clocks (none to 15+10), takebacks (optional), resign, game-over detection, save to Memory, one-click review. |
| **MOTH Engine dashboard** | Engine version, active model, human games processed, self-play games, training runs, candidates and their status (training / awaiting validation / approved / rejected), match and tactics results, strength estimate, opening statistics, and response-time tables (mean, P50, P95, P99) from the benchmark and from your own browser. |
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
- The content script is registered only for `lichess.org/analysis*`, `lichess.org/study/*`, `lichess.org/practice/*` and `www.chess.com/analysis*`. Rated puzzle trainers (Lichess *Puzzles*, Chess.com *Puzzles*/*Rush*) are excluded because engine help there changes a rating. Solve puzzles yourself, or use MOTH Coach and Play MOTH offline.
- Inside a page, MOTH re-classifies and **fails closed**. Game, TV, tournament, arena, puzzle-rush/storm/racer and play pages are blocked by URL, and any page showing running clocks is blocked by DOM evidence. When blocked, analysis stops and the overlay tears down.
- MOTH never makes moves on third-party sites. It doesn't hide itself from those sites and doesn't read protected game state. The What-If simulator and Coach run only on MOTH's own boards.
- When the page context is uncertain (no board found, pieces only and no side to move), no suggestions are shown until the position is confirmed.
- Pondering runs only in MOTH's own offline games.
- Everything stays on your machine. MOTH makes no network requests (verified in the Playwright suite).

## Troubleshooting

- **"Manifest file is missing or unreadable"**: you picked the repo folder. Pick `dist/`.
- **Engine status shows "error"**: open the board page's DevTools console. `engines/stockfish.wasm` and `moth-engine/moth.wasm` must exist in `dist/` (run `npm install` again so the postinstall step copies Stockfish).
- **MOTH plays instantly in the opening**: that is the opening book (1–10 ms). Turn off *Use the opening book for moves* in Settings to make it search every move.
- **"Unverified · pieces only" on a site**: the page doesn't expose its move list or FEN in a way MOTH could verify. Choose the side to move (and castling rights if relevant) in the overlay.
- **No overlay on Lichess/Chess.com**: make sure you're on an *analysis* URL and have clicked **Allow on …** in the popup. Live-game pages are blocked on purpose.
- **Threads slider has no effect**: the bundled build is single-threaded, because overlay frames cannot use SharedArrayBuffer.

## Known limitations

- **Strength:** MOTH Engine is a strong amateur engine, not a Stockfish rival. With the same hardware and 100 ms per puzzle it solved 225/235 tactical puzzles against Stockfish's 235/235. The dashboard's strength figure comes from matches against Stockfish's own `UCI_Elo` levels at 50 ms/move: it is a rough scale, not a FIDE or CCRL rating.
- **Latency:** cached answers are well under 1 ms, and median uncached answers are 26–47 ms depending on the position type. The 95th/99th percentiles of uncached middlegame and opening positions sit at the 100 ms deadline (complex positions use their full budget). Some known book positions have no move that passes the soundness filter, so they are searched instead, which is why the book's P95 is higher than its median. Numbers are from Node on the build machine; your browser's own measurements appear on the dashboard.
- **The network is small** (64 hidden units). Its measured gain over the classical evaluation is modest (+22.6 ± 29.9 Elo). Further candidates have been rejected so far, and that is the gate working.
- **Learning Lab** uses a deeper MOTH search as its teacher (Stockfish can't run alongside training in the browser) and small runs, so most in-browser candidates will be rejected unless you have many games. That's intended: nothing is promoted without measured improvement.
- **Single-threaded engines:** overlay frames can't use SharedArrayBuffer, so the Threads setting is clamped to 1.
- **Third-party boards:** adapters were tested against stand-in pages that follow Lichess's chessground markup and Chess.com's piece classes, not against the live sites. Sites can change their markup; if recognition breaks, the built-in board still works. Pieces-only readings are always marked unverified.
- **Rated puzzle trainers are excluded** on purpose (fair play). Brave-specific verification wasn't possible in CI; testing used Chromium, which Brave is built on.

## Licensing

- MOTH Chess source code, including MOTH Engine: GPL-3.0-or-later (required because it distributes Stockfish).
- Training and opening data: Lichess open database and `lichess-org/chess-openings`, both CC0 1.0. Trained MOTH models are derived from that data and Stockfish evaluations.
- Stockfish: GPL-3.0. Its licence is shipped as `dist/engines/STOCKFISH-LICENSE.txt` and the source is available at <https://github.com/official-stockfish/Stockfish>. The WASM build comes from the `stockfish` npm package (<https://github.com/nmrugg/stockfish.js>).
- chess.js (BSD-2-Clause), Dexie (Apache-2.0), React (MIT).
