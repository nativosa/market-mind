import { decimal, parseDecimal, ZERO, type Decimal } from "../domain/decimal.js";
import type { BookAssessment, BookQuality, OrderBook, PriceLevel, QualityIssue, RawLevel } from "../domain/orderbook.js";
import { computeBookMetrics, prepareSide, type Side } from "./bookMetrics.js";

const ONE = decimal("1");

export interface AssessOptions {
  depthBand: Decimal | null;
  /** The market's condition ID; the book's `market` field must match it (hex case-insensitive). */
  expectedConditionId: string;
}

/**
 * Classify a book and, unless it is invalid, compute its metrics.
 * - invalid:    malformed decimals, prices outside [0, 1], asset_id or condition ID mismatch
 * - suspicious: crossed/locked, off-tick prices, duplicate or zero-size levels, unexpected wire order
 * - incomplete: missing optional metadata (timestamp, hash, tick size, min order size, last trade)
 * - valid:      none of the above; empty and one-sided books are valid
 */
export function assessBook(book: OrderBook, options: AssessOptions): BookAssessment {
  const issues: QualityIssue[] = [];
  const invalid = (code: string, detail: string) => issues.push({ code, category: "invalid", severity: "error", detail });
  const suspicious = (code: string, detail: string) =>
    issues.push({ code, category: "suspicious", severity: "warning", detail });
  const incomplete = (code: string, detail: string) =>
    issues.push({ code, category: "incomplete", severity: "warning", detail });

  if (book.assetId !== book.requestedAssetId) {
    invalid("ASSET_ID_MISMATCH", `requested ${book.requestedAssetId}, received ${book.assetId}`);
  }
  // Condition IDs are 0x-prefixed hex; lowercase is their canonical form.
  if (book.conditionId.toLowerCase() !== options.expectedConditionId.toLowerCase()) {
    invalid("CONDITION_ID_MISMATCH", `expected ${options.expectedConditionId}, received ${book.conditionId}`);
  }
  const bids = parseLevels(book.bids, "bid", invalid);
  const asks = parseLevels(book.asks, "ask", invalid);

  if (issues.length > 0 || bids === null || asks === null) {
    return { quality: "invalid", issues, metrics: null, bids: [], asks: [] };
  }

  const preparedBids = prepareSide(bids, "bid");
  const preparedAsks = prepareSide(asks, "ask");
  for (const [side, prepared] of [["bids", preparedBids], ["asks", preparedAsks]] as const) {
    if (prepared.duplicatePrices > 0) {
      suspicious("DUPLICATE_PRICE_LEVELS", `${prepared.duplicatePrices} duplicate ${side} price level(s) aggregated`);
    }
    if (prepared.zeroSizeLevels > 0) {
      suspicious("ZERO_SIZE_LEVELS", `${prepared.zeroSizeLevels} zero-size ${side} level(s) ignored`);
    }
    if (!prepared.inDocumentedOrder) {
      suspicious("UNEXPECTED_LEVEL_ORDER", `${side} not in documented order; sorted locally`);
    }
  }

  const metrics = computeBookMetrics(preparedBids.levels, preparedAsks.levels, options.depthBand);
  if (metrics.crossed) suspicious("CROSSED_BOOK", "best bid is above best ask");
  if (metrics.locked) suspicious("LOCKED_BOOK", "best bid equals best ask");

  const tickSize = parseDecimal(book.tickSize);
  if (tickSize === null || tickSize.eq(ZERO)) {
    incomplete("MISSING_TICK_SIZE", `tick_size missing or unparseable: ${JSON.stringify(book.tickSize)}`);
  } else {
    const offTick = [...preparedBids.levels, ...preparedAsks.levels].filter((l) => !l.price.mod(tickSize).eq(ZERO));
    if (offTick.length > 0) {
      suspicious("OFF_TICK_PRICE", `${offTick.length} level(s) not on tick size ${tickSize.toFixed()}`);
    }
  }
  if (parseDecimal(book.minOrderSize) === null) {
    incomplete("MISSING_MIN_ORDER_SIZE", `min_order_size missing or unparseable: ${JSON.stringify(book.minOrderSize)}`);
  }
  if (parseDecimal(book.lastTradePrice) === null) {
    incomplete("MISSING_LAST_TRADE_PRICE", `last_trade_price missing or unparseable: ${JSON.stringify(book.lastTradePrice)}`);
  }
  if (!book.hash) incomplete("MISSING_HASH", "hash missing");
  if (book.serverTimestamp.iso === null) {
    incomplete("MISSING_SERVER_TIMESTAMP", `timestamp missing or unparseable: ${JSON.stringify(book.serverTimestamp.raw)}`);
  }

  return {
    quality: classify(issues),
    issues,
    metrics,
    bids: preparedBids.levels,
    asks: preparedAsks.levels,
  };
}

function classify(issues: readonly QualityIssue[]): BookQuality {
  if (issues.some((i) => i.category === "invalid")) return "invalid";
  if (issues.some((i) => i.category === "suspicious")) return "suspicious";
  if (issues.some((i) => i.category === "incomplete")) return "incomplete";
  return "valid";
}

function parseLevels(
  raw: readonly RawLevel[],
  side: Side,
  invalid: (code: string, detail: string) => void,
): PriceLevel[] | null {
  const levels: PriceLevel[] = [];
  let ok = true;
  raw.forEach((level, index) => {
    const price = parseDecimal(level.price);
    const size = parseDecimal(level.size);
    const where = `${side}s[${index}]`;
    if (price === null) {
      invalid("MALFORMED_PRICE", `${where}.price ${JSON.stringify(level.price)}`);
      ok = false;
    } else if (price.gt(ONE)) {
      invalid("PRICE_OUT_OF_RANGE", `${where}.price ${level.price} outside [0, 1]`);
      ok = false;
    }
    if (size === null) {
      invalid("MALFORMED_SIZE", `${where}.size ${JSON.stringify(level.size)}`);
      ok = false;
    }
    if (price !== null && size !== null) levels.push({ price, size });
  });
  return ok ? levels : null;
}
