import type { InspectResult } from "../app/inspectMarket.js";
import type { ListMarketsResult } from "../app/listMarkets.js";
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
