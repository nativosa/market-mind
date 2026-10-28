# MarketMind

MarketMind is an educational, open-source TypeScript project that explores Polymarket prediction-market data.

**Stage 1** is a small **read-only** CLI. It does four things:

- discovers open markets
- inspects one binary market
- fetches both outcome order books
- computes deterministic order-book metrics: best bid/ask, spread, midpoint and depth

> **Disclaimer:** this project is for engineering education only. It does not trade, sign orders, or use wallets, private keys or authenticated endpoints. Nothing it prints is financial advice.

## Requirements

- Node.js 24 LTS (`.nvmrc`)
- npm 11+

```bash
npm ci
```

## Usage

```bash
npm run cli -- markets [--limit 1..100] [--version v1|v2] [--cursor <next_cursor>] [--json]
npm run cli -- inspect --market-id <gamma id> [--levels 0..50] [--depth-band <0..1|none>] [--json]
```

| Option | Default | Notes |
|---|---|---|
| `--limit` | 5 | Gamma silently caps page size at 100 (observed) |
| `--version` | `v1` | Always sent explicitly. `v1` = CTF markets, `v2` = Polymarket Protocol V2 |
| `--cursor` | – | `next_cursor` from a previous page |
| `--levels` | 10 | Book levels per side in `--json` output (bounded output) |
| `--depth-band` | 0.05 | Depth within this distance of the best price; `none` disables it |

### Examples

```bash
# V1 (CTF) discovery: five open markets
npm run cli -- markets --limit 5

# V2 (Polymarket Protocol V2) discovery
npm run cli -- markets --limit 2 --version v2

# Next page, using the cursor printed by the previous command
npm run cli -- markets --limit 5 --cursor <next_cursor>

# Inspect a binary market (use an id from the discovery output)
npm run cli -- inspect --market-id 559651

# Same inspection as JSON, 3 levels per side, without band depth
npm run cli -- inspect --market-id 559651 --json --levels 3 --depth-band none
```

The market ids shown above existed when this was written. Markets close, so pick a current id from `markets`.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Unexpected error |
| 2 | Usage or configuration error |
| 3 | Not found or ineligible |
| 4 | Upstream, network, timeout or rate-limit error |
| 5 | Invalid data: validation failure, outcome association mismatch, or invalid book |

Optional environment overrides, all validated:

- `MARKETMIND_GAMMA_URL`, `MARKETMIND_CLOB_URL` (https only)
- `MARKETMIND_TIMEOUT_MS` (1–60000)
- `MARKETMIND_MAX_RETRIES` (0–5)

## How it works

1. **Discovery.** `GET gamma-api /markets/keyset?closed=false&limit=N&version=vX` (keyset pagination via `after_cursor`).
2. **Market detail.** `GET gamma-api /markets/{id}`. `outcomes` and `clobTokenIds` arrive as JSON-encoded strings and are parsed strictly.
3. **Asset IDs by protocol.** For v1 (CTF) markets the asset ID is the `clobTokenIds[i]` entry (`tokenId`). For v2 it is the `positionIds[i]` entry (`positionId`). In live data, v1 markets also carry `positionIds` that are *not* CLOB asset IDs, so the version decides.
4. **Outcome association.** `GET clob /clob-markets/{condition_id}` lists `{ t: tokenId, o: outcomeLabel }` explicitly. Every selected asset ID must appear there with the same label as Gamma's outcome at that index, or the command fails with `AssociationMismatch`. YES/NO roles are assigned only to outcomes labelled exactly Yes/No. Other binaries, such as team names, have no role.
5. **Books.** `GET clob /book?token_id=<assetId>` for both outcomes, in parallel.
6. **Quality and metrics.**
   - Decimal strings are parsed strictly (`^\d+(\.\d+)?$`) into `big.js` values. No floating-point arithmetic is used.
   - Levels are aggregated by price, zero-size levels are removed, then levels are sorted locally. The documented wire order is never trusted.
   - Missing data stays `null`. It is never turned into `0`.

Book quality classes:

| Class | When | Effect |
|---|---|---|
| `invalid` | malformed decimal, price outside [0, 1], `asset_id` ≠ requested, book `market` ≠ the market's condition ID | metrics withheld, exit 5 |
| `suspicious` | crossed/locked book, off-tick prices, duplicate/zero-size levels, unexpected wire order | warning |
| `incomplete` | missing timestamp, hash, tick size, min order size or last trade price | warning |
| `valid` | none of the above; **empty and one-sided books are valid** | – |

Each HTTP response records its own timing:

- first and final attempt start
- response received
- duration
- attempts
- the HTTP `Date` header

The CLOB `/book` body timestamp is tracked separately as the server book timestamp. `--json` output serializes every decimal as a fixed-notation string.

## Architecture

```
src/
  cli/        argument parsing, text tables, JSON views, exit codes
  config/     defaults + validated environment overrides
  domain/     types and pure helpers (decimal, market, order book, errors, provenance)
  analytics/  deterministic book metrics and quality classification
  adapters/polymarket/  HTTP client (timeout, bounded retry), Zod schemas, Gamma/CLOB clients, normalization
  app/        use cases: listMarkets, inspectMarket
```

Dependencies point inward: `cli → app → adapters/analytics/domain`. ESLint enforces two boundaries:

- `domain` and `analytics` cannot import outer layers or `node:*`, and may not use `parseFloat`/`Number`/`Math`.
- Only `httpClient.ts` may call `fetch`.

The HTTP client itself only offers a `GET` method.

## Quality gates

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint (typescript-eslint, type-checked)
npm test            # offline Vitest suite; real fetch is disabled
npm run coverage    # v8 coverage with thresholds (90% core modules, 75% global)
npm run verify      # typecheck + lint + coverage
npm run smoke       # OPT-IN live smoke test against public endpoints
```

The live smoke test runs separately for v1 and v2. Each run allows at most **12 HTTP requests**, every request counted, including market-detail lookups. Each run reports one of four results:

| Result | Meaning |
|---|---|
| **PASS** | An eligible market was inspected and all invariants held. |
| **SKIP `LIVE_DATA_UNAVAILABLE`** | No eligible market was found within the budget. |
| **SKIP `UPSTREAM_UNAVAILABLE`** | Network error, timeout, 5xx or 429. |
| **FAIL** | Validation error, association mismatch, invalid book, broken invariant, or budget exceeded. |

A SKIP is not evidence of a working integration.

## Polymarket API notes (Stage 1)

Verified from docs.polymarket.com or live read-only probes on 2026-10-28:

- `version` omitted → v1 only. Unknown Gamma id → HTTP 422. Unknown CLOB token → HTTP 404.
- `/book` prices and sizes are strings. The docs say bids are ascending and asks descending, but this project sorts locally anyway.
- Public market data needs no credentials.

Assumptions:

- 429 handling on market-data endpoints. The docs describe IP limits as throttled/queued, not rejected.
- The maximum page size is 100, based on observation.
- `/book` `timestamp` is epoch milliseconds.

## Known limitations

- **V2 has only been verified live with empty books.** At verification time, the open V2 markets found had no bids or asks. V2 metrics with real bids and asks are covered by offline tests only.
- **Book timestamps are the upstream book update time.** The CLOB `/book` `timestamp` is when the book was last reported updated, not when the response was sent. It can be minutes or hours older than the request. Request and response times are therefore recorded separately for each HTTP call.
- **`last_trade_price` is displayed exactly as returned by the API.** It is not interpreted or validated against the book. Live, both outcomes of the same market have reported the same value.
- **Some behaviour rests on undocumented assumptions.** These are: HTTP 429 handling on market-data endpoints (the docs describe throttling, not rejection), the observed 100-market page cap, and the `/book` timestamp being epoch milliseconds.
- **A skipped live test does not prove the integration works.** Only a PASS from `npm run smoke` shows that discovery, association, books and metrics worked against live data.
- **Stage 1 scope.** It is read-only and on-demand only: there is no streaming, monitoring, persistence or trading.

## License

MIT
