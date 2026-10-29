# MarketMind

MarketMind is an educational, open-source TypeScript project that explores Polymarket prediction-market data.

**Stage 1** is a small **read-only** CLI. It does four things:

- discovers open markets
- inspects one binary market
- fetches both outcome order books
- computes deterministic order-book metrics: best bid/ask, spread, midpoint and depth

**Stage 2.1** adds `scan`: a bounded, deterministic scanner that inspects a sample of open markets and ranks **research candidates** by quoted spread and top-of-book size. It is still read-only and on-demand.

**Stage 2.2** adds local persistence: `collect` stores what a scan observed in a local SQLite database, and `history` / `runs` query it **without any network request**. Polymarket access stays read-only; the only new side effect is writing the local database file.

> **Disclaimer:** this project is for engineering education only. It does not trade, sign orders, or use wallets, private keys or authenticated endpoints. Nothing it prints is financial advice.

## Requirements

- Node.js 24.15 or later (`.nvmrc`; `node:sqlite` is a release candidate from 24.15)
- npm 11+
- No database server and no extra packages: storage uses the built-in `node:sqlite`

```bash
npm ci
```

## Usage

```bash
npm run cli -- markets [--limit 1..100] [--version v1|v2] [--cursor <next_cursor>] [--json]
npm run cli -- inspect --market-id <gamma id> [--levels 0..50] [--depth-band <0..1|none>] [--json]
npm run cli -- scan [options] [--json]          # see "Scanner (Stage 2.1)" below
npm run cli -- collect [scan options] [--db <path>] [--max-db-mb N] [--json]    # see "Snapshot collection (Stage 2.2)"
npm run cli -- history --market-id <id> [--as-of <ISO>] [--limit N] [--json]
npm run cli -- runs [--limit N] [--json]
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
| 6 | Partial scan or collection: a candidate failed, a market could not be stored, or the run stopped early (budget, deadline, Ctrl+C, rate limit) |
| 7 | Local storage error: database unavailable, disk full, schema too new, or soft size limit reached before a collection |

Optional environment overrides, all validated:

- `MARKETMIND_GAMMA_URL`, `MARKETMIND_CLOB_URL` (https only)
- `MARKETMIND_TIMEOUT_MS` (1–60000)
- `MARKETMIND_MAX_RETRIES` (0–5)
- `MARKETMIND_DB`: database path (`.sqlite`/`.db`; default `data/marketmind.sqlite`)
- `MARKETMIND_BUILD_ID`: optional build identifier stored with every run, e.g. `MARKETMIND_BUILD_ID=$(git rev-parse HEAD)`. MarketMind never calls Git at runtime.

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

## Scanner (Stage 2.1)

```bash
npm run cli -- scan                                   # v1, defaults below
npm run cli -- scan --version v2 --json
npm run cli -- scan --min-spread 0.02 --min-top-size 100 --top 5
```

| Option | Default | Meaning |
|---|---|---|
| `--version` | `v1` | Protocol version for discovery and asset IDs |
| `--discover-order` | `volume24hr` | Gamma `order=volume24hr&ascending=false`. Decides **which** markets are inspected, never their rank. `none` = Gamma's default order |
| `--max-markets` | 10 (max 30) | Eligible markets **inspected** (books fetched) |
| `--top` | 10 (max 50) | Ranked rows displayed; `rankedTotal` is always reported |
| `--page-size` / `--max-pages` | 50 / 2 (max 100 / 3) | Discovery bounds |
| `--min-spread` | 0 | Reference-outcome spread >= value |
| `--min-top-size` | 10 | min(best bid size, best ask size) of the reference outcome, **shares** |
| `--include-suspicious` | off | Admit `suspicious` books (crossed/locked are always excluded) |
| `--depth-band` | 0.05 | Display-only band depth |
| `--max-requests` | 48 (max 120) | Hard budget on **HTTP attempts, retries included** |
| `--concurrency` | 4 (max 8) | Max in-flight requests |
| `--max-duration-ms` | 60000 (1000-120000) | Scan deadline |

**Workflow.**
1. Discover open markets (keyset pages).
2. Classify them from metadata, with no CLOB request.
3. Select the first `--max-markets` eligible markets.
4. For each selected market, run the `/clob-markets` association check, then fetch both books with `GET /book`.
5. Assess book quality, compute metrics, apply filters, and rank.

Each market costs 3 requests, so a scan costs `pages + 3 x inspected` (<= 32 at the defaults). At most one retry is allowed per request.

**One row per market.** The **reference outcome** is outcome index 0 in Gamma order, confirmed by association, and every result names it. Spread and top size come from its book only. Liquidity of the complementary outcome is never added. The other book is assessed for quality and checked as an **advisory** complement (bid p vs ask 1-p, equal size), which is a warning only.

**Ranking.** Sort by spread descending, then top-of-book size descending, then market id ascending (numeric). This is a deterministic total order. It orders quoted market conditions worth investigating; **it is not a profit, return or trade signal**.

**Accounting.** Every discovered market lands in exactly one bucket:

`discovered = rankedTotal + filtered + excluded + failed + notScanned`

| Bucket | Meaning | Codes |
|---|---|---|
| ranked | valid two-sided book meeting all filters | - |
| filtered | user filters or the suspicious-book policy | `SPREAD_BELOW_MIN`, `TOP_SIZE_BELOW_MIN`, `SUSPICIOUS_BOOK` |
| excluded | ineligible market or structurally unsuitable book | `NOT_BINARY`, `ORDER_BOOK_DISABLED`, `NOT_ACTIVE`, `CLOSED`, `NOT_ACCEPTING_ORDERS`, `STATUS_UNKNOWN`, `EMPTY_BOOK`, `ONE_SIDED_BOOK`, `CROSSED_BOOK`, `LOCKED_BOOK` |
| failed | API error, malformed data or integrity failure | `MALFORMED_RECORD`, `MALFORMED_MARKET`, `ASSOCIATION_MISMATCH`, `INVALID_BOOK`, `VALIDATION`, `HTTP_*` |
| notScanned | not inspected | `SAMPLE_LIMIT` (expected), `BUDGET_EXHAUSTED`, `DEADLINE`, `CANCELLED`, `RATE_LIMITED` |

**Discovery counts.**
- `discovery.recordsReceived`: raw Gamma records on all fetched pages, duplicates included.
- `counts.discovered`: unique records, by market id. Malformed records without an id are always unique.
- `discovery.duplicates`: repeated records, listed with their page. A repeat is reported, never inspected twice, and never counted toward `--max-markets`. If the volume order shifts between page requests, Gamma can return a market twice.
- `counts.selected`: markets actually inspected.

So `recordsReceived = discovered + duplicates` and `selected <= eligible <= discovered`.

A scan is **complete** (exit 0) when the only unscanned markets are `SAMPLE_LIMIT`. Any failed candidate, any other `notScanned` reason, or a failed later discovery page makes it **partial** (exit 6). A partial report is still printed in full.

**Budget, concurrency and cancellation.**
- The request budget is synchronous, so it cannot be overrun by concurrent work.
- Each market reserves its 3 first attempts before it starts. Retries draw from the unreserved pool, and unused units are always released.
- A refused first attempt raises a distinct `BudgetExceeded` error, so nothing is sent. A refused retry rethrows the real failure with `budgetExhausted: true`. Cancellation is a separate `Cancelled` error, and it is checked before the budget.
- One shared abort signal combines the deadline, Ctrl+C (first press; a second press exits immediately) and a rate-limit circuit. A 429 that survives its retry stops new work.
- In-flight requests are aborted, completed markets are kept, and the rest are reported as `notScanned`.

**Observations are not a snapshot.**
- Every book is a separate request with its own timing.
- Each book also carries its server timestamp, i.e. the last book update.
- The report shows the scan's time window and the time gap between a market's two book requests.

**Changes to scan output in v0.3.0.** These are additive. The JSON field set, accounting, buckets, reason codes, requests, budget and exit codes are unchanged.
- **Partial books are kept.** A market whose sibling book request failed, or that was stopped mid-inspection, now lists in `outcomes` the books that did arrive, each with its quality assessment. Metrics stay `null` for such markets. Earlier versions returned an empty `outcomes` list here.
- The `notScanned` explanation for a stopped market now says the received books are kept, instead of discarded.
- Internally, each scan entry also records its discovery page and outcome-association status (`confirmed`, `mismatch`, `failed`, `not_attempted`). `collect` stores these. They are not part of the `scan --json` output.

## Snapshot collection (Stage 2.2)

```bash
npm run cli -- collect --max-markets 5            # scan 5 markets and store every inspected one
npm run cli -- runs                               # collection runs and their status (offline)
npm run cli -- history --market-id 562803         # stored history of one market (offline)
npm run cli -- history --market-id 562803 --as-of 2026-10-29T08:00:00Z --json
```

**What `collect` does.** `collect` is exactly a `scan`, with the same options, caps, budget, deadline and Ctrl+C handling. On top of that, **every selected market is written to the database as soon as it settles**, one atomic transaction per market. Ranked, filtered, excluded, failed and stopped markets are all stored. Markets that were never selected are only counted. The command makes the same read-only GET requests as `scan`.

**Database.**
- **Location:** `data/marketmind.sqlite` by default. The `data/` directory is created on demand. Override with `--db` or `MARKETMIND_DB`.
- **Git:** database files, including the `-wal` and `-shm` side files, are ignored by Git.
- **Engine settings:** SQLite in WAL mode with foreign keys, STRICT tables, and parameterized SQL only. Write transactions use `BEGIN IMMEDIATE` with a 5 s busy timeout. `journal_size_limit` is 8 MiB.
- **Network drives:** keep the file on a local disk. WAL does not work over network filesystems.

**Stored evidence.**

| Table | Holds |
|---|---|
| `collection_run` | run id, status (`running`, `complete`, `partial`, `interrupted`, `failed`), accounting (`pending`, `verified`, `incomplete`), owner pid/host and heartbeat, app version, build id, schema/analytics/Node/SQLite versions, scan configuration, counts, budget, observation window, source type (`live`/`synthetic`) |
| `market`, `outcome` | **immutable identity only**: market ↔ condition id and protocol; asset id ↔ (market, outcome index) and kind (`tokenId` for v1, `positionId` for v2) |
| `market_observation` | one row per selected market per run: bucket, reason/warning codes, pairing (`paired`/`incomplete`/`none`), association status, **observed** metadata (question, outcome labels, status flags, end date, Gamma 24h volume), evidence availability |
| `book_observation` | each received book: observed label, reported ids, upstream hash and book timestamp, tick/min size/last trade **as received**, request URL, status, attempt and receive times, Date header, quality and issues |
| `book_content` | exact raw price levels as received (wire order, original strings), content-addressed by SHA-256 and deduplicated across observations |
| `market_metrics` | derived metrics keyed by `(observation, analytics_version)`, with who computed them (`collect`/`recompute`), when, and which app version/build. Prices and sizes are exact decimal strings |
| `persistence_failure` | selected markets whose observation could not be written, with a reason code |
| `request_log` | every request used as evidence (discovery pages, associations, books, including failed ones) |

**Captured books are the source of truth. Metrics are a versioned cache.**
- Changing a metric definition means bumping `ANALYTICS_VERSION`.
- A recompute (library function in 2.2) rebuilds the exact captured books and writes rows for the new version beside the old ones.
- `history` always uses exactly one analytics version (`--analytics-version`, default current).

**Identity vs metadata.**
- A changed label, question, status or end date is stored per observation and flagged by `history` (`LABEL_CHANGED`, `QUESTION_CHANGED`, `STATUS_CHANGED`, `END_DATE_CHANGED`).
- A changed **identifier** (condition id, protocol, or an asset moving to another market or index) is rejected with `IDENTITY_CONFLICT`. Nothing is overwritten.

**Atomicity and pairing.**
- A market's observation, books, content, metrics and request evidence are written in one transaction. Any failure rolls all of it back and records a `persistence_failure`.
- The two outcome books are **separate requests, never an atomic snapshot**. The time between them is stored as `pair_skew_ms`.
- **Incomplete evidence is stored honestly:**
  - A book whose sibling request failed is kept as an `incomplete` observation with no metrics.
  - Books assessed `invalid` are kept as audit evidence, also without metrics.
  - Observations without any book record why (`none`).

**Accounting.** For every normally finalized run:

`selected = persistedObservations + persistenceFailures (+ unrecorded failures)`

A run with any persistence failure is never `complete`. A run recovered after a crash has `accounting = incomplete`: it counts only the rows that were actually stored, and its scan totals are `null` (unknown), never invented.

**Interruptions and crashes.**

| Event | Result |
|---|---|
| Ctrl+C or deadline | Settled markets are stored (in-flight ones as `notScanned`, with any books received). The run is `interrupted` |
| Fatal storage error (disk full, I/O, read-only) | The scan stops, earlier markets stay stored, the remaining ones are counted as failures. The run is `failed`, exit 7 |
| Hard crash or kill | Committed markets stay stored. The run stays `running` |

A later `collect` marks a `running` run `interrupted` only when **all** of the following hold:
- it was started on the same host;
- its owner process provably no longer exists;
- its heartbeat is older than 240 s;
- a compare-and-set update succeeds.

An old heartbeat alone never does it. A run whose owner is alive, unverifiable or on another host is left unchanged, and `runs` shows it as `running?` with the reason. `history` and `runs` never modify anything.

**Soft size limit.**
- `--max-db-mb` (default 1024) is an **admission check**, not a quota. Before any HTTP request, `collect` refuses with exit 7 if database + WAL + SHM already reach the limit.
- A run that was admitted always finishes, overshooting by at most a few MiB, and then warns `DB_SIZE_LIMIT_EXCEEDED`.
- Nothing is ever deleted automatically.

**History semantics.**
- `--as-of` filters by **evidence availability**: the time the last response an observation depends on arrived. A paired observation whose second book arrived after the boundary is excluded, even if the first arrived before. The filter runs in SQL before anything else.
- Statistics use **all usable samples** in the analysis window, which holds at most the 20,000 most recent observations; truncation is reported. Usable means both books valid, metrics for the selected version, and a two-sided reference book. `--limit` only trims the displayed rows.
- Each summary reports its sample count `n`: min/median/max spread, current/previous/change, top-size change, share of samples at or above `--spread-threshold`, gaps between samples, and distinct book states. Missing values are `-`/`null`, never `0`.
- Synthetic runs are excluded unless `--include-synthetic` is given. `collect` always records `live`.

**What snapshots cannot tell you.** These are sample-count statistics, not time-weighted ones. A snapshot is the aggregated resting size at one instant. Snapshots say nothing about:
- what happened between samples;
- fills, queue position or execution probability;
- latency, hidden liquidity or cancellations.

Repeated identical samples are not independent events.

**Backups and maintenance.**
- **Backup:** close any running `collect`, then copy the `.sqlite` file **together with** its `-wal`/`-shm` files. Alternatively, with the `sqlite3` shell, run `VACUUM INTO 'backup.sqlite'`, which produces a consistent copy; the target must not exist.
- **Deleting old data:** do it only deliberately, with your own tools.

**Database growth (measured 2026-10-29, default settings, after checkpoint).**
- Empty schema: 108 KiB.
- First 10-market collection: +76 KiB, about **7.6 KiB per market snapshot**.
- Repeat collection: +68 KiB, about **6.8 KiB per snapshot**, with 4 of 20 book contents deduplicated.

Projections at ~7 KiB per snapshot (heavier books cost more):

| Schedule (run externally) | Snapshots | Approx. size |
|---|---|---|
| 10 markets every 15 min for 30 days | 28,800 | ~0.2 GiB |
| 30 markets every 5 min for 30 days | 259,200 | ~1.8 GiB |

## Architecture

```
src/
  cli/        argument parsing, text tables, JSON views, exit codes
  config/     defaults + validated environment overrides
  domain/     types and pure helpers (decimal, market, order book, errors, provenance)
  analytics/  deterministic book metrics and quality classification
  adapters/polymarket/  HTTP client (timeout, bounded retry), Zod schemas, Gamma/CLOB clients, normalization
  adapters/storage/     node:sqlite connection + transactions, migrations, snapshot store, process liveness
  app/        use cases: listMarkets, inspectMarket, scanMarkets, collectMarkets, marketHistory (+ concurrency helpers)
```

Dependencies point inward: `cli → app → adapters/analytics/domain`. ESLint enforces two boundaries:

- `domain` and `analytics` cannot import outer layers or `node:*`, and may not use `parseFloat`/`Number`/`Math`.
- Only `httpClient.ts` may call `fetch`.
- Only `adapters/storage/sqlite.ts` may import `node:sqlite`. Storage and the Polymarket adapters never import each other. The scanner talks to storage only through an optional `onSettled` callback that `collect` provides.

The HTTP client itself only offers a `GET` method. The scanner adds an optional request budget and abort signal to it; both are additive and unused by `markets`/`inspect`.

## Quality gates

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint (typescript-eslint, type-checked)
npm test            # offline Vitest suite; real fetch is disabled
npm run coverage    # v8 coverage with thresholds (90% core modules, 75% global)
npm run verify      # typecheck + lint + coverage
npm run smoke       # OPT-IN live smoke test against public endpoints
```

The live smoke tests run Stage 1 inspection and a 3-market scan separately for v1 and v2. They also run a 3-market v1 `collect` into a **temporary** database (deleted afterwards), followed by offline `history`/`runs` queries. Each run allows at most **12 HTTP requests**, every request counted, including market-detail lookups. Each run reports one of four results:

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

Verified on 2026-10-29 (docs plus a bounded live read-only probe):

- Keyset `order=volume24hr&ascending=false` works, including across `after_cursor`. The docs' example field `volume_num` is **rejected with 422** (`order fields are not valid`). The scanner fails loudly instead of falling back.
- `GET /books?token_ids=...` is documented in the OpenAPI spec but returns **400 `Invalid payload`** live, for comma-separated, single and repeated ids. `POST /books` exists but is not used, to keep the GET-only invariant. The scanner uses one `GET /book` per outcome.
- Rate limits are Cloudflare throttling (requests are delayed, not rejected): Gamma `/markets` 300/10 s, CLOB `/book` 1,500/10 s. A scan makes at most 120 requests.
- In live data, binary YES/NO books have been exact complements so far (no `COMPLEMENT_MISMATCH` seen). This is still treated as advisory.
- Never-traded V2 books return `last_trade_price: ""` (classified `incomplete`).

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
- **The scan inspects a sample.** At most 30 markets, chosen by Gamma 24h volume (or Gamma's default order). Its ranking describes that sample, not the whole market.
- **Wide spreads are often artefacts.** In thin or extreme-price markets (`EXTREME_PRICE`), a wide spread is often tick granularity or untradeable size. Filters and warnings reduce this; they cannot remove it.
- **Collected history is a sample of samples.** Each collection inspects a volume-ordered sample. Per-market histories therefore have irregular gaps and survivorship bias, and a hard crash loses the markets that were in flight.
- **`node:sqlite` is a release candidate** in Node 24, so its API may still change. All use is confined to one adapter file.
- **Scope.** Polymarket access is read-only and on-demand: there is no streaming, scheduling, monitoring or trading. Repeated collection is your explicit decision; there is no background mode.

## License

MIT
