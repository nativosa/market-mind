import type { InspectResult } from "../app/inspectMarket.js";
import type { ListMarketsResult } from "../app/listMarkets.js";
import type { CollectResult } from "../app/collectMarkets.js";
import type { HistoryResult, RunsResult } from "../app/marketHistory.js";
import { countScan, type ScanEntry, type ScanResult } from "../app/scanMarkets.js";
import { decimalToString, type Decimal } from "../domain/decimal.js";
import type { MarketMindError } from "../domain/errors.js";
import type { Provenance } from "../domain/provenance.js";
import { SCAN_DISCLAIMER } from "./jsonView.js";

// Human-readable output. ASCII only so it renders in any Windows console code page.

const NONE = "-";
const dec = (d: Decimal | null | undefined): string => (d == null ? NONE : decimalToString(d));
const time = (iso: string): string => iso.slice(11); // "21:05:12.101Z"
const flag = (b: boolean | null): string => (b === null ? "?" : String(b));

export function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 6)}...${id.slice(-4)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

function requestLine(p: Provenance, label: string): string {
  const t = p.timing;
  return [
    `  ${p.source.padEnd(5)} ${label}`,
    `started ${time(t.finalAttemptStartedAt)}`,
    `received ${time(t.responseReceivedAt)}`,
    `${t.durationMs} ms`,
    `${t.attempts} attempt${t.attempts === 1 ? "" : "s"}`,
    `HTTP ${p.httpStatus}`,
  ].join("  ");
}

export function formatMarkets(result: ListMarketsResult): string {
  const { query, provenance } = result;
  const rows = result.markets.map(({ market, eligibility }) => [
    market.gammaId,
    market.version,
    market.outcomeLabels.length === 2 ? "yes" : "no",
    market.enableOrderBook === null ? "?" : market.enableOrderBook ? "on" : "off",
    eligibility.eligible ? "yes" : "no",
    truncate(market.question, 70),
  ]);
  const out = [
    `Polymarket markets  protocol=${query.version}  open  limit=${query.limit}${query.cursor ? "  (continued from cursor)" : ""}`,
    `date ${provenance.timing.responseReceivedAt.slice(0, 10)}`,
    "Request",
    requestLine(provenance, "GET /markets/keyset"),
    "",
    rows.length > 0 ? table(["ID", "VER", "BINARY", "BOOK", "INSPECTABLE", "QUESTION"], rows) : "(no markets returned)",
  ];
  if (result.skipped.length > 0) {
    out.push("", `Skipped ${result.skipped.length} malformed market record(s):`);
    for (const s of result.skipped) out.push(`  ${s.id ?? "(no id)"}: ${s.issues.slice(0, 3).join("; ")}`);
  }
  out.push("", result.nextCursor ? `next cursor: ${result.nextCursor}` : "next cursor: (none)");
  return out.join("\n");
}

export function formatInspect(result: InspectResult): string {
  const { market } = result;
  const out = [
    `Market ${market.gammaId} (${market.version})  "${market.question}"`,
    `conditionId ${market.conditionId}`,
    `active=${market.active} closed=${market.closed} acceptingOrders=${flag(market.acceptingOrders)} ` +
      `enableOrderBook=${flag(market.enableOrderBook)} negRisk=${flag(market.negRisk)}`,
    `Association: CLOB /clob-markets explicit pairing OK; Gamma index cross-check ${result.association.gammaIndexCrossCheck.toUpperCase()}`,
    `date ${market.provenance.timing.responseReceivedAt.slice(0, 10)}`,
    "",
  ];

  const kind = result.outcomes[0]?.outcome.assetIdKind ?? "assetId";
  out.push(
    table(
      ["OUTCOME", "ROLE", `ASSET ID (${kind})`, "QUALITY", "BID", "ASK", "SPREAD", "MID", "BID DEPTH", "ASK DEPTH", "LEVELS b/a"],
      result.outcomes.map(({ outcome, assessment }) => {
        const m = assessment.metrics;
        return [
          outcome.label,
          outcome.role ?? NONE,
          shortId(outcome.assetId),
          assessment.quality,
          dec(m?.bestBid?.price),
          dec(m?.bestAsk?.price),
          dec(m?.spread),
          dec(m?.midpoint),
          m ? dec(m.bidDepth) : NONE,
          m ? dec(m.askDepth) : NONE,
          m ? `${m.levelCounts.bids}/${m.levelCounts.asks}` : NONE,
        ];
      }),
    ),
    "",
  );

  out.push("Book details");
  for (const { outcome, book, assessment } of result.outcomes) {
    const m = assessment.metrics;
    const band = m?.depthBand ? `depth within ${dec(m.depthBand)} of best: bids ${dec(m.bidDepthWithinBand)} / asks ${dec(m.askDepthWithinBand)}` : "depth band: off";
    out.push(
      `  ${outcome.label}: ${band}; tick ${book.tickSize ?? NONE}; min size ${book.minOrderSize ?? NONE}; ` +
        `last trade ${book.lastTradePrice ?? NONE}; server book ts ${book.serverTimestamp.iso ?? NONE}; hash ${book.hash ? shortId(book.hash) : NONE}`,
    );
  }

  const issues = result.outcomes.flatMap(({ outcome, assessment }) =>
    assessment.issues.map((i) => `  ${outcome.label}  [${i.category}/${i.severity}] ${i.code}: ${i.detail}`),
  );
  out.push("", issues.length > 0 ? ["Quality issues", ...issues].join("\n") : "Quality issues: none");

  const [gammaReq, infoReq] = result.requests;
  out.push("", "Requests (each line is one HTTP response)");
  if (gammaReq) out.push(requestLine(gammaReq, `GET /markets/${market.gammaId}`));
  if (infoReq) out.push(requestLine(infoReq, `GET /clob-markets/${shortId(market.conditionId)}`));
  for (const { outcome, book } of result.outcomes) {
    out.push(`${requestLine(book.provenance, `GET /book ${outcome.label} (${shortId(outcome.assetId)})`)}  server book ts ${book.serverTimestamp.iso ? time(book.serverTimestamp.iso) : NONE}`);
  }

  out.push("", result.warnings.length > 0 ? `Warnings:\n${result.warnings.map((w) => `  ${w}`).join("\n")}` : "Warnings: none");
  return out.join("\n");
}

const MAX_TEXT_ENTRIES = 25;
const codes = (e: ScanEntry) => e.reasons.map((r) => r.code).join(",");

function entryLines(entries: readonly ScanEntry[], detail: boolean): string[] {
  const shown = entries.slice(0, MAX_TEXT_ENTRIES).map((e) => {
    const head = `  ${e.gammaId ?? "(no id)"}  ${codes(e)}`;
    const why = detail ? `  ${e.reasons.map((r) => r.detail).join("; ")}` : "";
    return truncate(`${head}${why}  ${e.market ? `"${e.market.question}"` : ""}`.trimEnd(), 160);
  });
  if (entries.length > MAX_TEXT_ENTRIES) shown.push(`  ... ${entries.length - MAX_TEXT_ENTRIES} more (see --json)`);
  return shown;
}

/** Markets per reason code (a market with several reasons counts once under each). */
function countByCode(entries: readonly ScanEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) for (const code of new Set(e.reasons.map((r) => r.code))) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([c, n]) => `${c} ${n}`)
    .join(", ");
}

export function formatScan(result: ScanResult): string {
  const o = result.options;
  const c = countScan(result);
  const bucket = (b: ScanEntry["bucket"]) => result.entries.filter((e) => e.bucket === b);
  const w = result.window;
  const out = [
    `Polymarket scan  protocol=${o.version}  discover-order=${o.discoverOrder}  status=${result.status.toUpperCase()}` +
      (result.stopReasons.length > 0 ? `  stopped: ${result.stopReasons.join(", ")}` : ""),
    SCAN_DISCLAIMER,
    w
      ? `Observed between ${w.firstRequestStartedAt} and ${w.lastResponseReceivedAt} as independent requests (not an atomic snapshot).`
      : "No requests completed.",
    `Filters: spread >= ${dec(o.filters.minSpread)}, top-of-book size >= ${dec(o.filters.minTopSize)} shares, ` +
      `suspicious books ${o.filters.includeSuspicious ? "admitted" : "filtered"}; crossed/locked/empty/one-sided books excluded`,
    `Discovery: ${result.discovery.pages} page(s), ${result.discovery.recordsReceived} record(s) received, ${c.discovered} unique, ` +
      `${result.discovery.duplicates.length} duplicate(s); stopped: ${result.discovery.stoppedBecause}` +
      (o.discoverOrder === "volume24hr" ? "; selection order = Gamma volume24hr desc (not used for ranking)" : "; Gamma default order"),
    `Requests: ${result.budget.used} of ${result.budget.limit} budget (${result.requests.length} logged)`,
    "",
  ];

  const shown = result.ranked.slice(0, o.top);
  out.push(`Ranked candidates (showing ${shown.length} of ${c.rankedTotal})`);
  if (shown.length === 0) out.push("  (none)");
  else {
    out.push(
      table(
        ["#", "ID", "REF OUTCOME", "BID", "ASK", "SPREAD", "TOP SIZE", "MID", "QUALITY", "VOL24H*", "QUESTION"],
        shown.map((e, i) => {
          const m = e.metrics!;
          return [
            String(i + 1),
            e.gammaId!,
            truncate(m.reference.label, 16),
            dec(m.bestBid?.price),
            dec(m.bestAsk?.price),
            dec(m.spread),
            dec(m.topSize),
            dec(m.midpoint),
            m.quality,
            e.market!.volume24hr === null ? NONE : e.market!.volume24hr.toFixed(0),
            truncate(e.market!.question, 50),
          ];
        }),
      ),
      "  * Gamma-reported 24h volume: selection order only, not a liquidity measure.",
      "",
      "Why ranked",
    );
    for (const [i, e] of shown.entries()) out.push(`  ${i + 1}. ${e.gammaId}: ${e.explanation.join("; ")}`);
  }

  out.push(
    "",
    `Accounting: discovered ${c.discovered} = ranked ${c.rankedTotal} + filtered ${c.filtered} + excluded ${c.excluded} + failed ${c.failed} + not scanned ${c.notScanned}`,
    `  eligible ${c.eligible}, inspected ${c.selected}`,
  );
  const filtered = bucket("filtered");
  if (filtered.length > 0) out.push("", `Filtered (${filtered.length})`, ...entryLines(filtered, true));
  const excluded = bucket("excluded");
  if (excluded.length > 0) {
    const inspected = excluded.filter((e) => e.selected);
    out.push("", `Excluded (${excluded.length}): ${countByCode(excluded)}`);
    if (inspected.length > 0) out.push("  inspected but structurally unsuitable:", ...entryLines(inspected, true));
  }
  const failed = bucket("failed");
  if (failed.length > 0) out.push("", `Failed (${failed.length})`, ...entryLines(failed, true));
  const notScanned = bucket("notScanned");
  if (notScanned.length > 0) out.push("", `Not scanned (${notScanned.length}): ${countByCode(notScanned)}`);

  const warnings = [...result.ranked.slice(0, o.top), ...filtered].flatMap((e) =>
    e.warnings.filter((x) => x.code !== "BOOK_QUALITY_ISSUE").map((x) => `  ${e.gammaId}  ${x.code}: ${x.detail}`),
  );
  const discoveryWarnings = [
    ...result.discovery.warnings.map((x) => `  ${x}`),
    ...result.discovery.duplicates.map((d) => `  DUPLICATE_RECORD: market ${d.gammaId} repeated on page ${d.page}, counted once`),
  ];
  const all = [...discoveryWarnings, ...warnings];
  out.push("", all.length > 0 ? ["Warnings", ...all.slice(0, MAX_TEXT_ENTRIES)].join("\n") : "Warnings: none");
  return out.join("\n");
}

export function formatError(error: MarketMindError): string {
  const d = error.details;
  const lines = [`error [${error.kind}]: ${error.message}`];
  if (d.url) lines.push(`  url: ${d.url}`);
  if (d.status !== undefined) lines.push(`  http status: ${d.status}`);
  if (d.attempts !== undefined) lines.push(`  attempts: ${d.attempts}`);
  for (const issue of (d.issues ?? []).slice(0, 20)) lines.push(`  - ${issue}`);
  return lines.join("\n");
}

// ---- Stage 2.2: collect / history / runs ----

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function duration(ms: number | null): string {
  if (ms === null) return NONE;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const footprint = (f: { main: number; wal: number; shm: number; total: number }) =>
  `${bytes(f.total)} (main ${bytes(f.main)}, wal ${bytes(f.wal)}, shm ${bytes(f.shm)})`;

export function formatCollect(result: CollectResult): string {
  const out: string[] = [];
  if (result.scan) out.push(formatScan(result.scan), "");
  const p = result.persist;
  const n = (v: number | null) => (v === null ? "unknown" : String(v));
  out.push(
    `Persistence  run ${result.runId}  status=${result.status.toUpperCase()}  accounting=${result.accounting}`,
    `Database: ${result.dbPath}  ${footprint(result.footprintAfter)}; soft admission limit ${bytes(result.maxDbBytes)}`,
    `Accounting: selected ${n(p.selected)} = persisted ${p.persistedObservations} + failures ${p.persistenceFailures}` +
      (p.persistenceFailuresUnrecorded > 0 ? ` + unrecorded failures ${p.persistenceFailuresUnrecorded}` : "") +
      `; not selected ${n(p.notSelected)} of ${n(p.discovered)} discovered (counts only, not stored)`,
    `Books written ${p.booksWritten} (new contents ${p.bookContentsNew}, deduplicated ${p.bookContentsReused}); metrics rows ${p.metricsWritten}`,
  );
  const rec = result.recovery;
  if (rec.recovered.length > 0 || rec.unverified.length > 0) {
    out.push(
      `Recovery: ${rec.recovered.length} abandoned run(s) marked interrupted` +
        (rec.recovered.length > 0 ? ` (${rec.recovered.join(", ")})` : "") +
        (rec.unverified.length > 0 ? `; left running (owner not provably gone): ${rec.unverified.map((u) => `${u.runId} ${u.reason}`).join(", ")}` : ""),
    );
  }
  if (result.failures.length > 0) {
    out.push(`Persistence failures (${result.failures.length})`);
    for (const f of result.failures.slice(0, 25)) {
      out.push(`  ${f.gammaId ?? "(no id)"}  ${f.code}${f.recorded ? "" : " (not recorded in database)"}  ${truncate(f.message, 120)}`);
    }
  }
  if (!result.finalized) out.push("Run not finalized: it stays 'running' until a later collect proves this process is gone.");
  if (result.sizeLimitExceeded) out.push(`Warning: DB_SIZE_LIMIT_EXCEEDED: database is now at or above the soft limit; the next collect will be refused.`);
  return out.join("\n");
}

export function formatHistory(result: HistoryResult): string {
  const { query: q, stats: s, analysisWindow: w } = result;
  const latest = result.rows[0]?.point;
  const reasons = Object.entries(s.notUsable)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const out = [
    `History  market ${q.gammaId}${latest ? `  "${truncate(latest.question, 70)}"` : ""}`,
    `Source ${q.includeSynthetic ? "live+synthetic" : "live"}  analytics v${q.analyticsVersion}  as-of ${q.asOf ?? "(latest)"} (by evidence availability)`,
    `Analysis window: ${w.observations} observation(s), ${w.oldestAvailableAt} .. ${w.newestAvailableAt}` +
      (w.truncated ? `; TRUNCATED to the most recent ${w.maxObservations}` : ""),
    `Samples: eligible ${s.eligible}, usable ${s.usable}${reasons ? ` (not usable: ${reasons})` : ""}`,
    "",
    `Spread (n=${s.spread.n}): current ${dec(s.spread.current)}, previous ${dec(s.spread.previous)}, change ${dec(s.spread.change)}; ` +
      `min ${dec(s.spread.min)}, median ${dec(s.spread.median)}, max ${dec(s.spread.max)}`,
    `Top-of-book size (n=${s.topSize.n}): current ${dec(s.topSize.current)}, previous ${dec(s.topSize.previous)}, change ${dec(s.topSize.change)} shares`,
    `Spread >= ${dec(s.threshold.threshold)} observed in ${s.threshold.atOrAbove} of ${s.threshold.n} samples` +
      (s.threshold.percentOfSamples ? ` (${dec(s.threshold.percentOfSamples)}% of samples, not of time)` : ""),
    `Gaps between usable samples (n=${s.gaps.n}): min ${duration(s.gaps.minMs)}, median ${duration(s.gaps.medianMs)}, max ${duration(s.gaps.maxMs)}; ` +
      `irregular (>2x median) ${s.gaps.irregular}`,
    `Distinct book states (n=${s.states.n}): ${s.states.distinct}`,
    "",
    `Observations (newest first, showing ${result.rows.length} of ${w.observations})`,
    table(
      ["AVAILABLE AT", "RUN", "PAIRING", "BUCKET", "REF", "BID", "ASK", "SPREAD", "TOP SIZE", "QUALITY", "SAME", "GAP", "NOTES"],
      result.rows.map(({ point: p, flags }) => [
        p.availableAt,
        `${p.runId.slice(0, 8)}${p.runStatus === "complete" ? "" : `(${p.runStatus})`}`,
        p.pairing,
        p.bucket,
        p.metrics ? truncate(p.outcomeLabels[p.metrics.referenceIndex] ?? NONE, 14) : NONE,
        dec(p.metrics?.bestBid),
        dec(p.metrics?.bestAsk),
        dec(p.metrics?.spread),
        dec(p.metrics?.topSize),
        p.metrics?.quality ?? (p.books.map((b) => b.quality).join("/") || NONE),
        flags.unchanged === null ? NONE : flags.unchanged ? "yes" : "no",
        duration(flags.gapMs),
        [...(flags.notUsable ? [flags.notUsable] : []), ...flags.changes, ...(p.sourceType === "synthetic" ? ["SYNTHETIC"] : []), ...p.reasonCodes].join(",") ||
          NONE,
      ]),
    ),
    "",
    "Limitations",
    ...result.limitations.map((l) => `  - ${l}`),
  ];
  return out.join("\n");
}

export function formatRuns(result: RunsResult): string {
  const out = [
    `Collection runs in ${result.dbPath} (schema v${result.schemaVersion}; ${footprint(result.footprint)})`,
    "",
  ];
  if (result.runs.length === 0) {
    out.push("(no runs)");
    return out.join("\n");
  }
  const count = (r: (typeof result.runs)[number], k: string) => {
    const v = r.persistCounts?.[k];
    return typeof v === "number" ? String(v) : "?";
  };
  out.push(
    table(
      ["STARTED", "RUN", "STATUS", "ACCOUNTING", "VER", "SELECTED", "PERSISTED", "FAILED", "BOOKS", "REQUESTS", "NOTE"],
      result.runs.map((r) => [
        r.startedAt,
        r.runId.slice(0, 8),
        r.status === "running" ? `running?` : r.status,
        r.accounting,
        r.protocolVersion,
        count(r, "selected"),
        count(r, "persistedObservations"),
        count(r, "persistenceFailures"),
        count(r, "booksWritten"),
        r.budgetUsed === null ? `?/${r.budgetLimit}` : `${r.budgetUsed}/${r.budgetLimit}`,
        r.status === "running"
          ? `owner pid ${r.ownerPid} on ${r.ownerHost}: ${r.owner}; heartbeat ${r.heartbeatAt}`
          : [r.recoveredReason, ...(r.stopReasons ?? []), r.sourceType === "synthetic" ? "SYNTHETIC" : null].filter(Boolean).join(",") || NONE,
      ]),
    ),
  );
  if (result.runs.some((r) => r.accounting === "incomplete")) {
    out.push("", "accounting=incomplete: recovered or inconsistent run; only stored rows are counted, scan totals are unknown (?).");
  }
  return out.join("\n");
}
