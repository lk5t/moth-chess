# MOTH Chess

Local chess analysis and training for Brave (and any Chromium browser), built around **MOTH Engine**, an original chess engine written in C++ and compiled to WebAssembly. Stockfish 17.1 is bundled as a separate, optional engine. MOTH Chess is a Manifest V3 extension and needs no server, account or API key: everything runs on your machine.

MOTH Chess is for analysis, study, game review, puzzles you solve yourself, and offline practice. **It never assists in live or rated games** (see [Fair play](#fair-play)).

## Install in Brave

1. Download `moth-chess-v3.0.zip` from the [latest release](https://github.com/lk5t/moth-chess/releases/latest) and unzip it, or build `dist/` yourself (see below).
2. Open `brave://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `moth-chess-dist` folder (the one that contains `manifest.json`).
4. Pin the MOTH icon. On first install, a short welcome tour sets the engine, the performance profile and website access.
5. Open MOTH from the toolbar icon or with **Alt+Shift+B**. **Home** has the four main actions: Analyze a position, Review a game, Train, and Play MOTH.
6. *(Optional, on-board analysis)* Open a Lichess or Chess.com analysis board, click the MOTH icon, then **Allow on …**.

**Updating from 2.x:** replace the folder and press reload on the MOTH entry in `brave://extensions`. Settings, games, reviews, training data and models are migrated automatically and kept. Home confirms the update once.

**Later updates:** MOTH checks GitHub Releases once a day and shows a notice when a new version is out. You can turn this off in Settings → About & updates. Unpacked extensions never update themselves: download the new zip, replace the folder and press reload.

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

## Using MOTH Chess (3.0 workspace)

| Area | What's there |
|---|---|
| **Home** | Quick analysis (paste a FEN or PGN), recent games, the training due today, engine status and performance profile. |
| **Analyze** | **Evaluate**: board, evaluation bar, best lines with explanations, evaluation graph by move, undo/redo (Ctrl+Z / Ctrl+Y) and engine switching. **Game review**: accuracy, mistakes, critical moments and an exportable report. **Openings**: book responses checked by Stockfish, moves from your own games, typical plans and your repertoire. **Endgame**: endgame type, known results (KPK is exact), pawn races and technique. *More tools*: Explain, Threats, Variation tree, What-if. |
| **Train** | **Coach**: exercises from your own mistakes, with spaced repetition. **Practice**: recommendations, endgame drills that adapt their level, and opening repertoire drills. **Play MOTH**: offline games from any position or drill, with seven levels, three styles, clocks, takebacks and draw offers. |
| **Library** | **Games**: import PGNs (large files are fine), with folders, tags, search and export. **Player DNA**: your openings, accuracy trend, mistakes by phase, missed tactical patterns and endgame progress. You can reset it. |
| **Engine Lab** (Full mode) | MOTH Engine models and learning; benchmarks (MOTH vs Stockfish on a puzzle suite); MOTH-vs-MOTH self-play matches with PGN export and resume; results history (JSON export). |
| **Settings** | General (Simple/Full interface, hints, reset layout), Appearance (theme, HUD, board visuals), Engine performance (Eco/Standard/Performance profiles, engines, MOTH style), Website compatibility, Data management (backup/restore, storage), About & updates. |
| **Control Center** | Status, engine self-check, website access, backups, error log, diagnostic reports you review before sharing, changelog and feature status. |

**Simple** mode, the default for new installs, keeps advanced tools under *More tools* and hides Engine Lab. **Full** mode shows everything. Users upgrading from 2.x start in Full mode.

### Performance profiles

| Profile | Hash | Depth | Lines | MOTH move time | Pondering | Wait before analysing | Engine sleeps after |
|---|---|---|---|---|---|---|---|
| Eco | 16 MB | 14 | 2 | 60 ms | off | 400 ms | 20 s |
| Standard | 64 MB | 18 | 3 | 100 ms | on | 140 ms | 90 s |
| Performance | 256 MB (MOTH ≤ 128) | 24 | 3 | 250 ms | on | 60 ms | 5 min |

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt+Shift+M | Show/hide the overlay on a supported analysis page |
| Alt+Shift+A | Start/stop analysis |
| Alt+Shift+B | Open the analysis board |
| ← / → / Home / End | Navigate moves (board page) |
| F | Flip board · **Space** start/stop · **Alt+1…5** switch workspace · **Ctrl+Z / Ctrl+Y** undo/redo |

To change the browser-level shortcuts, go to `brave://extensions/shortcuts`.

## Fair play

> MOTH Chess is intended for chess education, training, research, and analysis. We do not encourage cheating, unfair competitive advantages, or violations of chess platform rules. Users are responsible for following the rules of the platforms on which they play.

- **Only engine assistance on websites is gated.** MOTH's own board, Library, training, settings and themes work everywhere.
- **Allowed** (after you grant site access): analysis boards, studies, practice, lessons and the board editor; **finished games** and **solved or failed puzzles**, once the page itself shows that state; games against the site's computer.
- **Always blocked:** live, rated, daily, tournament, arena, simul and TV games; timed puzzle modes (Puzzle Rush/Battle, Storm, Racer, Streak); any page with a running clock; unsolved rated puzzles.
- **Uncertain states stay blocked.** A game page with no "game over" evidence, or a puzzle that is not finished, keeps MOTH in standby: nothing is drawn and no engine runs. Assistance switches on by itself when the page shows a permitted state, and switches off the moment a clock runs or the next unsolved puzzle loads.
- **Lightweight checks:** the page is re-checked when its DOM changes (throttled) and on navigation. There is no behavioural monitoring and no telemetry.
- MOTH never moves pieces on websites. The rules live in [`fair-play/sites.json`](fair-play/) and are compiled into the build.

## Troubleshooting

- **"Manifest file is missing or unreadable"**: you picked the repo folder. Pick `dist/`.
- **Engine status shows "error"**: open the board page's DevTools console. `engines/stockfish.wasm` and `moth-engine/moth.wasm` must exist in `dist/` (run `npm install` again so the postinstall step copies Stockfish).
- **MOTH plays instantly in the opening**: that is the opening book (1–10 ms). Turn off *Use the opening book for moves* in Settings to make it search every move.
- **"Unverified · pieces only" on a site**: the page doesn't expose its move list or FEN in a way MOTH could verify. Choose the side to move (and castling rights if relevant) in the overlay.
- **No overlay on Lichess/Chess.com**: open the MOTH popup on that tab. It says whether the page is allowed, blocked (and why) or waiting for the game to finish. Live-game pages are blocked on purpose.
- **Engine stopped after repeated crashes**: press *Restart engine* or switch engines. MOTH stops retrying after 4 failures in a row so it doesn't loop. Control Center → Engines → *Run checks* tests both engines.
- **Something else is wrong**: Control Center → Feedback & diagnostics builds a report you can read and edit, then copy or attach to a GitHub issue yourself.
- **Too much on screen**: Settings → General → Interface *Simple*, or *Reset layout*.
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
