# MarketMind v0.10.0 — Historical Analytics Dashboard

Stage 3.2: an offline, read-only view of the history MarketMind has stored, added to the Web Explorer.

MarketMind is read-only educational research. It cannot place trades, a quoted spread is not a guaranteed profit, and stored history is a set of discrete observations, not a continuous record of the market.

## Highlights

### Historical dashboard

- **Stored market browser.** `#/history` lists every market with stored observations, newest observation first, 50 per page, with live and synthetic observation counts, first and last observation and the latest run's status.
- **Collection runs list.** `#/history/runs` shows runs newest first (20 at a time, up to 100) with status, request accounting, counts, source type and the recovery reason of interrupted runs.
- **Read-only SQLite integration.** Stored routes open the local database (`MARKETMIND_DB`, default `data/marketmind.sqlite`) read-only with `PRAGMA query_only`, once per request inside one read transaction. A missing database is reported, never created. Stored History never contacts Polymarket.
- **Historical bid, ask and midpoint chart.** Best bid and ask per observation drawn as a bid-to-ask range, with the midpoint.
- **Spread and resting-depth history.** A spread chart with the threshold as a dashed line, and a resting-depth chart for the reference outcome (total depth, plus band depth when every charted observation used the same band).
- **Observation timeline on actual collection timestamps.** Charts use the real observation times. Each observation is its own mark; nothing is joined by lines or interpolated.
- **Sampling gaps and data-quality indicators.** Gaps longer than twice the median gap are shaded "No observations: irregular gap". Unusable observations (one book only, invalid, one-sided or empty book, no metrics for this analytics version) are crosses on a rug below each plot, never values; synthetic observations are hollow, dashed marks.
- **Exact stored observation evidence.** Selecting an observation opens both books exactly as stored (levels in Polymarket's order), quality issues in words, Polymarket's book timestamps, request timing, content hashes, the pairing gap, and every stored metrics row labelled **At collection**, **Recomputed later** or **Retrospective**. Values are the stored decimal strings. An accessible observation table carries every plotted value.
- **Deep links and browser navigation.** Every view, including `#/history/market/<id>/obs/<observationId>`, can be bookmarked or opened directly, with an optional `?source=live|all`. Back and Forward move between views without reading anything again. A history address never starts the Live Explorer.
- **Desktop and mobile layouts.** On a narrow screen the evidence comes first and the history stays loaded below it.

### Synthetic demonstration mode

- **`npm run web:demo`** builds the UI and serves Stored History over a synthetic database, with no collected data or internet connection needed.
- **Deterministic synthetic database**, generated through the same storage code `collect` uses. Timestamps (5 January 2026) and values are fixed; two runs of the demo store the same records.
- **Three example markets, 26 observations across 17 runs**: a steady market, a market with an invalid book, an incomplete observation and a long gap, and a sparse market with insufficient evidence. One run is interrupted and recovered, one is partial.
- **Strictly offline.** Every live route is refused with HTTP 403 `LIVE_DISABLED` before the request gate, whose HTTP client refuses every request anyway. The Live Explorer is shown as disabled.
- **Isolated temporary database.** The demo creates a new `marketmind-demo-<random>` directory in the OS temporary folder and never opens your configured database (`MARKETMIND_DB` is ignored). On a normal shutdown (Ctrl+C or closing the console) the server closes and the directory is deleted after an ownership-token check.
- **Clear synthetic provenance.** Every run is `source_type = synthetic`, every question starts with `[SYNTHETIC DEMO]`, recorded URLs use the reserved `.invalid` domain, and the browser shows a permanent "Synthetic demonstration data" banner.

## Architecture and compatibility

- **Existing SQLite schema unchanged.** No migration was added; the schema version is the same as in v0.9.0.
- **Read-only stored API endpoints.** Four new `GET` routes: `/api/stored/markets`, `/api/stored/runs`, `/api/stored/markets/:id/history` and `/api/stored/observations/:id`. They never use the live request budget or gate, and nothing they do writes data. The source filter (`live` or `all`) is applied by the server; a normal server defaults to **Live only**.
- **Shared statistics.** The stored routes call the same application code as the CLI's `history` and `runs` and the MCP stored tools, so every statistic means the same everywhere. The browser computes no statistic. `src/web` cannot import storage or `node:sqlite` (ESLint).
- **Existing CLI and MCP compatibility preserved.** CLI commands and MCP tool names, contract ids and schemas are unchanged. All 20 MCP golden responses are unchanged. New observations record app version `0.10.0`, which is also sent in the User-Agent.
- **No new charting library.** Charts are in-house SVG (`web/src/chart.ts`). No runtime or development dependencies were added.
- **No trading capabilities.** No wallets, keys, credentials, order signing or trading endpoints exist anywhere in the code.

## Verification

- **Unit and integration tests:** 2,117 passed (1 skipped: a Windows file-symlink case) on two consecutive clean `npm run verify` runs on an idle machine, 209 s and 174 s end to end (Vitest 169 s and 139 s), with 97.03% line coverage. A third clean run after the version bump, the final release gate, passed with the same figures (169 s; Vitest 137 s).
- **Playwright end-to-end tests:** 97 passed in Chromium at desktop and phone sizes (3 skipped by design: viewport-specific and development-build cases), covering the existing Live Explorer suites and the new Stored History and demonstration suites.
- All 20 MCP golden responses unchanged.
- Baseline archive verified unchanged.
- `npm audit --omit=dev` reports 0 vulnerabilities.
- The production SQLite database was unchanged by verification.

**Intermittent timeouts during development.** Throughout Stage 3.2, `npm run verify` occasionally failed with 5-second Vitest timeouts in varying, unrelated tests, including pure in-memory ones. The same behaviour occurred on the clean v0.9.0 baseline, and limiting Vitest to four workers did not prevent it. The failures coincided with heavy concurrent disk activity (disk write latency spikes of 70–250 ms) and did not recur on an idle machine (write latency around 3 ms) during release verification. The root cause has not been proven.

## Known limitations

- **Historical statistics are sample-based, not time-weighted.** "37.5% of samples" is not "37.5% of the time"; samples are irregular and nothing is known between them.
- **Charts show discrete observations, not continuous market history.** A spread may have opened and closed any number of times between two marks.
- **The plotted series is limited to the newest 2,000 observations**, while statistics use up to the newest 20,000. The page says "Plotted: N · Analysed: M" when fewer are plotted than analysed.
- **Synthetic observations enter statistics only when explicitly selected** with **Live + synthetic** (the demonstration's default). A notice then warns that statistics may mix simulated and real observations.
- **No refresh button.** Reload the page to read the database again after another `collect`.
- **No browser `asOf` control or time-range paging.** The API accepts `asOf`, but the browser does not expose it; there is no zoom or paging beyond the newest 2,000 plotted observations.
- **Outliers can compress chart scales**, for example one synthetic sample under Live + synthetic.
- **Forced termination can leave temporary demo directories.** Killing the demo process, a crash or a power loss leaves its `marketmind-demo-*` folder in the temporary directory; delete it by hand.
- **SQLite read-only connections may create auxiliary files.** As for any reader of a WAL database, SQLite may create an empty `-wal` and a `-shm` index next to the database. They hold no data, and the database file itself stays byte-identical.
- **Chart selection needs a mouse or touch.** The observation table is the keyboard route.
- **Test-environment sensitivity.** The unit suite has shown intermittent 5-second timeouts under heavy concurrent disk load, as described under Verification. It passed consistently on an idle machine, but this is limited evidence, not proof of reliability under load.
