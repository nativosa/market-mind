# MarketMind v0.9.0 — Web Explorer MVP

Stage 3.1: the first local, browser-based MarketMind application.

MarketMind is read-only educational research. It cannot place trades, a quoted spread is not a guaranteed profit, and two order books fetched one after the other are not one atomic snapshot.

## Highlights

- **A local browser app.** `npm run web` builds the UI and serves it from `http://127.0.0.1:4317`. Setup, settings and troubleshooting are in [`docs/web-explorer.md`](web-explorer.md).
- **React 19 and Vite 8 frontend** (`web/`), a plain single-page app with no UI kit.
- **A local read-only Node HTTP API** (`src/web`, `node:http`, no framework) with three GET routes: `/api/status`, `/api/markets` and `/api/markets/:id/inspect`.
- **Live market browsing.** One Gamma keyset page of 50 open markets per request, V1 or V2. **Load more** follows Gamma's own cursor, up to 5 pages (250 markets).
- **Search and filters over loaded pages.** Text search on question and slug, eligibility and order-book filters, and sorting by 24h volume or question. The UI states how many loaded markets it searched; it never claims to cover all of Polymarket.
- **Two-outcome order-book inspection.** Both books of one market side by side, with outcome labels and Yes/No roles taken from Polymarket's CLOB record.
- **Bid, ask, spread, midpoint, depth, quality and provenance.** Values are the server's exact decimal strings. Each book carries its quality class and issues; invalid books withhold every derived metric. Provenance shows the Polymarket book timestamps, when each response arrived, the gap between the two books, and the requests and budget used.
- **Responsive desktop and mobile views.** A two-column layout on desktop; on phones the detail opens as its own route (`#/market/:id`) with a back button. Keyboard navigable, with visible focus and light and dark themes.

## Architecture

- **Existing deterministic analytics reused.** Listing and inspection go through the same `listMarkets` and `inspectMarket` application code as the CLI and MCP server. No analytics changed.
- **Shared transport-neutral research layer.** Contracts, views, the response envelope and the live gate moved from `src/mcp` to `src/research`. The MCP server and the web server both use it, and the browser imports only its Zod contracts.
- **MCP backward compatibility maintained.** Tool names, contract ids and schemas are unchanged. All 20 MCP golden responses recorded from v0.8.0 are byte-identical (apart from the app version). The rolling-window budget is off for MCP.
- **The browser talks only to the local API.** Every Polymarket request is made by the local server. Lint boundaries keep Node, adapters and configuration out of the browser bundle, and a test checks the built bundle.

## Security and request limits

- **Loopback only.** The server binds `127.0.0.1`. Requests with any other `Host` are refused, which blocks DNS rebinding. There are no CORS headers.
- **Request validation and security headers.** GET only, no request bodies, Zod-validated queries and responses, a strict Content Security Policy, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`. Error bodies carry no stack traces, paths or environment values. Market text is untrusted and rendered as plain text.
- **Lifetime and rolling-window attempt budgets.** Each process has a lifetime ceiling (`MARKETMIND_WEB_MAX_REQUESTS`, default 2,000 attempts) and a rolling window (`MARKETMIND_WEB_WINDOW_REQUESTS`, default 60 attempts per 5 minutes). A listing reserves 2 attempts and an inspection 8; a call that does not fit is refused before any request is sent. One live call runs at a time. An upstream 429 pauses all live calls locally for 60 seconds.
- **Explicit refresh, no automatic polling.** Every live request follows a user action: opening the app, Load more, selecting a market, Refresh or Try again. Failures are never retried automatically by the UI.
- **No trading, wallets or order execution.** No credentials exist anywhere in the server, and the web server writes nothing to SQLite.

## Verification

- 1,946 unit and integration tests passed on the final clean `npm run verify` rerun (1 skipped: a Windows symlink case), with 97.28% line coverage.
- 57 Playwright end-to-end tests passed in Chromium, at desktop and phone sizes, against a local fixture upstream (3 skipped by design). `npm run e2e` is separate from `verify` and needs `npm run e2e:install` once.
- All 20 MCP golden responses unchanged.
- Baseline archive verified unchanged.
- `npm audit --omit=dev` reports 0 vulnerabilities.

## Live smoke verification

One bounded, manually authorized session on 2026-11-03, using the production build with the budget set to 12 attempts:

- V1 listing: 50 markets, all inspectable.
- Load more with Polymarket's real Gamma cursor: 50 additional markets, none repeated.
- One market inspected successfully: both books valid and two-sided, with token pairing confirmed from Polymarket's CLOB record.
- Six upstream HTTP attempts in total (1 listing, 1 page, 4 for the inspection), within the 12-attempt authorization, with no retries.
- The browser made no direct Polymarket requests: all 8 of its requests went to the local server.
- The SQLite database was unchanged.

This was a single smoke session, not an exhaustive live verification.

## Compatibility

- The database schema, CLI and MCP tools are unchanged. New observations record app version `0.9.0`, which is also sent in the User-Agent.
- Node.js 24.15 or later. Use `npm ci`: the servers run through `tsx`, a dev dependency.
- New runtime dependencies: `react` and `react-dom` 19.3.1. New dev dependencies include Vite's React plugin and `@playwright/test` 1.64.1.

## Known limitations

- **Real V2 web behaviour was not exercised** in the smoke session. V2 in the web explorer is covered by fixtures only.
- **A real upstream 429 cooldown was not exercised.** Offline unit and E2E tests cover it.
- **Search covers loaded market pages only**, at most 250 markets.
- **No automatic polling.** Displayed data is as old as its fetch time; refresh is manual.
- **Aborted requests may still consume upstream budget**, for example an inspection cancelled after its requests were sent.
- **Budget state resets when the server restarts.** Nothing is kept between sessions.
- **The two order books are not an atomic snapshot.** They are separate requests; the gap between them is shown.
- **Quoted spreads do not imply executable profit.** There is no fill, queue or execution information.
- **Not included:** historical charts and browser-based AI investigations (planned for later stages).
- **One intermittent unit-test timeout.** An existing `targetedCollect` test exceeded its 5-second limit once under machine load during Stage 3.1 verification; a clean rerun passed.
