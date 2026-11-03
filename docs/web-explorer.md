# MarketMind Web Explorer (Stages 3.1 and 3.2)

A local, read-only browser UI with two sections:

- **Live Explorer** (Stage 3.1): explore open Polymarket markets and compare the two order books of
  one market. It makes public, bounded `GET` requests to Polymarket.
- **Stored History** (Stage 3.2): the observations `collect` saved in your local SQLite database,
  with statistics, charts and the full stored evidence of each observation. It is offline: it reads
  the database read-only and never contacts Polymarket.

It runs entirely on your machine: a small Node HTTP server on `127.0.0.1` serves a React app and a
JSON API, and only that server talks to Polymarket's public APIs or reads the database.

> **Research only.** The explorer cannot place orders and recommends none. A quoted spread is the
> gap between resting quotes at one instant. It is **not a profit or an executable opportunity**:
> it says nothing about fills, fees, queue position or what happens next.

Contents: [Run it](#run-it) · [What it does](#what-it-does) ·
[Stored History](#stored-history-stage-32) · [Synthetic demonstration](#synthetic-demonstration-npm-run-webdemo) ·
[Architecture](#architecture) · [API](#api) · [Request budgets](#request-budgets) · [Cancellation, refresh and cooldowns](#cancellation-refresh-and-cooldowns) ·
[Data freshness and quality](#data-freshness-and-quality) · [Security](#security) ·
[Testing](#testing) · [Windows notes](#windows-notes) · [Troubleshooting](#troubleshooting) ·
[Known limitations](#known-limitations)

## Run it

Requirements: Node.js 24.15 or later (see `.nvmrc`) and npm 11+. Nothing else: there is no
database server, no account and no API key.

```bash
git clone <repository> market-mind
cd market-mind
npm ci
npm run web          # build the UI, then serve UI + API at http://127.0.0.1:4317
```

Open <http://127.0.0.1:4317>. **Opening the Live Explorer makes one bounded live request to
Polymarket's Gamma API** (the first page of open V1 markets). Everything after that is triggered by a
click. To open **Stored History** directly, with no Polymarket request at all, open
<http://127.0.0.1:4317/#/history>.

| Command | Purpose |
|---|---|
| `npm run web` | Production: build `web/` with Vite, then start the server on port 4317 |
| `npm run web:serve` | Production: start the server with the existing build (`web/dist`) |
| `npm run web:build` | Build the UI only |
| `npm run web:demo` | Offline synthetic demonstration of Stored History (see [below](#synthetic-demonstration-npm-run-webdemo)); never touches your database or Polymarket |
| `npm run web:dev` | Development: API server on 4317 plus Vite dev server on <http://127.0.0.1:5173> (hot reload). Open the 5173 address. |
| `npm run web:typecheck` | Type-check the browser app (`tsc -p web`) |

Stop the server with Ctrl+C; in-flight requests are cancelled.

Configuration (environment variables, all optional):

| Variable | Default | Range |
|---|---|---|
| `MARKETMIND_WEB_PORT` | 4317 | 1024–65535 |
| `MARKETMIND_WEB_MAX_REQUESTS` | 2000 | 1–20000 upstream attempts per server process |
| `MARKETMIND_WEB_WINDOW_REQUESTS` | 60 | 8–600 attempts per rolling 5 minutes |
| `MARKETMIND_WEB_DEV_ORIGIN` | – | One extra loopback origin, e.g. `http://127.0.0.1:5173` (set by `npm run web:dev`) |

The CLI's settings (`MARKETMIND_TIMEOUT_MS` and the other `MARKETMIND_*` HTTP options) apply too.
Stored History reads the CLI's database: `MARKETMIND_DB`, default `data/marketmind.sqlite`.
The server binds to `127.0.0.1` only; that is not configurable.

Development mode (`web:dev`) runs React in StrictMode, which may send the first market-list request
twice at startup. Use the production commands when you want to count requests.

## What it does

- **Browse** open markets, one Gamma page (50 markets) at a time, ordered by Gamma's reported 24h
  volume. V1 (CTF) and V2 markets are listed separately. "Gamma 24h volume" is traded volume, not
  liquidity or order-book depth.
- **Search, filter and sort locally.** Search (question or slug), the eligibility and status filters
  and sorting apply **only to the pages already loaded**, never to all of Polymarket. The page always
  says so, e.g. "12 matches among 100 loaded V1 markets".
- **Load more** explicitly: at most 5 pages (250 markets) per version, deduplicated by market ID. The
  explorer says whether it stopped at the end of the results or at its own 5-page limit.
- **Inspect** a market by selecting it: its metadata appears at once, then both outcome books are
  fetched and shown side by side (stacked on phones). Each book shows:
  - best bid and best ask with sizes, spread, midpoint, total depth and depth near the best price;
  - tick size, minimum order size, last trade price;
  - a ladder of 5, 10 or 20 levels per side, best price first;
  - its quality (valid, incomplete, suspicious, invalid) and state (two-sided, one-sided, empty), with
    any issue codes explained.
- Outcome labels are shown as Polymarket returns them; binary markets are not assumed to be Yes/No.
- Market text is third-party data and is always rendered as plain text.

## Stored History (Stage 3.2)

Stored History is the explorer's second section: an **offline** view of the observations that
`npm run cli -- collect` saved in your local SQLite database. It reads that database read-only and
never contacts Polymarket.

### Create history first

```bash
npm run cli -- collect --market-id <gammaId>   # one observation of one market; repeat later for history
npm run cli -- collect --max-markets 10        # or a bounded scan of several markets
npm run web                                    # then open http://127.0.0.1:4317/#/history
```

`collect` is the **only** command that writes the database (`data/marketmind.sqlite`, or
`MARKETMIND_DB`). Each run stores at most one observation per market. A history therefore grows
only when you run `collect` again: there is no scheduler and no background collection, and the
browser cannot start one.

Without a database, Stored History says so and shows the `collect` command; it never creates the
file. An empty database shows "No stored markets" and "No collection runs recorded".

### Navigation and addresses

| Address | Shows |
|---|---|
| `#/history` | Stored markets, newest observation first, 50 per page |
| `#/history/runs` | Collection runs, newest first (20 at a time, up to 100) |
| `#/history/market/<id>` | One market's dashboard: statistics, charts, observation table |
| `#/history/market/<id>/obs/<observationId>` | The same dashboard with one observation's stored evidence open |

Any of these can carry `?source=live` or `?source=all`. Every address can be bookmarked or opened
directly, and Back and Forward move between them without reading anything again.

- **Opening Stored History never starts the Live Explorer.** A history address, deep link
  included, lists and inspects nothing live and makes no Polymarket request. The header says
  "Offline: reads the local database, never Polymarket" and hides the live request budget.
- **The Live Explorer link** (header) returns to where you left it. Opening the Live Explorer may
  make public Polymarket `GET` requests (its first page is listed on open). Stored History never does.
- Each section loads the first time you open it and then stays loaded, so switching back and forth
  keeps your place.
- Nothing polls. A failed read shows an error with **Try again**; one click sends one request.
  Reload the page to read the database again (for example after another `collect`).

### Stored markets and collection runs

- **Stored markets** lists each market with stored observations: its latest question (third-party
  text, shown as text), observation counts (live and synthetic), first and last observation, and
  the latest run's status.
- **Collection runs** lists runs with status (complete, partial, interrupted, failed, running),
  request accounting, counts, the source type, and the reason an interrupted run was recovered.

### Market dashboard

- **Statistics** are the server's own (`src/analytics/history.ts`, the same code as the CLI's
  `history` and the MCP tool `get_market_history`). The browser computes no statistic. Every figure
  says how many samples it rests on.
- **Three SVG charts** over the real observation times:
  - best bid and ask per observation, with the midpoint, drawn as a bid-to-ask range;
  - spread, with the threshold as a dashed line;
  - resting depth for the reference outcome (total bid and ask depth, and depth within the band
    when every charted observation used the same band; otherwise the chart says why band depth is
    not charted).
- Each observation is its own mark. **Nothing is joined by lines or interpolated**: the charts show
  sampled states, not a continuous market history.
- **Gaps.** A gap longer than twice the median gap between usable samples is shaded "No
  observations: irregular gap", from the server's per-row flag.
- **Unusable observations** (only one book received, an invalid book, a one-sided or empty book, no
  metrics for this analytics version) are crosses on a rug below each plot, never values. The table
  gives the reason.
- **Synthetic observations** are hollow, dashed marks.
- **The observation table** is the accessible equivalent of the charts: newest first, 50 rows per
  page, every value as stored. Each row is a button (Enter opens its evidence). Clicking a chart
  selects the nearest observation; the table is the keyboard route.

### Observation evidence

Selecting an observation opens its stored evidence at its own address, and only that observation is
read (under the active source filter, up to 50 levels per side):

- observation and run IDs, when it became available and when it was saved, the run's outcome, the
  collecting MarketMind version;
- the market as observed (question, IDs, outcome labels, status);
- both books exactly as stored: levels in the order Polymarket sent them (not re-sorted), quality
  issue codes explained in words, Polymarket's book timestamp, request timing, content hash;
- pairing: whether both books arrived and the gap between the two responses;
- every stored metrics row, labelled **At collection**, **Recomputed later** or **Retrospective**
  (computed after the time asked for), with the version this history uses marked;
- the requests made during collection.

On a narrow screen the evidence comes first and the history stays loaded below it.

### Source filter and synthetic provenance

Every collection run is `live` (real Polymarket data) or `synthetic` (test or demonstration data).
The filter is applied by the server:

- **Live only** (the default on a normal server): synthetic runs, markets and observations are
  excluded everywhere; a deep link to a synthetic observation says it is not available.
- **Live + synthetic**: synthetic data is included and every synthetic item is labelled. A notice
  warns that statistics may then mix simulated and real observations.

A normal server never includes synthetic data unless you choose **Live + synthetic**.
**Synthetic data is not market evidence.**

### Limits

| Limit | Value | Meaning |
|---|---|---|
| Analysis window | newest 20,000 observations | Statistics use all of them |
| Chart series | newest 2,000 of the window | Charts and table show these; the page says "Plotted: N · Analysed: M" when fewer are shown than analysed |
| Table page | 50 rows | Paged in the browser within the series |
| Stored markets page | 50 markets | Previous / Next |
| Runs | 20, up to 100 | "Show more runs" |
| Evidence levels | 50 per side | The panel says how many of how many are shown |

### Reading the history correctly

- **Statistics count observations, not elapsed time.** "37.5% of samples" is not "37.5% of the
  time": samples are irregular, and nothing is known between them.
- **Charts show sampled states.** A spread may have opened and closed any number of times between
  two marks.
- **The two books are not an atomic snapshot.** They are two requests made one after another; the
  evidence shows the gap between their responses.
- **Resting depth is not executable liquidity.** It is the size resting at one instant, with no
  promise that an order would fill.
- **Exact decimals.** Prices, sizes and statistics are the stored decimal strings. The browser
  converts a value to a number only to place a mark on a chart; every value shown as text is the
  exact string.
- **Times** are the collecting computer's clock (`availableAt`); Polymarket's own book timestamps
  are in the evidence.
- Collected history is a sample of samples (see the README's known limitations): irregular gaps
  and survivorship bias are expected.

## Synthetic demonstration (`npm run web:demo`)

```bash
npm run web:demo     # build the UI, then serve a synthetic demonstration at http://127.0.0.1:4317/#/history
```

The demonstration shows Stored History without any collected data or internet connection:

- It creates a **new** directory under the OS temporary folder (`marketmind-demo-<random>`),
  generates a deterministic synthetic database there through the same storage code `collect` uses,
  and serves it. It never opens, reads or changes your configured database (`MARKETMIND_DB` is
  ignored; only `MARKETMIND_WEB_PORT` applies).
- Every run is `source_type = synthetic`, every question starts with `[SYNTHETIC DEMO]`, every
  recorded URL is on the reserved `.invalid` domain, and all timestamps (5 January 2026) and values
  are fixed. Two runs of the demo store the same records.
- The dataset: 3 markets over 17 synthetic runs (26 observations). A steady market sampled every
  15 minutes (16 observations, varying prices, spreads and depth); an irregular market with an
  invalid book, an incomplete observation (its second book request "failed") and a long gap; a
  sparse market with two observations, neither usable (insufficient evidence). One run is
  interrupted and recovered, one is partial.
- **Offline.** The server refuses every live route (`/api/markets...`, HTTP 403 `LIVE_DISABLED`)
  before the request gate, whose HTTP client refuses every request anyway. The browser opens Stored
  History, shows a permanent "Synthetic demonstration data" banner, defaults the filter to
  **Live + synthetic**, and shows the Live Explorer as disabled.
- **Stop with Ctrl+C** (or close the console window): the server closes, which releases every
  database handle, and the directory is deleted, but only after checking an ownership token written
  when it was created. The server prints the directory's path at startup.
- **Abrupt termination** (killing the process, a crash, a power loss) cannot clean up: the
  `marketmind-demo-*` directory stays in the temporary folder. It is harmless; delete it by hand.

## Architecture

```
browser ── same-origin GET /api/... ──▶ src/web (node:http, 127.0.0.1)
                                          │  src/research: contracts, views, live request gate
                       live routes ◀──────┼──────▶ stored routes
        src/app: listMarkets, inspectMarket        src/app/marketHistory (read-only open,
                       │                           query_only, one read transaction per request)
                       ▼                                    ▼
        Polymarket Gamma and CLOB (public GET only)   local SQLite database (never written)
```

- **`web/`** is a Vite + React 19 single-page app. Its only network access is `fetch` of `/api/...`
  in `web/src/api.ts`, and every response is validated with the server's own Zod contracts before it
  is shown. It imports nothing from `src/` except `src/research/contracts.ts` (enforced by ESLint and
  a bundle test).
- **`src/web/`** is the server: a small route table on `node:http`, no framework. It reuses the same
  application code and contracts as the CLI and the MCP server. `bin/marketmind-web.mjs` is the
  portable launcher.
- State lives in a pure reducer (`web/src/explorer.ts`); all requests go through one controller
  (`web/src/controller.ts`). There is no server-side cache: every result shown was fetched for you.
- Stored History has its own store (`web/src/historyStore.ts`, reducer in `web/src/history.ts`): one
  request per resource the address shows, superseded or no-longer-shown requests aborted, answers
  for another market, observation or filter refused. Charts are in-house SVG (`web/src/chart.ts`,
  no charting library).
- The stored routes call the same application functions as the CLI's `history` and `runs` and the
  MCP stored tools, so every statistic means the same everywhere. `src/web` cannot import storage or
  `node:sqlite` (ESLint).
- `src/demo/` is the synthetic demonstration: its generator, its temporary directory and its
  launcher (`bin/marketmind-web-demo.mjs`).

## API

All endpoints are `GET` and return JSON. Other methods get 405; there is no CORS.

| Endpoint | Upstream requests | Returns |
|---|---|---|
| `/api/status` | none | version, limits, remaining budget, cooldown state; whether live requests are enabled; Stored History's mode (`normal` or `demo`), default source and whether the database file exists (no path) |
| `/api/markets?version=v1\|v2&cursor=<nextCursor>` | 1 Gamma page (at most 2 attempts) | one page of market metadata and an opaque `nextCursor` |
| `/api/markets/:id/inspect?levels=0..20&depthBand=<0..1\|none>` | 4 (market, CLOB record, one book per outcome; at most 8 attempts) | the same `marketmind.inspect_market/1` result as the MCP tool |
| `/api/stored/markets?source=&limit=&offset=` | none (database) | stored markets, newest observation first, with counts; `hasMore`/`nextOffset` |
| `/api/stored/runs?source=&limit=` | none (database) | collection runs, as the MCP tool `list_collection_runs` returns them |
| `/api/stored/markets/:id/history?source=&asOf=&spreadThreshold=&analyticsVersion=` | none (database) | statistics over the analysis window plus the newest ≤2,000 observations with depth and gap flags (`marketmind.web.market_history/1`), or `no_history` |
| `/api/stored/observations/:id?source=&asOf=&levels=0..50` | none (database) | one observation's stored evidence, as the MCP tool `get_observation_details` returns it |

`source` is `live` or `all`; omitted, the server's default applies (`live`, or `all` in the
demonstration). Stored routes never use the live budget or the gate. A missing database is HTTP 404
`database_missing` (the file is not created); a busy one (a running `collect` holding a lock) is 503
and can be retried; an unknown observation, or a synthetic one under `source=live`, is 404. In the
demonstration every live route is refused with 403 `LIVE_DISABLED`.

Errors use one contract (`marketmind.web.error/1`) with distinct HTTP statuses: 400 invalid
arguments, 403 refused origin or host, 404 unknown market or route, 405 method, 422 ineligible
market, 429 rolling-window budget, 502/504 upstream failures, 503 lifetime budget, local cooldown or
shutdown. Errors never contain stack traces, paths or environment values.

The API never accepts a URL, path, SQL or command, and nothing it does writes data. The stored
routes open the database read-only (`PRAGMA query_only`), once per request, inside one read
transaction, and close it again; a database that does not exist is never created.

## Request budgets

Every physical HTTP attempt to Polymarket, retries included, is counted by the server.

| Limit | Default | Behaviour |
|---|---|---|
| Lifetime ceiling | 2,000 attempts per server process | When used up, live calls are refused (HTTP 503) until you restart the server |
| Rolling window | 60 attempts per 5 minutes | When full, calls are refused (HTTP 429) with the time until they fit again |
| One listing | at most 2 attempts | 1 request plus 1 retry |
| One inspection | at most 8 attempts | 4 requests plus retries |

A call reserves its maximum before it starts and is refused **before any request is sent** if the
reservation does not fit. Unused attempts are returned afterwards. Live calls run one at a time. The
header shows the remaining budget; `/api/status` reports it without spending any.

## Cancellation, refresh and cooldowns

- **Nothing polls and nothing retries on its own.** Refresh, Retry and Load more are buttons.
- **One inspection at a time.** Selecting another market, pressing Cancel or closing the details
  aborts the request in flight, and a late answer is never shown. An aborted inspection may already
  have used some attempts; the budget reflects that.
- **History navigation is free.** Each selected market has an address (`#/market/<id>`). Back,
  Forward or opening such a link selects the market but does not inspect it; press "Inspect order
  books" to fetch.
- **Refresh** keeps the earlier result visible until the new one arrives; if the refresh fails, the
  earlier result stays and is labelled as such.
- **Upstream 429 → local cooldown.** If Polymarket answers HTTP 429, the server refuses every live
  call for 60 seconds without contacting Polymarket, and the UI shows the remaining time with the
  retry button disabled.
- Markets the listing marks as not inspectable are not requested automatically ("Check with
  Polymarket anyway" asks explicitly).

## Data freshness and quality

- **Ages.** The list shows when its first page was fetched; the details show when the inspection
  arrived. Both are marked stale after 2 minutes. Data never updates by itself.
- **Two clocks.** Each book shows Polymarket's own book timestamp and, separately, when the local
  server received it. An old Polymarket timestamp alone does not prove a book is stale; a missing or
  odd one is shown as reported, never corrected.
- **Not a snapshot.** The two books are separate requests made one after another. The gap between
  their responses is shown, with a warning above 5 seconds.
- **Quality.** An invalid book (e.g. a malformed price) has its metrics and ladder withheld. Empty
  and one-sided books are valid states: missing sides are shown as missing, never as zero, and spread
  and midpoint need both sides.
- **Exact numbers.** Prices and sizes are the server's exact decimal strings (canonical form, so
  Polymarket's `"0.30"` appears as `"0.3"`); nothing is converted to floating point for display. Sizes
  are shares (outcome tokens), not dollars, and not a promise that an order of that size would fill.
- **Not saved.** Live results are not persisted. Durable history comes only from
  `npm run cli -- collect` (see the main README) and is shown in [Stored History](#stored-history-stage-32).

## Security

- The server listens on `127.0.0.1` only and answers only requests whose `Host` names it
  (`127.0.0.1:<port>` or `localhost:<port>`), which blocks DNS rebinding.
- API requests must come from the explorer's own origin: a foreign `Origin` or a cross-site
  `Sec-Fetch-Site` is refused with 403. There are no CORS headers, so other websites cannot read the API.
- Pages are served with a strict Content-Security-Policy (`default-src 'self'`, no inline script,
  `connect-src 'self'`), `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer`. Static
  files are served from `web/dist` only, with traversal and symlink protection.
- **The browser never contacts Polymarket.** Only the server does, with public `GET` requests and no
  credentials. There are no wallets, keys, logins or trading endpoints anywhere in the code.
- Market questions and outcome labels are rendered as React text, never as HTML.

## Testing

```bash
npm run verify       # typecheck (root, web, test-e2e), lint, offline unit tests with coverage
npm run e2e:install  # once per machine: download Playwright's Chromium build
npm run e2e          # build the UI, then run the Playwright suite (Chromium, 1440x900 and 390x844)
```

`npm run verify` needs no browser. The E2E suite (`test-e2e/`) runs entirely offline on `127.0.0.1`:
the real web server and production build over a deterministic fixture version of Polymarket, a Vite
dev server for StrictMode checks, and the synthetic demonstration exactly as `npm run web:demo`
starts it. Stored History is tested against fixture databases written through the `collect` code
path (missing, empty, a mixed live/synthetic history, and one market with 2,050 observations).

Every test fails if the browser requests anything but the app's own origin, if the server requests
a URL outside the fixtures, if the demonstration makes any upstream request, if the browser logs a
Content Security Policy violation, or if a database file changes (main file and WAL frames; the
`-shm` index, which every SQLite reader updates, is not compared). Screenshots (desktop and phone)
go to the git-ignored `test-results/e2e-screenshots/`; fixture databases to `test-results/e2e-db/`,
recreated on every run.

The demonstration's generator, isolation and lifecycle are unit-tested in `test/unit/demo.test.ts`,
including a spawned launcher with every network call blocked.

**Vitest timeouts under disk load.** Tests that write SQLite fixtures commit with an fsync each, so
when the disk's write latency spikes (another heavy writer on the machine, or the suite's own
coverage files), one of them can exceed Vitest's 5-second default, a different one each run. The
largest fixture (2,050 observations in `test/unit/webStored.test.ts`) is therefore written without
fsync. Limiting Vitest to 4 workers did not prevent the timeouts and made the suite slower, so the
default worker count is kept. Rerun before treating such a timeout as a regression.

## Windows notes

- Everything runs without a shell wrapper; the launchers use `process.execPath`.
- **Path letter case.** If your working directory's letter case differs from the folder on disk (for
  example `C:\git\market-mind` when the folder is `C:\GIT\market-mind`), running `npx playwright test`
  directly can load `@playwright/test` twice and report "No tests found" or "did not expect test() to
  be called here". `npm run e2e` avoids this by starting Playwright from the real on-disk path; if
  you run Playwright yourself, `cd` using the exact case.
- Use `127.0.0.1` rather than `localhost` in the browser address; the dev server allows exactly one origin.
- **The demonstration's temporary folder** is under `%TEMP%` (for example
  `C:\Users\<you>\AppData\Local\Temp\marketmind-demo-ab12cd`). Stop it with **Ctrl+C** in its
  console (or Ctrl+Break, or by closing the window): it closes the server and its database handles
  first, so Windows file locks are released, and retries the deletion briefly if antivirus or the
  indexer still holds a file. If the deletion still fails, it prints the folder it kept. Ending the
  process from Task Manager, or `taskkill /F`, cannot clean up: delete the leftover
  `marketmind-demo-*` folder by hand.
- **A running `collect` and Stored History together.** SQLite's WAL mode lets the browser read while
  `collect` writes. If the database stays locked for longer than 5 seconds, Stored History shows
  "The local database is busy" with Try again.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `port 4317 is already in use` | Another server is running. Stop it or set `MARKETMIND_WEB_PORT`. |
| `Invalid MARKETMIND_WEB_...` at startup | A setting is outside its range (see the table above). The window must allow at least 8 attempts. |
| `The web UI has not been built yet` (404 at `/`) | You ran `web:serve` without a build. Run `npm run web` or `npm run web:build`. |
| "The server refused this page's origin" | The page was opened from another address. Use the address the server prints (`http://127.0.0.1:4317`, or `http://127.0.0.1:5173` in dev). |
| "Cannot reach the MarketMind server" | The server stopped. Restart it and press Try again. |
| "Request budget for the last 5 minutes is used up" | Wait for the time shown, or raise `MARKETMIND_WEB_WINDOW_REQUESTS`. |
| "This server's request budget is used up" | Restart the server (or raise `MARKETMIND_WEB_MAX_REQUESTS`). |
| "Pausing after a Polymarket rate limit" | Polymarket returned 429; wait for the 60 s cooldown. |
| Stored History: "No local history database yet" | No database at `MARKETMIND_DB` (default `data/marketmind.sqlite`). Run `npm run cli -- collect ...`, or `npm run web:demo` to try it with synthetic data. |
| Stored History: "No stored markets", but `collect` ran | Its runs were synthetic, or used another `MARKETMIND_DB`. Try **Live + synthetic**, and check the variable. |
| Stored History: "The local database needs an upgrade" | It was created by an older MarketMind; running `collect` once migrates it. The browser never changes it. |
| "The local database is busy" | A `collect` is holding a lock; press Try again in a moment. |
| "Live Explorer is disabled on this server" | You are in `npm run web:demo`, which never contacts Polymarket. Use `npm run web` for live data. |
| `web:demo` leaves a `marketmind-demo-*` folder | It was killed rather than stopped with Ctrl+C. Delete the folder. |
| E2E: `Executable doesn't exist` | Run `npm run e2e:install` once. |
| E2E: "No tests found" on Windows | See [path letter case](#windows-notes). |

## Known limitations

- **Stored History is only as good as what `collect` stored.** Observations are discrete, irregular
  samples (a volume-ordered sample of markets per run, or the markets you named); statistics count
  samples, not time; nothing is known between observations.
- **No refresh button.** Reload the page to read the database again after another `collect`; a
  failed read has Try again.
- **No `asOf` control** in the browser, although the API accepts `asOf`. No zoom, no time-range
  paging beyond the newest 2,000 plotted observations, no multi-market comparison, no export.
- **Chart selection needs a mouse or touch.** The observation table is the keyboard route; it
  carries every plotted value.
- One outlier (for example a synthetic sample under Live + synthetic) compresses a chart's scale.
- A deep link to an observation older than the newest 2,000 opens its evidence, but no table row or
  chart mark is highlighted.
- The stored-markets page number is not part of the address: a reload starts at the first page.
  Offset paging can shift if `collect` adds a market between two pages.
- Stored routes read `node:sqlite` synchronously; a 20,000-observation history briefly blocks the
  server (tens of milliseconds), which is acceptable for one local user.
- The synthetic demonstration is a fixed, small dataset. Its numbers illustrate the interface and
  carry no information about any market.
