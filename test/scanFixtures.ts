import { toOrderBook } from "../src/adapters/polymarket/normalize.js";
import { assessBook } from "../src/analytics/bookQuality.js";
import { decimal, decimalToString } from "../src/domain/decimal.js";
import type { Outcome, ProtocolVersion } from "../src/domain/market.js";
import type { Provenance } from "../src/domain/provenance.js";
import type { OutcomeObservation } from "../src/domain/scan.js";
import { json, type Reply } from "./helpers.js";

// Synthetic scan scenarios. Every id is derived from the market id with a fixed width, so no
// asset id or condition id is a substring of another (fakeFetch routes match by substring).

export type Level = [price: string, size: string];

export interface BookSpec {
  bids: Level[];
  asks: Level[];
  /** Overrides for the raw /book body (e.g. tick_size, market, asset_id). */
  raw?: Record<string, unknown>;
}

export interface MarketSpec {
  id: string;
  version?: ProtocolVersion;
  labels?: [string, string] | string[];
  volume24hr?: number | null;
  /** Reference (outcome 0) book. Outcome 1 is its exact complement unless `other` is given. */
  book?: BookSpec;
  other?: BookSpec;
  /** Overrides for the raw Gamma record. */
  gamma?: Record<string, unknown>;
  /** Replies replacing the default for this market's requests. */
  replies?: { association?: Reply | Reply[]; book0?: Reply | Reply[]; book1?: Reply | Reply[] };
}

const pad = (id: string) => id.padStart(12, "0");
export const conditionId = (id: string) => `0x${pad(id).padStart(64, "c")}`;
export const assetId = (id: string, index: number) => `7${pad(id)}${index}${"5".repeat(60)}`;

export function gammaRecord(spec: MarketSpec): Record<string, unknown> {
  const version = spec.version ?? "v1";
  const labels = spec.labels ?? ["Yes", "No"];
  const ids = labels.map((_, i) => assetId(spec.id, i));
  return {
    id: spec.id,
    question: `Synthetic market ${spec.id}?`,
    conditionId: conditionId(spec.id),
    slug: `synthetic-${spec.id}`,
    version,
    outcomes: JSON.stringify(labels),
    clobTokenIds: version === "v1" ? JSON.stringify(ids) : null,
    positionIds: version === "v2" ? ids : null,
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    negRisk: false,
    endDate: null,
    volume24hr: spec.volume24hr === undefined ? 1000 : spec.volume24hr,
    ...spec.gamma,
  };
}

const complement = (p: string) => decimalToString(decimal("1").minus(decimal(p)));

/** Exact complement: bid p of size s on one outcome = ask 1-p of size s on the other. */
export function mirror(book: BookSpec): BookSpec {
  return {
    bids: book.asks.map(([p, s]) => [complement(p), s]),
    asks: book.bids.map(([p, s]) => [complement(p), s]),
  };
}

/** Raw /book body in documented wire order (bids ascending, asks descending). */
export function bookBody(spec: MarketSpec, index: number, book: BookSpec): Record<string, unknown> {
  const bids = [...book.bids].sort((a, b) => decimal(a[0]).cmp(decimal(b[0])));
  const asks = [...book.asks].sort((a, b) => decimal(b[0]).cmp(decimal(a[0])));
  return {
    market: conditionId(spec.id),
    asset_id: assetId(spec.id, index),
    timestamp: "1793221537744",
    hash: `hash${spec.id}${index}`,
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    min_order_size: "5",
    tick_size: "0.001",
    neg_risk: false,
    last_trade_price: "0.5",
    ...book.raw,
  };
}

export const DEFAULT_BOOK: BookSpec = { bids: [["0.40", "100"]], asks: [["0.45", "100"]] };

/** Fake routes for a keyset discovery (one or more pages) plus association and books per market. */
export function scanRoutes(pages: MarketSpec[][], extra: { keyset?: Reply | Reply[] } = {}): Record<string, Reply | Reply[]> {
  const routes: Record<string, Reply | Reply[]> = {};
  // Cursor-specific pages first: fakeFetch takes the first substring match.
  pages.forEach((markets, i) => {
    if (i === 0) return;
    routes[`after_cursor=cursor-${i + 1}`] = json({
      markets: markets.map(gammaRecord),
      next_cursor: i + 1 < pages.length ? `cursor-${i + 2}` : null,
    });
  });
  routes["/markets/keyset"] =
    extra.keyset ?? json({ markets: (pages[0] ?? []).map(gammaRecord), next_cursor: pages.length > 1 ? "cursor-2" : null });
  for (const spec of pages.flat()) {
    const labels = spec.labels ?? ["Yes", "No"];
    const ref = spec.book ?? DEFAULT_BOOK;
    const other = spec.other ?? mirror(ref);
    routes[`/clob-markets/${conditionId(spec.id)}`] =
      spec.replies?.association ?? json({ t: labels.map((o, i) => ({ t: assetId(spec.id, i), o })) });
    routes[`token_id=${assetId(spec.id, 0)}`] = spec.replies?.book0 ?? json(bookBody(spec, 0, ref));
    routes[`token_id=${assetId(spec.id, 1)}`] = spec.replies?.book1 ?? json(bookBody(spec, 1, other));
  }
  return routes;
}

// ---- Direct observations for analytics tests ----

export function provenance(receivedAt = "2026-10-28T21:05:12.010Z"): Provenance {
  return {
    source: "clob",
    endpoint: "/book",
    url: "https://clob.example/book",
    httpStatus: 200,
    timing: {
      firstAttemptStartedAt: "2026-10-28T21:05:12.000Z",
      finalAttemptStartedAt: "2026-10-28T21:05:12.000Z",
      responseReceivedAt: receivedAt,
      durationMs: 10,
      attempts: 1,
      serverDateHeader: null,
    },
  };
}

export function observation(
  index: number,
  book: BookSpec,
  options: { label?: string; receivedAt?: string; id?: string; depthBand?: string | null; kind?: "tokenId" | "positionId" } = {},
): OutcomeObservation {
  const id = options.id ?? "1";
  const label = options.label ?? (index === 0 ? "Yes" : "No");
  const outcome: Outcome = {
    index,
    label,
    role: null,
    assetId: assetId(id, index),
    assetIdKind: options.kind ?? "tokenId",
    raw: options.kind === "positionId" ? { clobTokenId: null, positionId: assetId(id, index) } : { clobTokenId: assetId(id, index), positionId: null },
  };
  const body = bookBody({ id }, index, book);
  const ob = toOrderBook(
    {
      market: body.market as string,
      asset_id: body.asset_id as string,
      timestamp: body.timestamp as string | null,
      hash: body.hash as string | null,
      bids: body.bids as { price: string; size: string }[],
      asks: body.asks as { price: string; size: string }[],
      min_order_size: body.min_order_size as string | null,
      tick_size: body.tick_size as string | null,
      neg_risk: false,
      last_trade_price: body.last_trade_price as string | null,
    },
    assetId(id, index),
    provenance(options.receivedAt),
  );
  const band = options.depthBand === undefined ? "0.05" : options.depthBand;
  return {
    outcome,
    book: ob,
    assessment: assessBook(ob, { depthBand: band === null ? null : decimal(band), expectedConditionId: conditionId(id) }),
  };
}

/** Reference observation plus its exact complement (or an explicit other book). */
export function pair(ref: BookSpec, other?: BookSpec, labels: [string, string] = ["Yes", "No"]) {
  return [observation(0, ref, { label: labels[0] }), observation(1, other ?? mirror(ref), { label: labels[1] })] as const;
}
