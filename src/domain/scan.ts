import type { Decimal } from "./decimal.js";
import { assetIdsFor, isBinary, type Market, type Outcome } from "./market.js";
import type { BookAssessment, BookQuality, BookState, OrderBook, PriceLevel } from "./orderbook.js";

/** Every discovered market lands in exactly one bucket. */
export type Bucket = "ranked" | "filtered" | "excluded" | "failed" | "notScanned";

/** API errors, malformed data and data-integrity failures. */
export type FailedCode =
  | "MALFORMED_RECORD"
  | "MALFORMED_MARKET"
  | "ASSOCIATION_MISMATCH"
  | "INVALID_BOOK"
  | "VALIDATION"
  | "HTTP_TIMEOUT"
  | "HTTP_NETWORK"
  | "HTTP_RATE_LIMITED"
  | "HTTP_UPSTREAM_5XX"
  | "HTTP_STATUS"
  | "HTTP_NOT_FOUND";

/** Ineligible markets and structurally unsuitable books. */
export type ExcludedCode =
  | "NOT_BINARY"
  | "ORDER_BOOK_DISABLED"
  | "NOT_ACTIVE"
  | "CLOSED"
  | "NOT_ACCEPTING_ORDERS"
  | "STATUS_UNKNOWN"
  | "EMPTY_BOOK"
  | "ONE_SIDED_BOOK"
  | "CROSSED_BOOK"
  | "LOCKED_BOOK";

/** User-defined filters and nonfatal quality policies. */
export type FilteredCode = "SUSPICIOUS_BOOK" | "SPREAD_BELOW_MIN" | "TOP_SIZE_BELOW_MIN";

/** Not inspected: an expected sampling limit, or incomplete execution. */
export type NotScannedCode = "SAMPLE_LIMIT" | ExecutionStopCode;
export type ExecutionStopCode = "BUDGET_EXHAUSTED" | "DEADLINE" | "CANCELLED" | "RATE_LIMITED";

export type ReasonCode = FailedCode | ExcludedCode | FilteredCode | NotScannedCode;

export type WarningCode =
  | "COMPLEMENT_MISMATCH"
  | "PAIR_OBSERVATION_SKEW"
  | "EXTREME_PRICE"
  | "END_DATE_PASSED"
  | "SUSPICIOUS_BOOK_ADMITTED"
  | "BOOK_QUALITY_ISSUE";

export interface Reason<C extends string = ReasonCode> {
  code: C;
  detail: string;
}

export type ScanWarning = Reason<WarningCode>;

export interface ScanFilters {
  minSpread: Decimal;
  /** Minimum of best bid size and best ask size of the reference outcome, in shares. */
  minTopSize: Decimal;
  includeSuspicious: boolean;
}

/** One outcome's book as observed by its own request. */
export interface OutcomeObservation {
  outcome: Outcome;
  book: OrderBook;
  assessment: BookAssessment;
}

export interface ReferenceOutcome {
  index: number;
  label: string;
  assetId: string;
}

/** Market-level metrics. Prices and sizes come from the reference outcome's book only. */
export interface ScanMetrics {
  reference: ReferenceOutcome;
  bestBid: PriceLevel | null;
  bestAsk: PriceLevel | null;
  spread: Decimal | null;
  midpoint: Decimal | null;
  /** min(best bid size, best ask size), shares. Null unless the book is two-sided. */
  topSize: Decimal | null;
  /** min(best bid price x size, best ask price x size). Display only: not invariant under complement. */
  topNotional: Decimal | null;
  bidDepthWithinBand: Decimal | null;
  askDepthWithinBand: Decimal | null;
  depthBand: Decimal | null;
  /** Total displayed depth per side. Not available at the best price. */
  bidDepth: Decimal | null;
  askDepth: Decimal | null;
  levelCounts: { bids: number; asks: number } | null;
  state: BookState | null;
  /** Worst quality across both outcome books. */
  quality: BookQuality;
  /** |received(outcome 0) - received(outcome 1)| in ms: the two books are separate observations. */
  pairSkewMs: number;
}

export interface CandidateEvaluation {
  bucket: Exclude<Bucket, "notScanned">;
  /** Every applicable reason, from all categories; the bucket is the first category hit. */
  reasons: Reason[];
  warnings: ScanWarning[];
  /** Factual statements for ranked candidates (never return or trade claims). */
  explanation: string[];
}

export interface ScanEligibility {
  bucket: "eligible" | "excluded" | "failed";
  reasons: Reason[];
}

/**
 * Metadata-only classification, before any CLOB request. Missing trading-status flags exclude the
 * market rather than being assumed true. Bad asset IDs on a binary market are an integrity failure.
 */
export function scanEligibility(market: Market): ScanEligibility {
  const failed: Reason[] = [];
  const excluded: Reason[] = [];

  if (!isBinary(market)) {
    excluded.push({ code: "NOT_BINARY", detail: `${market.outcomeLabels.length} outcomes` });
  } else {
    const { ids, kind } = assetIdsFor(market);
    const field = kind === "tokenId" ? "clobTokenIds" : "positionIds";
    if (ids === null) failed.push({ code: "MALFORMED_MARKET", detail: `no ${field} for ${market.version} market` });
    else if (ids.length !== 2) failed.push({ code: "MALFORMED_MARKET", detail: `expected 2 ${field}, found ${ids.length}` });
    else if (ids[0] === ids[1]) failed.push({ code: "MALFORMED_MARKET", detail: `${field} are not unique` });
  }

  if (market.enableOrderBook === null) excluded.push({ code: "STATUS_UNKNOWN", detail: "enableOrderBook is missing" });
  else if (!market.enableOrderBook) excluded.push({ code: "ORDER_BOOK_DISABLED", detail: "order book is not enabled" });
  if (!market.active) excluded.push({ code: "NOT_ACTIVE", detail: "market is not active" });
  if (market.closed) excluded.push({ code: "CLOSED", detail: "market is closed" });
  if (market.acceptingOrders === null) excluded.push({ code: "STATUS_UNKNOWN", detail: "acceptingOrders is missing" });
  else if (!market.acceptingOrders) excluded.push({ code: "NOT_ACCEPTING_ORDERS", detail: "market is not accepting orders" });

  const reasons = [...failed, ...excluded];
  if (failed.length > 0) return { bucket: "failed", reasons };
  if (excluded.length > 0) return { bucket: "excluded", reasons };
  return { bucket: "eligible", reasons };
}
