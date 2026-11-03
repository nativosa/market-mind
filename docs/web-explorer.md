# MarketMind Web Explorer (Stage 3.1)

A local, read-only browser UI for exploring open Polymarket markets and comparing the two order
books of one market. It runs entirely on your machine: a small Node HTTP server on `127.0.0.1`
serves a React app and a JSON API, and only that server talks to Polymarket's public APIs.

> **Research only.** The explorer cannot place orders and recommends none. A quoted spread is the
> gap between resting quotes at one instant. It is **not a profit or an executable opportunity**:
> it says nothing about fills, fees, queue position or what happens next.

Contents: [Run it](#run-it) · [What it does](#what-it-does) · [Architecture](#architecture) ·
[API](#api) · [Request budgets](#request-budgets) · [Cancellation, refresh and cooldowns](#cancellation-refresh-and-cooldowns) ·
[Data freshness and quality](#data-freshness-and-quality) · [Security](#security) ·
[Testing](#testing) · [Windows notes](#windows-notes) · [Troubleshooting](#troubleshooting)

## Run it

Requirements: Node.js 24.15 or later (see `.nvmrc`) and npm 11+. Nothing else: there is no
database server, no account and no API key.

```bash
git clone <repository> market-mind
cd market-mind
npm ci
npm run web          # build the UI, then serve UI + API at http://127.0.0.1:4317
```

Open <http://127.0.0.1:4317>. **Opening the page makes one bounded live request to Polymarket's
Gamma API** (the first page of open V1 markets). Everything after that is triggered by a click.

| Command | Purpose |
|---|---|
| `npm run web` | Production: build `web/` with Vite, then start the server on port 4317 |
| `npm run web:serve` | Production: start the server with the existing build (`web/dist`) |
| `npm run web:build` | Build the UI only |
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

## Architecture

```
browser ── same-origin GET /api/... ──▶ src/web (node:http, 127.0.0.1)
                                          │  src/research: contracts, views, live request gate
                                          │  src/app: listMarkets, inspectMarket
                                          ▼
                                   Polymarket Gamma and CLOB (public GET only)
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

## API

All endpoints are `GET` and return JSON. Other methods get 405; there is no CORS.

| Endpoint | Upstream requests | Returns |
|---|---|---|
| `/api/status` | none | version, limits, remaining budget, cooldown state |
| `/api/markets?version=v1\|v2&cursor=<nextCursor>` | 1 Gamma page (at most 2 attempts) | one page of market metadata and an opaque `nextCursor` |
| `/api/markets/:id/inspect?levels=0..20&depthBand=<0..1\|none>` | 4 (market, CLOB record, one book per outcome; at most 8 attempts) | the same `marketmind.inspect_market/1` result as the MCP tool |

Errors use one contract (`marketmind.web.error/1`) with distinct HTTP statuses: 400 invalid
arguments, 403 refused origin or host, 404 unknown market or route, 405 method, 422 ineligible
market, 429 rolling-window budget, 502/504 upstream failures, 503 lifetime budget, local cooldown or
shutdown. Errors never contain stack traces, paths or environment values.

The API never accepts a URL, path, SQL or command, and nothing it does writes data: no SQLite
database is opened.

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
  `npm run cli -- collect` (see the main README).

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
the real web server and production build over a deterministic fixture version of Polymarket, plus a
Vite dev server for a StrictMode check. Every test fails if the browser requests anything but the
app's own origin, or if the server requests a URL outside the fixtures. Screenshots go to the
git-ignored `test-results/e2e-screenshots/`.

## Windows notes

- Everything runs without a shell wrapper; the launchers use `process.execPath`.
- **Path letter case.** If your working directory's letter case differs from the folder on disk (for
  example `C:\git\market-mind` when the folder is `C:\GIT\market-mind`), running `npx playwright test`
  directly can load `@playwright/test` twice and report "No tests found" or "did not expect test() to
  be called here". `npm run e2e` avoids this by starting Playwright from the real on-disk path; if
  you run Playwright yourself, `cd` using the exact case.
- Use `127.0.0.1` rather than `localhost` in the browser address; the dev server allows exactly one origin.

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
| E2E: `Executable doesn't exist` | Run `npm run e2e:install` once. |
| E2E: "No tests found" on Windows | See [path letter case](#windows-notes). |
