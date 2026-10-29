import { describe, expect, it } from "vitest";
import { checkComplement, computeScanMetrics, evaluateCandidate, worstQuality } from "../../src/analytics/scanMetrics.js";
import { compareCandidates, compareIntegerStrings, rankCandidates } from "../../src/analytics/ranking.js";
import { decimal, decimalToString, type Decimal } from "../../src/domain/decimal.js";
import { scanEligibility, type ScanFilters } from "../../src/domain/scan.js";
import { toMarket } from "../../src/adapters/polymarket/normalize.js";
import { gammaRecord, observation, pair, provenance, type BookSpec } from "../scanFixtures.js";
import { GammaMarketSchema } from "../../src/adapters/polymarket/gammaSchemas.js";

const normalizeEligibilityFixture = (overrides: Record<string, unknown>) =>
  toMarket(GammaMarketSchema.parse({ ...gammaRecord({ id: "1" }), ...overrides }), provenance());

const FILTERS: ScanFilters = { minSpread: decimal("0"), minTopSize: decimal("10"), includeSuspicious: false };
const s = (d: Decimal | null) => (d === null ? null : decimalToString(d));

function evaluate(ref: BookSpec, other?: BookSpec, filters: ScanFilters = FILTERS, endDate: string | null = null) {
  const [a, b] = pair(ref, other);
  const metrics = computeScanMetrics(a, b);
  return { metrics, ...evaluateCandidate(a, b, metrics, filters, endDate) };
}

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);
const warningCodes = (r: { warnings: { code: string }[] }) => r.warnings.map((x) => x.code);

describe("computeScanMetrics", () => {
  it("takes prices and sizes from the reference outcome only", () => {
    const r = evaluate({ bids: [["0.40", "120"], ["0.39", "500"]], asks: [["0.46", "80"], ["0.50", "1000"]] });
    const m = r.metrics;
    expect(m.reference).toMatchObject({ index: 0, label: "Yes" });
    expect([s(m.bestBid!.price), s(m.bestAsk!.price), s(m.spread), s(m.midpoint)]).toEqual(["0.4", "0.46", "0.06", "0.43"]);
    // Top size is the smaller best-level size, not total displayed depth.
    expect(s(m.topSize)).toBe("80");
    expect(s(m.topNotional)).toBe("36.8"); // min(0.40*120=48, 0.46*80=36.8)
    expect([s(m.bidDepth), s(m.askDepth)]).toEqual(["620", "1080"]);
    expect([s(m.bidDepthWithinBand), s(m.askDepthWithinBand)]).toEqual(["620", "1080"]);
    expect(m.levelCounts).toEqual({ bids: 2, asks: 2 });
    expect(m.quality).toBe("valid");
    expect(m.pairSkewMs).toBe(0);
  });

  it("has null top size and spread for one-sided books", () => {
    const m = evaluate({ bids: [["0.4", "100"]], asks: [] }).metrics;
    expect([m.spread, m.topSize, m.topNotional, m.midpoint]).toEqual([null, null, null, null]);
    expect(m.state).toBe("bid-only");
  });

  it("measures the observation skew between the two separately fetched books", () => {
    const a = observation(0, { bids: [["0.4", "1"]], asks: [["0.5", "1"]] }, { receivedAt: "2026-10-28T21:05:12.000Z" });
    const b = observation(1, { bids: [["0.5", "1"]], asks: [["0.6", "1"]] }, { receivedAt: "2026-10-28T21:05:19.500Z" });
    expect(computeScanMetrics(a, b).pairSkewMs).toBe(7_500);
    expect(computeScanMetrics(b, a).pairSkewMs).toBe(7_500);
  });

  it("worstQuality orders valid < incomplete < suspicious < invalid", () => {
    expect(worstQuality("valid", "incomplete")).toBe("incomplete");
    expect(worstQuality("suspicious", "incomplete")).toBe("suspicious");
    expect(worstQuality("invalid", "valid")).toBe("invalid");
  });
});

describe("checkComplement (advisory)", () => {
  it("accepts an exact complement", () => {
    const [a, b] = pair({ bids: [["0.4", "100"]], asks: [["0.45", "100"]] });
    expect(checkComplement(a, b)).toEqual([]);
  });

  it("reports price and size mismatches and one-sided asymmetry", () => {
    const [a, b] = pair({ bids: [["0.4", "100"]], asks: [["0.45", "100"]] }, { bids: [["0.55", "90"]], asks: [] });
    expect(checkComplement(a, b)).toEqual([
      "Yes best bid / No best ask: present on one outcome only",
      "Yes best ask / No best bid: sizes 100 vs 90",
    ]);
    const [c, d] = pair({ bids: [["0.4", "100"]], asks: [["0.45", "100"]] }, { bids: [["0.50", "100"]], asks: [["0.60", "100"]] });
    expect(checkComplement(c, d)).toEqual(["Yes best ask / No best bid: prices sum to 0.95"]);
  });

  it("is skipped when a book is invalid", () => {
    const [a, b] = pair({ bids: [["0.4", "1"]], asks: [["0.5", "1"]] }, { bids: [["1.5", "1"]], asks: [] });
    expect(checkComplement(a, b)).toEqual([]);
  });

  it("never changes the bucket", () => {
    const r = evaluate({ bids: [["0.4", "100"]], asks: [["0.45", "100"]] }, { bids: [["0.5", "100"]], asks: [["0.7", "100"]] });
    expect(r.bucket).toBe("ranked");
    expect(warningCodes(r)).toContain("COMPLEMENT_MISMATCH");
  });
});

describe("evaluateCandidate", () => {
  it("ranks a clean two-sided market with a factual explanation", () => {
    const r = evaluate({ bids: [["0.40", "120"]], asks: [["0.46", "80"]] });
    expect(r.bucket).toBe("ranked");
    expect(r.reasons).toEqual([]);
    expect(r.explanation).toEqual([
      'reference outcome "Yes" (index 0)',
      "spread 0.06 >= min 0",
      "top-of-book size 80 shares >= min 10",
      "book quality valid",
    ]);
  });

  it.each<[string, BookSpec, string[]]>([
    ["empty", { bids: [], asks: [] }, ["EMPTY_BOOK"]],
    ["bid-only", { bids: [["0.4", "100"]], asks: [] }, ["ONE_SIDED_BOOK"]],
    ["ask-only", { bids: [], asks: [["0.4", "100"]] }, ["ONE_SIDED_BOOK"]],
  ])("excludes %s reference books", (_name, book, expected) => {
    const r = evaluate(book);
    expect(r.bucket).toBe("excluded");
    expect(codes(r)).toEqual(expected);
    expect(r.explanation).toEqual([]);
  });

  it("excludes crossed and locked books even when suspicious books are admitted", () => {
    const crossed = evaluate({ bids: [["0.5", "100"]], asks: [["0.4", "100"]] }, undefined, { ...FILTERS, includeSuspicious: true });
    expect(crossed.bucket).toBe("excluded");
    expect(codes(crossed)).toEqual(["CROSSED_BOOK", "CROSSED_BOOK", "SPREAD_BELOW_MIN"]); // negative spread
    const locked = evaluate({ bids: [["0.5", "100"]], asks: [["0.5", "100"]] });
    expect(locked.bucket).toBe("excluded");
    expect(codes(locked)).toContain("LOCKED_BOOK");
    // Suspicious is also collected (as a filter reason) but excluded wins.
    expect(codes(locked)).toContain("SUSPICIOUS_BOOK");
  });

  it("fails a market whose other outcome book is invalid, collecting every reason", () => {
    const r = evaluate({ bids: [["0.4", "5"]], asks: [["0.45", "5"]] }, { bids: [["abc", "1"]], asks: [] });
    expect(r.bucket).toBe("failed");
    expect(codes(r)).toEqual(["INVALID_BOOK", "TOP_SIZE_BELOW_MIN"]);
    expect(r.reasons[0]!.detail).toBe("No: MALFORMED_PRICE");
  });

  it("filters suspicious books by policy and admits them with a warning when asked", () => {
    const offTick: BookSpec = { bids: [["0.4005", "100"]], asks: [["0.45", "100"]] };
    const filtered = evaluate(offTick);
    expect(filtered.bucket).toBe("filtered");
    expect(codes(filtered)).toEqual(["SUSPICIOUS_BOOK"]);
    const admitted = evaluate(offTick, undefined, { ...FILTERS, includeSuspicious: true });
    expect(admitted.bucket).toBe("ranked");
    expect(warningCodes(admitted)).toContain("SUSPICIOUS_BOOK_ADMITTED");
    expect(admitted.explanation.at(-1)).toBe("book quality suspicious");
  });

  it("applies min spread and min top size, reporting both", () => {
    const r = evaluate({ bids: [["0.40", "5"]], asks: [["0.41", "500"]] }, undefined, { ...FILTERS, minSpread: decimal("0.05") });
    expect(r.bucket).toBe("filtered");
    expect(r.reasons).toEqual([
      { code: "SPREAD_BELOW_MIN", detail: "spread 0.01 < min 0.05" },
      { code: "TOP_SIZE_BELOW_MIN", detail: "top size 5 shares < min 10" },
    ]);
  });

  it("filters a wide spread with negligible size instead of ranking it", () => {
    const r = evaluate({ bids: [["0.10", "1"]], asks: [["0.90", "1"]] });
    expect(r.bucket).toBe("filtered");
    expect(codes(r)).toEqual(["TOP_SIZE_BELOW_MIN"]);
  });

  it("thresholds are inclusive", () => {
    const r = evaluate({ bids: [["0.40", "10"]], asks: [["0.45", "10"]] }, undefined, { ...FILTERS, minSpread: decimal("0.05") });
    expect(r.bucket).toBe("ranked");
  });

  it("warns on extreme prices, past end dates and large pair skew", () => {
    const low = evaluate({ bids: [["0.001", "1000"]], asks: [["0.003", "1000"]] }, undefined, FILTERS, "2026-10-01T00:00:00Z");
    expect(low.bucket).toBe("ranked");
    expect(warningCodes(low)).toEqual(expect.arrayContaining(["EXTREME_PRICE", "END_DATE_PASSED"]));
    const high = evaluate({ bids: [["0.97", "1000"]], asks: [["0.98", "1000"]] }, undefined, FILTERS, "not a date");
    expect(warningCodes(high)).toContain("EXTREME_PRICE");
    expect(warningCodes(high)).not.toContain("END_DATE_PASSED");
    const future = evaluate(DEFAULT, undefined, FILTERS, "2030-01-01T00:00:00Z");
    expect(warningCodes(future)).toEqual([]);

    const a = observation(0, DEFAULT, { receivedAt: "2026-10-28T21:05:12.000Z" });
    const b = observation(1, { bids: [["0.55", "100"]], asks: [["0.6", "100"]] }, { receivedAt: "2026-10-28T21:05:20.000Z" });
    const skew = evaluateCandidate(a, b, computeScanMetrics(a, b), FILTERS, null);
    expect(warningCodes(skew)).toContain("PAIR_OBSERVATION_SKEW");
  });

  it("lists other book-quality issues as warnings without changing the bucket", () => {
    const r = evaluate({ bids: [["0.4", "100"]], asks: [["0.45", "100"]], raw: { hash: null } });
    expect(r.bucket).toBe("ranked");
    expect(r.metrics.quality).toBe("incomplete");
    expect(r.warnings).toEqual([{ code: "BOOK_QUALITY_ISSUE", detail: "Yes: [incomplete] MISSING_HASH: hash missing" }]);
  });

  it("works with non-YES/NO labels", () => {
    const [a, b] = pair(DEFAULT, undefined, ["Team Alpha", "Team Beta"]);
    const r = evaluateCandidate(a, b, computeScanMetrics(a, b), FILTERS, null);
    expect(r.explanation[0]).toBe('reference outcome "Team Alpha" (index 0)');
  });
});

const DEFAULT: BookSpec = { bids: [["0.40", "100"]], asks: [["0.45", "100"]] };

describe("ranking", () => {
  const c = (gammaId: string, spread: string | null, topSize: string | null) => ({
    gammaId,
    spread: spread === null ? null : decimal(spread),
    topSize: topSize === null ? null : decimal(topSize),
  });

  it("orders by spread desc, then top size desc, then id asc (numeric)", () => {
    const items = [c("100", "0.05", "10"), c("99", "0.05", "10"), c("7", "0.05", "50"), c("3", "0.10", "1"), c("5", "0.01", "999")];
    expect(rankCandidates(items, (x) => x).map((x) => x.gammaId)).toEqual(["3", "7", "99", "100", "5"]);
  });

  it("is independent of input order", () => {
    const items = [c("1", "0.02", "5"), c("2", "0.02", "5"), c("3", "0.03", "1"), c("4", "0.02", "6"), c("10", "0.02", "5")];
    const expected = ["3", "4", "1", "2", "10"];
    for (let shift = 0; shift < items.length; shift++) {
      const rotated = [...items.slice(shift), ...items.slice(0, shift)];
      expect(rankCandidates(rotated, (x) => x).map((x) => x.gammaId)).toEqual(expected);
      expect(rankCandidates([...rotated].reverse(), (x) => x).map((x) => x.gammaId)).toEqual(expected);
    }
  });

  it("sorts null metrics last", () => {
    expect(compareCandidates(c("1", null, "1"), c("2", "0.01", "1"))).toBeGreaterThan(0);
    expect(compareCandidates(c("1", "0.01", null), c("2", "0.01", "1"))).toBeGreaterThan(0);
    expect(compareCandidates(c("1", null, null), c("2", null, null))).toBeLessThan(0);
  });

  it("compareIntegerStrings", () => {
    expect(compareIntegerStrings("99", "100")).toBeLessThan(0);
    expect(compareIntegerStrings("0100", "99")).toBeGreaterThan(0);
    expect(compareIntegerStrings("5", "5")).toBe(0);
    expect(compareIntegerStrings("007", "7")).toBeLessThan(0); // equal value: plain string tie-break keeps it total
    expect(compareIntegerStrings("b", "a")).toBeGreaterThan(0);
    expect(compareIntegerStrings("12", "1a")).toBeLessThan(0);
  });
});

describe("scanEligibility", () => {
  it("accepts an open, tradable binary market", () => {
    expect(scanEligibility(normalizeEligibilityFixture({}))).toEqual({ bucket: "eligible", reasons: [] });
  });

  it.each<[Record<string, unknown>, string, string[]]>([
    [{ outcomes: '["A","B","C"]', clobTokenIds: '["1","2","3"]' }, "excluded", ["NOT_BINARY"]],
    [{ enableOrderBook: false }, "excluded", ["ORDER_BOOK_DISABLED"]],
    [{ enableOrderBook: null }, "excluded", ["STATUS_UNKNOWN"]],
    [{ active: false, closed: true }, "excluded", ["NOT_ACTIVE", "CLOSED"]],
    [{ acceptingOrders: false }, "excluded", ["NOT_ACCEPTING_ORDERS"]],
    [{ acceptingOrders: null }, "excluded", ["STATUS_UNKNOWN"]],
    [{ clobTokenIds: null }, "failed", ["MALFORMED_MARKET"]],
    [{ clobTokenIds: '["1"]' }, "failed", ["MALFORMED_MARKET"]],
    [{ clobTokenIds: '["1","1"]', acceptingOrders: false }, "failed", ["MALFORMED_MARKET", "NOT_ACCEPTING_ORDERS"]],
  ])("%j -> %s %j", (overrides, bucket, expected) => {
    const e = scanEligibility(normalizeEligibilityFixture(overrides));
    expect(e.bucket).toBe(bucket);
    expect(e.reasons.map((r) => r.code)).toEqual(expected);
  });

  it("v2 markets use positionIds", () => {
    expect(scanEligibility(normalizeEligibilityFixture({ version: "v2", clobTokenIds: null, positionIds: ["a", "b"] })).bucket).toBe(
      "eligible",
    );
    expect(scanEligibility(normalizeEligibilityFixture({ version: "v2", positionIds: null })).reasons[0]!.detail).toBe(
      "no positionIds for v2 market",
    );
  });
});
