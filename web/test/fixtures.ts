import { readFileSync } from "node:fs";
import { InspectOutput, MarketsOutput, WebErrorOutput, WebStatusOutput } from "../../src/research/contracts";
import type { ApiClient, ApiResult, Inspection, MarketItem, Markets, Status, Version } from "../src/api";

// Fixture-backed API responses for the explorer tests. Every page is parsed with the server's own
// MarketsOutput contract, so a fixture can never drift from what the API may send.

export const NOW = Date.parse("2026-11-02T12:00:00.000Z");

export function item(id: string, overrides: Partial<MarketItem> = {}): MarketItem {
  return {
    gammaId: id,
    conditionId: `0x${id.padStart(64, "c")}`,
    protocolVersion: "v1",
    question: `Synthetic market ${id}?`,
    slug: `synthetic-market-${id}`,
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    negRisk: false,
    endDate: "2026-12-31T00:00:00Z",
    gammaVolume24hr: "1000",
    eligibility: { inspectable: true, reasons: [], warnings: [] },
    ...overrides,
  };
}

export interface PageOptions {
  version?: Version;
  cursor?: string | null;
  nextCursor?: string | null;
  stoppedReason?: "LAST_PAGE" | "CURSOR_UNSUPPORTED" | null;
  skipped?: number;
  used?: number;
}

export function page(items: MarketItem[], o: PageOptions = {}): Markets {
  const version = o.version ?? "v1";
  const nextCursor = o.nextCursor ?? null;
  const used = o.used ?? 1;
  return MarketsOutput.parse({
    contract: "marketmind.web.list_markets/1",
    appVersion: "0.9.0",
    generatedAt: new Date(NOW).toISOString(),
    source: "live",
    status: items.length === 0 ? "empty" : "ok",
    untrustedTextFields: ["markets.items[].question"],
    limitations: ["fixture"],
    volumeNote: "not liquidity",
    appliedLimits: { version, order: "volume24hr", pageSize: 50, maxAttempts: 2, deadlineMs: 10_000 },
    query: { cursor: o.cursor ?? null },
    markets: { returnedCount: items.length, items: items.map((m) => ({ ...m, protocolVersion: version })) },
    skipped: { returnedCount: 0, totalCount: o.skipped ?? 0, truncated: (o.skipped ?? 0) > 0, items: [] },
    pagination: { nextCursor, stoppedReason: o.stoppedReason !== undefined ? o.stoppedReason : nextCursor === null ? "LAST_PAGE" : null },
    request: {
      source: "gamma",
      endpoint: "/markets/keyset",
      url: "https://gamma.example/markets/keyset",
      httpStatus: 200,
      attempts: 1,
      firstAttemptStartedAt: null,
      responseReceivedAt: null,
      durationMs: null,
    },
    budget: { call: { limit: 2, used: 1 }, process: { limit: 2_000, used, remaining: 2_000 - used }, window: { limit: 60, windowMs: 300_000, used, remaining: 60 - used } },
  });
}

export const range = (from: number, count: number, overrides: Partial<MarketItem> = {}) => Array.from({ length: count }, (_, i) => item(String(from + i), overrides));

export const status: Status = WebStatusOutput.parse({
  contract: "marketmind.web.status/1",
  appVersion: "0.9.0",
  generatedAt: new Date(NOW).toISOString(),
  readOnly: true,
  limits: { list: { pageSize: 50, maxAttempts: 2, deadlineMs: 10_000 }, inspect: { maxAttempts: 8, deadlineMs: 20_000, levels: { default: 5, max: 20 } }, rateLimitCooldownMs: 60_000 },
  budget: { process: { limit: 2_000, used: 0, remaining: 2_000 }, window: { limit: 60, windowMs: 300_000, used: 0, remaining: 60 } },
  rateLimit: { coolingDown: false, retryAfterMs: 0 },
  live: { enabled: true },
  stored: { defaultSource: "live", database: "missing" },
});

export function serverError(category: string, code: string | null, details: Record<string, unknown> = {}, retryable = true) {
  return WebErrorOutput.parse({ contract: "marketmind.web.error/1", error: { category, code, message: "fixture", retryable, details } });
}

/** A JSON Response, as the server would send it. */
export const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** The explorer never reads stored data: an explorer test double fails loudly if it does. */
export const NO_STORED_READS: Pick<ApiClient, "storedMarkets" | "storedRuns" | "history" | "observation"> = {
  storedMarkets: () => Promise.reject(new Error("unexpected stored read")),
  storedRuns: () => Promise.reject(new Error("unexpected stored read")),
  history: () => Promise.reject(new Error("unexpected stored read")),
  observation: () => Promise.reject(new Error("unexpected stored read")),
};

/** An ApiClient whose markets() and inspect() answers are queued per call; records every query. */
export function scriptedApi(replies: ApiResult<Markets>[], statusReply: ApiResult<Status> = { ok: true, data: status, receivedAt: NOW }, inspectReplies: ApiResult<Inspection>[] = []) {
  const queries: { version: Version; cursor: string | null }[] = [];
  const inspections: { marketId: string; levels: number | undefined }[] = [];
  const api: ApiClient = {
    ...NO_STORED_READS,
    status: () => Promise.resolve(statusReply),
    markets: ({ version, cursor }) => {
      queries.push({ version, cursor: cursor ?? null });
      const next = replies.shift();
      return next ? Promise.resolve(next) : new Promise(() => undefined);
    },
    inspect: (marketId, { levels }) => {
      inspections.push({ marketId, levels });
      const next = inspectReplies.shift();
      return next ? Promise.resolve(next) : new Promise(() => undefined);
    },
  };
  return { api, queries, inspections };
}

// ---- inspections: the MCP golden results (the same contract the web route returns) ----

const golden = (name: string): Inspection =>
  InspectOutput.parse((JSON.parse(readFileSync(new URL(`../../test/fixtures/mcp-golden/${name}.json`, import.meta.url), "utf8")) as { structuredContent: unknown }).structuredContent);

/** V1 Yes/No market 100001: two valid two-sided books. */
export const INSPECT_V1 = golden("inspect-v1");
/** V2 market 200002 with team-name outcomes (no Yes/No role): one empty book, one two-sided. */
export const INSPECT_V2 = golden("inspect-v2");
/** V1 market whose No book is invalid (metrics withheld). */
export const INSPECT_INVALID = golden("inspect-invalid-book");

type Outcome = Inspection["outcomes"][number];

/** A copy of `base` with one outcome changed, re-validated against the contract. */
export function withOutcome(base: Inspection, index: number, patch: (o: Outcome) => Outcome, top: Partial<Inspection> = {}): Inspection {
  return InspectOutput.parse({ ...base, ...top, outcomes: base.outcomes.map((o, i) => (i === index ? patch(o) : o)) });
}

/** The inspection of market `id` (the golden V1 result relabelled). */
export const inspectionOf = (id: string, base: Inspection = INSPECT_V1): Inspection => InspectOutput.parse({ ...base, market: { ...base.market, gammaId: id } });

/** `count` levels per side, best first: bids falling and asks rising from the given cents. */
export function deepLevels(count: number, bidFrom = 50, askFrom = 51): Outcome["levels"] {
  const level = (cents: number, i: number) => ({ price: `0.${String(cents).padStart(2, "0")}`, size: `${(i + 1) * 100}.5` });
  return {
    order: "aggregated_best_first",
    bids: Array.from({ length: count }, (_, i) => level(bidFrom - i, i)),
    asks: Array.from({ length: count }, (_, i) => level(askFrom + i, i)),
    totalBids: count + 3,
    totalAsks: count + 3,
    returnedPerSide: count,
    truncated: true,
  };
}

export const inspected = (data: Inspection, receivedAt = NOW): ApiResult<Inspection> => ({ ok: true, data, receivedAt });
