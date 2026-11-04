# fair-play/

Source of truth for where MOTH Chess may run. Edit `sites.json`, send it back, and it gets reviewed and compiled into the next build. The installed extension cannot change these rules.

## Site entry

| Field | Meaning |
|---|---|
| `id` | Short unique name (`lichess`, `chesscom`, …). |
| `label` | Shown in the popup and Settings ("Allow on …"). |
| `hosts` | Hostnames this entry applies to (exact match). |
| `origin` | Host permission requested when you click **Allow** (for example `https://example.com/*`). |
| `adapter` | How the board is read: `chessground` (Lichess-style `cg-board` boards) or `chesscom` (`wc-chess-board` / `.piece.square-xy`). Sites with other markup need a new adapter in `src/content/adapters/`. |
| `matches` | Content-script URL patterns. MOTH's script is only injected on these URLs. |
| `liveDom` | CSS selectors that mean "a live game is running here", such as running clocks. Any match **blocks** the page. |
| `allow` | `{ "path": regex, "context": name }`: pages where MOTH is supported. `context` is a short label (analysis, study, practice, computer, …). |
| `review` | `{ "path": regex, "context": name, "requireDom": [selectors], "pendingReason": text }`: pages that become analysable only once the page itself shows a finished state, such as a game-over banner or a solved or failed puzzle. Until one `requireDom` selector is present, the page is blocked, marked *pending*, and MOTH waits in standby. |
| `block` | `{ "path": regex, "reason": text }`: pages that are always blocked. |
| `unsupportedReason` | Shown for any other page on the site. |

The order for each page is: **liveDom → allow → review → block → unsupported**. A running clock always wins, and a page that matches nothing is not supported.

### Since 3.0

Only engine *assistance* (the HUD, arrows and evaluation on the page) is gated. MOTH's own board, Library, training, settings and themes work on every page.

Checks are lightweight. A page is re-classified only when its DOM changes (throttled) or when it navigates, with a slow fallback poll. There is no behavioural monitoring and nothing is sent anywhere.

## What gets compiled

- Analysis boards, studies, editors, opening explorers, lessons, practice and puzzles that don't affect a rating are fine, as are games against the site's bots or coach when no other person is playing.
- Live, daily, correspondence, tournament or arena games against other people, rated puzzles, and anything that removes `liveDom` or `block` protections are not compiled.

After editing, the build also needs the new `origin` in `public/manifest.json` under `optional_host_permissions` and `web_accessible_resources[0].matches`. That's done when it's compiled.
