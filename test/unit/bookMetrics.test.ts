import { describe, expect, it } from "vitest";
import { computeBookMetrics, prepareSide } from "../../src/analytics/bookMetrics.js";
import { decimal, decimalToString } from "../../src/domain/decimal.js";
import type { PriceLevel } from "../../src/domain/orderbook.js";

const lv = (price: string, size: string): PriceLevel => ({ price: decimal(price), size: decimal(size) });
const s = (d: { toFixed(): string } | null | undefined) => (d == null ? null : decimalToString(d as never));

// Documented wire order: bids ascending, asks descending.
const BIDS = [lv("0.001", "10198713.84"), lv("0.02", "1500"), lv("0.035", "250.5"), lv("0.036", "117.97")];
const ASKS = [lv("0.999", "2179008.73"), lv("0.5", "100"), lv("0.04", "900.1"), lv("0.037", "3500.66")];

function metricsFor(bids: PriceLevel[], asks: PriceLevel[], band: string | null = "0.05") {
  return computeBookMetrics(prepareSide(bids, "bid").levels, prepareSide(asks, "ask").levels, band ? decimal(band) : null);
}

describe("prepareSide", () => {
  it("sorts bids descending and asks ascending (best first)", () => {
    expect(prepareSide(BIDS, "bid").levels.map((l) => s(l.price))).toEqual(["0.036", "0.035", "0.02", "0.001"]);
    expect(prepareSide(ASKS, "ask").levels.map((l) => s(l.price))).toEqual(["0.037", "0.04", "0.5", "0.999"]);
  });

  it("detects documented vs unexpected wire order", () => {
    expect(prepareSide(BIDS, "bid").inDocumentedOrder).toBe(true);
    expect(prepareSide(ASKS, "ask").inDocumentedOrder).toBe(true);
    expect(prepareSide([...BIDS].reverse(), "bid").inDocumentedOrder).toBe(false);
    expect(prepareSide([...ASKS].reverse(), "ask").inDocumentedOrder).toBe(false);
  });

  it("aggregates duplicate prices across different scales and drops zero sizes", () => {
    const side = prepareSide([lv("0.5", "1"), lv("0.50", "2.5"), lv("0.4", "0"), lv("0.3", "1")], "bid");
    expect(side.duplicatePrices).toBe(1);
    expect(side.zeroSizeLevels).toBe(1);
    expect(side.levels.map((l) => [s(l.price), s(l.size)])).toEqual([
      ["0.5", "3.5"],
      ["0.3", "1"],
    ]);
  });
});

describe("computeBookMetrics", () => {
  it("computes best prices, spread, midpoint and depth exactly", () => {
    const m = metricsFor(BIDS, ASKS);
    expect(s(m.bestBid?.price)).toBe("0.036");
    expect(s(m.bestAsk?.price)).toBe("0.037");
    expect(s(m.spread)).toBe("0.001");
    expect(s(m.midpoint)).toBe("0.0365");
    expect(s(m.bidDepth)).toBe("10200582.31");
    expect(s(m.askDepth)).toBe("2183509.49");
    expect(s(m.bidDepthWithinBand)).toBe("10200582.31");
    expect(s(m.askDepthWithinBand)).toBe("4400.76");
    expect(m.levelCounts).toEqual({ bids: 4, asks: 4 });
    expect(m.state).toBe("two-sided");
    expect(m.crossed).toBe(false);
    expect(m.locked).toBe(false);
  });

  it("is independent of input order (shuffled and reversed books)", () => {
    const shuffled = metricsFor([BIDS[2]!, BIDS[0]!, BIDS[3]!, BIDS[1]!], [ASKS[1]!, ASKS[3]!, ASKS[0]!, ASKS[2]!]);
    const reversed = metricsFor([...BIDS].reverse(), [...ASKS].reverse());
    const reference = metricsFor(BIDS, ASKS);
    for (const m of [shuffled, reversed]) {
      expect(s(m.bestBid?.price)).toBe(s(reference.bestBid?.price));
      expect(s(m.bestAsk?.price)).toBe(s(reference.bestAsk?.price));
      expect(s(m.midpoint)).toBe(s(reference.midpoint));
      expect(s(m.bidDepth)).toBe(s(reference.bidDepth));
      expect(s(m.askDepthWithinBand)).toBe(s(reference.askDepthWithinBand));
    }
  });

  it("returns nulls, not zeros, for an empty book", () => {
    const m = metricsFor([], []);
    expect(m.state).toBe("empty");
    expect(m.bestBid).toBeNull();
    expect(m.bestAsk).toBeNull();
    expect(m.spread).toBeNull();
    expect(m.midpoint).toBeNull();
    expect(m.bidDepthWithinBand).toBeNull();
    expect(m.askDepthWithinBand).toBeNull();
    expect(s(m.bidDepth)).toBe("0");
    expect(m.crossed).toBe(false);
  });

  it("handles one-sided books", () => {
    const bidOnly = metricsFor([lv("0.4", "10")], []);
    expect(bidOnly.state).toBe("bid-only");
    expect(s(bidOnly.bestBid?.price)).toBe("0.4");
    expect(bidOnly.spread).toBeNull();
    expect(bidOnly.midpoint).toBeNull();

    const askOnly = metricsFor([], [lv("0.6", "10")]);
    expect(askOnly.state).toBe("ask-only");
    expect(s(askOnly.bestAsk?.price)).toBe("0.6");
    expect(askOnly.midpoint).toBeNull();
  });

  it("reports crossed and locked books without hiding them", () => {
    const crossed = metricsFor([lv("0.6", "1")], [lv("0.5", "1")]);
    expect(crossed.crossed).toBe(true);
    expect(s(crossed.spread)).toBe("-0.1");
    expect(s(crossed.midpoint)).toBe("0.55");

    const locked = metricsFor([lv("0.5", "1")], [lv("0.5", "1")]);
    expect(locked.locked).toBe(true);
    expect(locked.crossed).toBe(false);
    expect(s(locked.spread)).toBe("0");
  });

  it("omits band depth when no band is requested", () => {
    const m = metricsFor(BIDS, ASKS, null);
    expect(m.depthBand).toBeNull();
    expect(m.bidDepthWithinBand).toBeNull();
    expect(m.askDepthWithinBand).toBeNull();
  });

  it("keeps precision with mixed tick scales", () => {
    const m = metricsFor([lv("0.01", "1"), lv("0.015", "2")], [lv("0.02", "3"), lv("0.0205", "4")]);
    expect(s(m.spread)).toBe("0.005");
    expect(s(m.midpoint)).toBe("0.0175");
  });
});
