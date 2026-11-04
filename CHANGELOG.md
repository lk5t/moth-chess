# Changelog

All notable changes to MOTH Chess. MOTH Chess is free and in public beta.

## 3.0.1 (2026-11)
- **Steady arrow:** the best move is picked once, when the engine reaches the arrow depth (default 14), and stays until the position changes. It no longer jumps between moves while the engine keeps thinking. On websites the engine also stops at that depth.
- **One arrow by default** (best move only). 3.0 installs that showed 3 arrows are switched to 1; other numbers you chose are kept.
- **Slimmer, cleaner arrows** and subtler best-move square outlines.
- New settings under Appearance → On-page analysis panel: *Steady arrow* and *Arrow depth*.

## 3.0.0 "Freedom" (2026-11)

### Interface
- New workspace: **Home, Analyze, Train, Library, Engine Lab**, each with a few tabs. *Simple* mode, the default for new installs, keeps advanced tools under "More tools" and hides Engine Lab. *Full* mode shows everything.
- The new Home screen has four main actions, quick FEN/PGN analysis, recent items and engine status.
- New logo and design system. Settings are reorganised into 6 sections with collapsible advanced options. The popup is decluttered.
- The last section is remembered, and *Reset layout* restores the defaults. There are hints for unfamiliar tools.

### Fair play
- Engine help now works on finished games and solved or failed puzzles, but only once the page shows that state. It also works on lessons, the board editor and the explorer, alongside analysis boards, studies, practice and bot games.
- Live, rated, daily, tournament and arena games, timed puzzle modes and any page with a running clock stay blocked. Uncertain states stay blocked.
- The rest of MOTH works on every page. Page checks are lightweight and event-driven.
- A fair-play disclaimer is shown on Home, in the popup, in Settings and in the welcome tour.

### Engine
- MOTH Engine 3.0 search:
  - countermove heuristic
  - history gravity with a malus for quiet moves that failed
  - logarithmic late-move reductions
  - futility pruning
  - "improving"-aware pruning
  - two-slot hash buckets
- Measured against the 2.0 build: +58.5 ± 50.8 Elo at 20k nodes per move over 120 games (LOS 98.8%), and +31.9 ± 52.2 Elo at 40 ms per move over 120 games (not statistically significant).
- An evaluation experiment showed no measurable gain and was not shipped.

### Analysis and training
- Analysis Studio: evaluation graph, undo/redo, endgame view and collapsible engine options.
- Opening Explorer: book responses with engine checks, your own games at the current position, typical plans and a repertoire with drills.
- Endgame Intelligence: exact king and pawn vs king results from a local table, labelled rules for other endgames, pawn races and 8 training positions.
- Player DNA, adaptive Practice (spaced repetition, endgame levels) and smart game reports with Markdown export.
- Play MOTH from any position or drill, with draw offers.
- Engine Lab: MOTH vs Stockfish benchmark, self-play matches (resume, PGN export, save to Library) and a results history.

### Reliability and data
- Control Center, performance profiles (Eco, Standard, Performance) and engine recovery with back-off. The engine stops after repeated failures, with a clear message and a *Restart engine* button.
- Backup and restore with validation; 2.0 exports are still accepted. Local diagnostic reports that you review before sharing, plus an error log.
- Welcome tour.
- Update notices from GitHub Releases. You can turn them off. MOTH never installs anything by itself.
- Migrations: settings schema v3 (2.x values kept) and database v4 (additive).
- Fixed: practice games, latency samples and training runs were exported but not re-imported.

## 2.0.1
- On-board suggestions on Chess.com games against the computer.

## 2.0.0 "Evolution"
- MOTH Engine (C++ → WebAssembly) with a trained evaluation network, three styles, an opening book, Play MOTH, a learning pipeline with a promotion gate, and automatic board recognition.

## 1.0.0
- First release: local Stockfish analysis, MOTH Intelligence, Threat Vision, Neural Map, Game Review, Coach and Memory.
