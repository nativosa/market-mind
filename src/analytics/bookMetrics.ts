import { half, sum, ZERO, type Decimal } from "../domain/decimal.js";
import type { BookMetrics, BookState, PriceLevel } from "../domain/orderbook.js";

export type Side = "bid" | "ask";

export interface PreparedSide {
  /** Best-first: bids descending, asks ascending. Equal prices aggregated, zero sizes removed. */
  levels: PriceLevel[];
  duplicatePrices: number;
  zeroSizeLevels: number;
  /** Whether the input followed the documented wire order (bids ascending, asks descending). */
  inDocumentedOrder: boolean;
}

/** Normalize one side of a book. Deterministic regardless of input order. */
export function prepareSide(levels: readonly PriceLevel[], side: Side): PreparedSide {
  let inDocumentedOrder = true;
  for (let i = 1; i < levels.length; i++) {
    const cmp = levels[i]!.price.cmp(levels[i - 1]!.price);
    if ((side === "bid" && cmp < 0) || (side === "ask" && cmp > 0)) inDocumentedOrder = false;
  }

  let zeroSizeLevels = 0;
  let duplicatePrices = 0;
  const byPrice = new Map<string, PriceLevel>();
  for (const level of levels) {
    if (level.size.eq(ZERO)) {
      zeroSizeLevels++;
      continue;
    }
    const key = level.price.toFixed();
    const existing = byPrice.get(key);
    if (existing) {
      duplicatePrices++;
      byPrice.set(key, { price: existing.price, size: existing.size.plus(level.size) });
    } else {
      byPrice.set(key, level);
    }
  }

  const sorted = [...byPrice.values()].sort((a, b) => (side === "bid" ? b.price.cmp(a.price) : a.price.cmp(b.price)));
  return { levels: sorted, duplicatePrices, zeroSizeLevels, inDocumentedOrder };
}

/**
 * Metrics over prepared (best-first) sides. No fallbacks: a missing side yields null
 * best price, spread and midpoint rather than zero or a last-trade substitute.
 */
export function computeBookMetrics(
  bids: readonly PriceLevel[],
  asks: readonly PriceLevel[],
  depthBand: Decimal | null,
): BookMetrics {
  const bestBid = bids[0] ?? null;
  const bestAsk = asks[0] ?? null;
  const spread = bestBid && bestAsk ? bestAsk.price.minus(bestBid.price) : null;
  const midpoint = bestBid && bestAsk ? half(bestBid.price.plus(bestAsk.price)) : null;

  const bidDepthWithinBand =
    bestBid && depthBand
      ? sum(bids.filter((l) => l.price.gte(bestBid.price.minus(depthBand))).map((l) => l.size))
      : null;
  const askDepthWithinBand =
    bestAsk && depthBand
      ? sum(asks.filter((l) => l.price.lte(bestAsk.price.plus(depthBand))).map((l) => l.size))
      : null;

  return {
    bestBid,
    bestAsk,
    spread,
    midpoint,
    bidDepth: sum(bids.map((l) => l.size)),
    askDepth: sum(asks.map((l) => l.size)),
    bidDepthWithinBand,
    askDepthWithinBand,
    depthBand,
    levelCounts: { bids: bids.length, asks: asks.length },
    state: bookState(bids.length > 0, asks.length > 0),
    crossed: spread !== null && spread.lt(ZERO),
    locked: spread !== null && spread.eq(ZERO),
  };
}

function bookState(hasBids: boolean, hasAsks: boolean): BookState {
  if (hasBids && hasAsks) return "two-sided";
  if (hasBids) return "bid-only";
  if (hasAsks) return "ask-only";
  return "empty";
}
