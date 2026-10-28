import { describe, expect, it } from "vitest";
import { ClobBookSchema, ClobMarketInfoSchema } from "../../src/adapters/polymarket/clobSchemas.js";
import { GammaMarketSchema } from "../../src/adapters/polymarket/gammaSchemas.js";
import {
  associateOutcomes,
  parseJsonStringArray,
  parseServerTimestamp,
  parseVersion,
  selectOutcomes,
  toMarket,
  toOrderBook,
  validate,
} from "../../src/adapters/polymarket/normalize.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { inspectEligibility, type Market } from "../../src/domain/market.js";
import type { Provenance } from "../../src/domain/provenance.js";
import { fixture } from "../helpers.js";

const PROV: Provenance = {
  source: "gamma",
  endpoint: "/markets/{id}",
  url: "https://gamma.example/markets/1",
  httpStatus: 200,
  timing: {
    firstAttemptStartedAt: "2026-10-28T21:05:12.000Z",
    finalAttemptStartedAt: "2026-10-28T21:05:12.000Z",
    responseReceivedAt: "2026-10-28T21:05:12.010Z",
    durationMs: 10,
    attempts: 1,
    serverDateHeader: null,
  },
};

const V1_YES = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const V1_NO = "52114319501245915516055106046884209969926127482827954674443846427813813222426";
const V2_A = "600000000000000000000000000000000000000000000000000000000000000000000000168";
const V2_B = "600000000000000000000000000000000000000000000000000000000000000000000000169";

const raw = (path: string, overrides: Record<string, unknown> = {}) =>
  validate(GammaMarketSchema, { ...(fixture(path) as object), ...overrides }, "Gamma market");
const market = (path: string, overrides: Record<string, unknown> = {}): Market => toMarket(raw(path, overrides), PROV);

function thrown(fn: () => unknown): MarketMindError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MarketMindError);
    return e as MarketMindError;
  }
  throw new Error("expected an error");
}

describe("V1 (CTF) normalization", () => {
  it("parses JSON-encoded fields and preserves identifiers verbatim", () => {
    const m = market("gamma/v1-market.json");
    expect(m.version).toBe("v1");
    expect(m.gammaId).toBe("100001");
    expect(m.outcomeLabels).toEqual(["Yes", "No"]);
    expect(m.clobTokenIds).toEqual([V1_YES, V1_NO]);
    expect(m.positionIds?.[0]).toBe("900000000000000000000000000000000000000000000000000000000000000000000000001");
    expect(m.provenance).toBe(PROV);
  });

  it("selects clobTokenIds as asset IDs even though positionIds differ", () => {
    const outcomes = selectOutcomes(market("gamma/v1-market.json"));
    expect(outcomes.map((o) => [o.label, o.role, o.assetId, o.assetIdKind])).toEqual([
      ["Yes", "YES", V1_YES, "tokenId"],
      ["No", "NO", V1_NO, "tokenId"],
    ]);
    expect(outcomes[0]!.raw.positionId).toBe("900000000000000000000000000000000000000000000000000000000000000000000000001");
  });

  it("rejects a v1 market without clobTokenIds", () => {
    expect(thrown(() => selectOutcomes(market("gamma/v1-market.json", { clobTokenIds: null }))).kind).toBe("Validation");
    expect(inspectEligibility(market("gamma/v1-market.json", { clobTokenIds: null })).reasons).toContain(
      "no clobTokenIds for v1 market",
    );
  });
});

describe("V2 (Protocol V2) normalization", () => {
  it("selects positionIds and labels them as positionId", () => {
    const outcomes = selectOutcomes(market("gamma/v2-market.json"));
    expect(outcomes.map((o) => [o.label, o.role, o.assetId, o.assetIdKind])).toEqual([
      ["Team Alpha", null, V2_A, "positionId"],
      ["Team Beta", null, V2_B, "positionId"],
    ]);
  });

  it("uses positionIds even when clobTokenIds is null", () => {
    const outcomes = selectOutcomes(market("gamma/v2-market.json", { clobTokenIds: null }));
    expect(outcomes[1]!.assetId).toBe(V2_B);
    expect(outcomes[1]!.raw.clobTokenId).toBeNull();
  });

  it("rejects a v2 market without positionIds", () => {
    const m = market("gamma/v2-market.json", { positionIds: null });
    expect(thrown(() => selectOutcomes(m)).message).toContain("no positionIds");
  });
});

describe("malformed Gamma data", () => {
  it.each([
    ["outcomes not JSON", { outcomes: "Yes,No" }, "not valid JSON"],
    ["outcomes not an array", { outcomes: '{"a":1}' }, "not a JSON array"],
    ["outcomes with numbers", { outcomes: "[1, 2]" }, "not a JSON array"],
    ["outcomes missing", { outcomes: null }, "has no outcomes"],
    ["clobTokenIds not JSON", { clobTokenIds: "[oops" }, "clobTokenIds is not valid JSON"],
    ["unknown version", { version: "v3" }, "Unknown protocol version"],
  ])("%s", (_name, overrides, message) => {
    const error = thrown(() => market("gamma/v1-market.json", overrides));
    expect(error.kind).toBe("Validation");
    expect(error.message).toContain(message);
  });

  it("schema failure lists issues", () => {
    const error = thrown(() => validate(GammaMarketSchema, { id: 5 }, "Gamma market", PROV));
    expect(error.kind).toBe("Validation");
    expect(error.details.url).toBe(PROV.url);
    expect(error.details.issues?.some((i) => i.startsWith("id:"))).toBe(true);
  });

  it("outcome / asset ID count mismatch", () => {
    const m = market("gamma/v1-market.json", { clobTokenIds: `["${V1_YES}"]` });
    expect(thrown(() => selectOutcomes(m)).message).toContain("2 outcomes but 1 asset IDs");
  });

  it("duplicate asset IDs", () => {
    const m = market("gamma/v1-market.json", { clobTokenIds: `["${V1_YES}", "${V1_YES}"]` });
    expect(thrown(() => selectOutcomes(m)).message).toContain("duplicate");
  });

  it("parseJsonStringArray passes null through and parseVersion validates", () => {
    expect(parseJsonStringArray(null, "x")).toBeNull();
    expect(parseJsonStringArray(undefined, "x")).toBeNull();
    expect(parseVersion("v2")).toBe("v2");
  });
});

describe("eligibility", () => {
  it("eligible binary market with no warnings", () => {
    expect(inspectEligibility(market("gamma/v1-market.json"))).toEqual({ eligible: true, reasons: [], warnings: [] });
  });

  it("ineligible reasons and warnings are explicit, never defaulted", () => {
    const e = inspectEligibility(
      market("gamma/v1-market.json", {
        enableOrderBook: null,
        acceptingOrders: null,
        closed: true,
        active: false,
        outcomes: '["A","B","C"]',
      }),
    );
    expect(e.eligible).toBe(false);
    expect(e.reasons).toEqual(["enableOrderBook is missing", "expected 2 outcomes, found 3"]);
    expect(e.warnings).toEqual(["market is closed", "market is not active", "acceptingOrders is missing"]);
  });

  it("book disabled / not accepting orders / non-unique IDs", () => {
    const e = inspectEligibility(
      market("gamma/v1-market.json", { enableOrderBook: false, acceptingOrders: false, clobTokenIds: '["1","1"]' }),
    );
    expect(e.reasons).toEqual(["order book is not enabled", "asset IDs are not unique"]);
    expect(e.warnings).toEqual(["market is not accepting orders"]);
    expect(inspectEligibility(market("gamma/v1-market.json", { clobTokenIds: '["1","2","3"]' })).reasons).toEqual([
      "expected 2 asset IDs, found 3",
    ]);
  });
});

describe("outcome association (YES/NO)", () => {
  const v1Info = () => validate(ClobMarketInfoSchema, fixture("clob/v1-market-info.json"), "info");

  it("confirms matching explicit pairing", () => {
    const outcomes = selectOutcomes(market("gamma/v1-market.json"));
    expect(associateOutcomes(outcomes, v1Info())).toEqual({ method: "clob-markets-explicit", gammaIndexCrossCheck: "match" });
  });

  it("associates by ID, not by position, when the CLOB lists tokens in another order", () => {
    const info = v1Info();
    info.t.reverse();
    expect(associateOutcomes(selectOutcomes(market("gamma/v1-market.json")), info).gammaIndexCrossCheck).toBe("match");
  });

  it("v2 team-name pairing", () => {
    const info = validate(ClobMarketInfoSchema, fixture("clob/v2-market-info.json"), "info");
    expect(associateOutcomes(selectOutcomes(market("gamma/v2-market.json")), info).method).toBe("clob-markets-explicit");
  });

  it("fails when Gamma index order disagrees with CLOB labels (swapped YES/NO)", () => {
    const swapped = market("gamma/v1-market.json", { outcomes: '["No", "Yes"]' });
    const error = thrown(() => associateOutcomes(selectOutcomes(swapped), v1Info()));
    expect(error.kind).toBe("AssociationMismatch");
    expect(error.details.issues).toHaveLength(2);
  });

  it("fails when the CLOB does not list a selected asset", () => {
    const info = { t: [{ t: V1_YES, o: "Yes" }] };
    const error = thrown(() => associateOutcomes(selectOutcomes(market("gamma/v1-market.json")), info));
    expect(error.details.issues).toEqual([`asset ${V1_NO} (No) not listed by CLOB`]);
  });

  it("fails on duplicate or unexpected CLOB tokens", () => {
    const outcomes = selectOutcomes(market("gamma/v1-market.json"));
    const dup = { t: [{ t: V1_YES, o: "Yes" }, { t: V1_YES, o: "Yes" }, { t: V1_NO, o: "No" }] };
    expect(thrown(() => associateOutcomes(outcomes, dup)).details.issues).toEqual([`asset ${V1_YES} listed 2 times by CLOB`]);
    const extra = { t: [{ t: V1_YES, o: "Yes" }, { t: V1_NO, o: "No" }, { t: "123", o: "Maybe" }] };
    expect(thrown(() => associateOutcomes(outcomes, extra)).details.issues).toEqual(["CLOB lists unexpected asset 123"]);
  });

  it("fails when a v1 market is wrongly paired using positionIds", () => {
    const info = { t: [{ t: "900000000000000000000000000000000000000000000000000000000000000000000000001", o: "Yes" }] };
    expect(thrown(() => associateOutcomes(selectOutcomes(market("gamma/v1-market.json")), info)).kind).toBe(
      "AssociationMismatch",
    );
  });
});

describe("server timestamps and books", () => {
  it.each([
    ["1793221537744", { epochMs: 1793221537744, iso: "2026-10-28T21:05:37.744Z" }],
    ["0", { epochMs: 0, iso: "1970-01-01T00:00:00.000Z" }],
  ])("parses %s", (input, expected) => {
    expect(parseServerTimestamp(input)).toEqual({ raw: input, ...expected });
  });

  it.each(["", "abc", "1.5", "-1", "9".repeat(16)])("does not guess for %j", (input) => {
    expect(parseServerTimestamp(input)).toEqual({ raw: input, epochMs: null, iso: null });
  });

  it("missing timestamp is all-null", () => {
    expect(parseServerTimestamp(undefined)).toEqual({ raw: null, epochMs: null, iso: null });
  });

  it("normalizes a book, keeping requested vs received asset IDs and raw strings", () => {
    const rawBook = validate(ClobBookSchema, fixture("clob/v1-yes-book.json"), "book");
    const b = toOrderBook(rawBook, V1_YES, { ...PROV, source: "clob", endpoint: "/book" });
    expect(b.assetId).toBe(V1_YES);
    expect(b.requestedAssetId).toBe(V1_YES);
    expect(b.bids[3]).toEqual({ price: "0.036", size: "117.97" });
    expect(b.serverTimestamp.iso).toBe("2026-10-28T21:05:37.744Z");
    expect(b.provenance.endpoint).toBe("/book");
  });

  it("book without optional metadata normalizes to nulls", () => {
    const rawBook = validate(ClobBookSchema, { market: "m", asset_id: "a", bids: [], asks: [] }, "book");
    const b = toOrderBook(rawBook, "a", PROV);
    expect([b.tickSize, b.minOrderSize, b.lastTradePrice, b.hash, b.negRisk]).toEqual([null, null, null, null, null]);
  });

  it.each([
    ["numeric price", { price: 0.5, size: "1" }],
    ["missing size", { price: "0.5" }],
  ])("book schema rejects %s", (_name, level) => {
    const body = { ...(fixture("clob/v1-yes-book.json") as object), bids: [level] };
    expect(thrown(() => validate(ClobBookSchema, body, "book")).kind).toBe("Validation");
  });

  it("book schema rejects missing asks", () => {
    const { asks: _asks, ...body } = fixture("clob/v1-yes-book.json") as Record<string, unknown>;
    expect(thrown(() => validate(ClobBookSchema, body, "book")).details.issues?.[0]).toContain("asks");
  });
});
