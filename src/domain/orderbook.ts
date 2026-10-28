import type { Decimal } from "./decimal.js";
import type { Provenance, ServerTimestamp } from "./provenance.js";

/** Level exactly as received; strings are validated later by the quality assessment. */
export interface RawLevel {
  price: string;
  size: string;
}

/** Normalized CLOB order book. Levels keep their original wire order and string form. */
export interface OrderBook {
  requestedAssetId: string;
  assetId: string;
  conditionId: string;
  bids: RawLevel[];
  asks: RawLevel[];
  tickSize: string | null;
  minOrderSize: string | null;
  lastTradePrice: string | null;
  negRisk: boolean | null;
  hash: string | null;
  serverTimestamp: ServerTimestamp;
  provenance: Provenance;
}

export interface PriceLevel {
  price: Decimal;
  size: Decimal;
}

export type BookState = "two-sided" | "bid-only" | "ask-only" | "empty";

export interface BookMetrics {
  bestBid: PriceLevel | null;
  bestAsk: PriceLevel | null;
  /** bestAsk - bestBid; negative when crossed. */
  spread: Decimal | null;
  midpoint: Decimal | null;
  /** Sum of sizes (shares) per side. */
  bidDepth: Decimal;
  askDepth: Decimal;
  /** Sum of sizes within `depthBand` of the best price on that side. */
  bidDepthWithinBand: Decimal | null;
  askDepthWithinBand: Decimal | null;
  depthBand: Decimal | null;
  levelCounts: { bids: number; asks: number };
  state: BookState;
  crossed: boolean;
  locked: boolean;
}

export type BookQuality = "valid" | "incomplete" | "suspicious" | "invalid";

export interface QualityIssue {
  code: string;
  category: Exclude<BookQuality, "valid">;
  severity: "warning" | "error";
  detail: string;
}

export interface BookAssessment {
  quality: BookQuality;
  issues: QualityIssue[];
  /** Null if and only if the book is invalid. */
  metrics: BookMetrics | null;
  /** Aggregated, zero-size-free levels: bids best-first (desc), asks best-first (asc). Empty when invalid. */
  bids: PriceLevel[];
  asks: PriceLevel[];
}
