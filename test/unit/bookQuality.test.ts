import { describe, expect, it } from "vitest";
import { assessBook } from "../../src/analytics/bookQuality.js";
import { decimal, decimalToString } from "../../src/domain/decimal.js";
import type { OrderBook, RawLevel } from "../../src/domain/orderbook.js";

const ASSET = "71321045679252212594626385532706912750332728571942532289631379312455583992563";

function book(overrides: Partial<OrderBook> = {}): OrderBook {
  return {
    requestedAssetId: ASSET,
    assetId: ASSET,
    conditionId: "0x11",
    bids: [
      { price: "0.35", size: "10" },
      { price: "0.4", size: "20" },
    ],
    asks: [
      { price: "0.6", size: "5" },
      { price: "0.45", size: "15" },
    ],
    tickSize: "0.01",
    minOrderSize: "5",
    lastTradePrice: "0.42",
    negRisk: false,
    hash: "abc123",
    serverTimestamp: { raw: "1793221537744", epochMs: 1793221537744, iso: "2026-10-28T21:05:37.744Z" },
    provenance: {
      source: "clob",
      endpoint: "/book",
      url: `https://clob.example/book?token_id=${ASSET}`,
      httpStatus: 200,
      timing: {
        firstAttemptStartedAt: "2026-10-28T21:05:12.000Z",
        finalAttemptStartedAt: "2026-10-28T21:05:12.000Z",
        responseReceivedAt: "2026-10-28T21:05:12.010Z",
        durationMs: 10,
        attempts: 1,
        serverDateHeader: null,
      },
    },
    ...overrides,
  };
}

const assess = (b: OrderBook) => assessBook(b, { depthBand: decimal("0.05"), expectedConditionId: "0x11" });
const codes = (b: OrderBook) => assess(b).issues.map((i) => i.code);

describe("assessBook classification", () => {
  it("valid: well-formed two-sided book", () => {
    const a = assess(book());
    expect(a.quality).toBe("valid");
    expect(a.issues).toEqual([]);
    expect(decimalToString(a.metrics!.midpoint!)).toBe("0.425");
  });

  it("valid: empty book is valid, metrics present with nulls", () => {
    const a = assess(book({ bids: [], asks: [] }));
    expect(a.quality).toBe("valid");
    expect(a.metrics?.state).toBe("empty");
    expect(a.metrics?.midpoint).toBeNull();
  });

  it("valid: one-sided book", () => {
    expect(assess(book({ asks: [] })).quality).toBe("valid");
  });

  it.each([
    ["hash", { hash: null }, "MISSING_HASH"],
    ["tick size", { tickSize: null }, "MISSING_TICK_SIZE"],
    ["zero tick size", { tickSize: "0" }, "MISSING_TICK_SIZE"],
    ["min order size", { minOrderSize: null }, "MISSING_MIN_ORDER_SIZE"],
    ["last trade price", { lastTradePrice: "" }, "MISSING_LAST_TRADE_PRICE"],
    ["server timestamp", { serverTimestamp: { raw: "soon", epochMs: null, iso: null } }, "MISSING_SERVER_TIMESTAMP"],
  ] as const)("incomplete: missing %s", (_name, overrides, code) => {
    const a = assess(book(overrides));
    expect(a.quality).toBe("incomplete");
    expect(a.issues.map((i) => i.code)).toEqual([code]);
    expect(a.metrics).not.toBeNull();
  });

  it("suspicious: crossed book warns and still reports metrics", () => {
    const a = assess(book({ bids: [{ price: "0.5", size: "1" }], asks: [{ price: "0.45", size: "1" }] }));
    expect(a.quality).toBe("suspicious");
    expect(a.issues).toContainEqual(expect.objectContaining({ code: "CROSSED_BOOK", severity: "warning" }));
    expect(a.metrics?.crossed).toBe(true);
  });

  it("suspicious: locked book", () => {
    expect(codes(book({ bids: [{ price: "0.5", size: "1" }], asks: [{ price: "0.5", size: "1" }] }))).toContain("LOCKED_BOOK");
  });

  it("suspicious: off-tick price", () => {
    expect(codes(book({ bids: [{ price: "0.405", size: "1" }] }))).toContain("OFF_TICK_PRICE");
  });

  it("suspicious: duplicate and zero-size levels", () => {
    const c = codes(book({ bids: [{ price: "0.4", size: "1" }, { price: "0.40", size: "2" }, { price: "0.3", size: "0" }].reverse() }));
    expect(c).toContain("DUPLICATE_PRICE_LEVELS");
    expect(c).toContain("ZERO_SIZE_LEVELS");
  });

  it("suspicious: levels not in documented order, but metrics unaffected", () => {
    const reversed = book({ bids: [...book().bids].reverse(), asks: [...book().asks].reverse() });
    const a = assess(reversed);
    expect(a.quality).toBe("suspicious");
    expect(a.issues.map((i) => i.code)).toEqual(["UNEXPECTED_LEVEL_ORDER", "UNEXPECTED_LEVEL_ORDER"]);
    expect(decimalToString(a.metrics!.bestBid!.price)).toBe("0.4");
    expect(decimalToString(a.metrics!.bestAsk!.price)).toBe("0.45");
  });

  it("suspicious outranks incomplete", () => {
    expect(assess(book({ hash: null, bids: [{ price: "0.405", size: "1" }] })).quality).toBe("suspicious");
  });

  it.each<[string, RawLevel, string]>([
    ["exponent price", { price: "1e-3", size: "1" }, "MALFORMED_PRICE"],
    ["negative size", { price: "0.4", size: "-1" }, "MALFORMED_SIZE"],
    ["empty price", { price: "", size: "1" }, "MALFORMED_PRICE"],
    ["price above 1", { price: "1.5", size: "1" }, "PRICE_OUT_OF_RANGE"],
  ])("invalid: %s", (_name, level, code) => {
    const a = assess(book({ bids: [level] }));
    expect(a.quality).toBe("invalid");
    expect(a.metrics).toBeNull();
    expect(a.bids).toEqual([]);
    expect(a.issues).toContainEqual(expect.objectContaining({ code, severity: "error", category: "invalid" }));
  });

  it("invalid: asset_id differs from the requested asset", () => {
    const a = assess(book({ assetId: "999" }));
    expect(a.quality).toBe("invalid");
    expect(a.issues[0]?.code).toBe("ASSET_ID_MISMATCH");
  });

  it("invalid: book condition ID differs from the market's", () => {
    const a = assess(book({ conditionId: "0x12" }));
    expect(a.quality).toBe("invalid");
    expect(a.metrics).toBeNull();
    expect(a.issues).toEqual([
      { code: "CONDITION_ID_MISMATCH", category: "invalid", severity: "error", detail: "expected 0x11, received 0x12" },
    ]);
  });

  it("condition ID comparison ignores hex letter case", () => {
    const b = book({ conditionId: "0xAB" });
    expect(assessBook(b, { depthBand: null, expectedConditionId: "0xab" }).quality).toBe("valid");
  });

  it("price exactly 0 and 1 are within range", () => {
    expect(assess(book({ bids: [{ price: "0", size: "1" }], asks: [{ price: "1", size: "1" }] })).quality).toBe("valid");
  });
});
