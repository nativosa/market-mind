import { describe, expect, it } from "vitest";
import { createClobClient } from "../../src/adapters/polymarket/clobClient.js";
import { createGammaClient } from "../../src/adapters/polymarket/gammaClient.js";
import { createHttpClient } from "../../src/adapters/polymarket/httpClient.js";
import { hasInvalidBook, inspectMarket } from "../../src/app/inspectMarket.js";
import { listMarkets } from "../../src/app/listMarkets.js";
import { decimal, decimalToString } from "../../src/domain/decimal.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { fakeFetch, fixture, json, TEST_HTTP_OPTIONS, testDeps, type Reply } from "../helpers.js";
import { V1_NO, V1_ROUTES, V1_YES, V2_A, V2_B, V2_ROUTES } from "../routes.js";

const GAMMA = "https://gamma.example";
const CLOB = "https://clob.example";

function clients(routes: Record<string, Reply | Reply[]>) {
  const fake = fakeFetch(routes);
  const http = createHttpClient(TEST_HTTP_OPTIONS, testDeps(fake.fetch).deps);
  return { gamma: createGammaClient(http, GAMMA), clob: createClobClient(http, CLOB), calls: fake.calls };
}

async function rejection(p: Promise<unknown>): Promise<MarketMindError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MarketMindError);
  return e as MarketMindError;
}

const OPTS = { depthBand: decimal("0.05") };

describe("listMarkets (V1 discovery)", () => {
  it("lists v1 markets, reports malformed records instead of dropping them, and returns the cursor", async () => {
    const c = clients({ "/markets/keyset": json(fixture("gamma/keyset-v1.json")) });
    const result = await listMarkets(c.gamma, { limit: 3, version: "v1" });

    expect(c.calls[0]!.url).toBe(`${GAMMA}/markets/keyset?closed=false&limit=3&version=v1`);
    expect(result.markets.map((m) => [m.market.gammaId, m.eligibility.eligible])).toEqual([
      ["100001", true],
      ["100002", false],
    ]);
    expect(result.markets[1]!.eligibility.reasons).toEqual(["order book is not enabled"]);
    expect(result.skipped).toEqual([{ id: "100003", issues: ["outcomes is not valid JSON", "outcomes: not json"] }]);
    expect(result.nextCursor).toBe("cursor-page-2");
    expect(result.provenance.endpoint).toBe("/markets/keyset");
  });

  it("passes the cursor as after_cursor", async () => {
    const c = clients({ "/markets/keyset": json(fixture("gamma/keyset-v1.json")) });
    await listMarkets(c.gamma, { limit: 5, version: "v1", cursor: "abc=" });
    expect(c.calls[0]!.url).toBe(`${GAMMA}/markets/keyset?closed=false&limit=5&version=v1&after_cursor=abc%3D`);
  });

  it("rejects a malformed envelope", async () => {
    const c = clients({ "/markets/keyset": json({ data: [] }) });
    expect((await rejection(listMarkets(c.gamma, { limit: 1, version: "v1" }))).kind).toBe("Validation");
  });

  it("records a malformed record without an id", async () => {
    const c = clients({ "/markets/keyset": json({ markets: [42], next_cursor: null }) });
    const r = await listMarkets(c.gamma, { limit: 1, version: "v1" });
    expect(r.skipped[0]!.id).toBeNull();
    expect(r.nextCursor).toBeNull();
  });
});

describe("listMarkets (V2 discovery)", () => {
  it("sends version=v2 and returns v2 markets; empty cursor means no next page", async () => {
    const c = clients({ "/markets/keyset": json(fixture("gamma/keyset-v2.json")) });
    const result = await listMarkets(c.gamma, { limit: 2, version: "v2" });
    expect(c.calls[0]!.url).toContain("version=v2");
    expect(result.markets.map((m) => m.market.version)).toEqual(["v2"]);
    expect(result.markets[0]!.eligibility.eligible).toBe(true);
    expect(result.nextCursor).toBeNull();
  });
});

describe("inspectMarket", () => {
  it("V1: inspects a Yes/No market end to end", async () => {
    const c = clients(V1_ROUTES);
    const r = await inspectMarket(c, "100001", OPTS);

    expect(r.association).toEqual({ method: "clob-markets-explicit", gammaIndexCrossCheck: "match" });
    expect(r.outcomes.map((o) => [o.outcome.label, o.outcome.role, o.outcome.assetIdKind, o.assessment.quality])).toEqual([
      ["Yes", "YES", "tokenId", "valid"],
      ["No", "NO", "tokenId", "valid"],
    ]);
    const yes = r.outcomes[0]!.assessment.metrics!;
    expect(decimalToString(yes.bestBid!.price)).toBe("0.036");
    expect(decimalToString(yes.bestAsk!.price)).toBe("0.037");
    expect(decimalToString(yes.midpoint!)).toBe("0.0365");
    expect(hasInvalidBook(r)).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(c.calls.map((x) => x.url)).toEqual([
      `${GAMMA}/markets/100001`,
      `${CLOB}/clob-markets/0x1111111111111111111111111111111111111111111111111111111111111111`,
      `${CLOB}/book?token_id=${V1_YES}`,
      `${CLOB}/book?token_id=${V1_NO}`,
    ]);
  });

  it("V1: each request keeps its own provenance and timing", async () => {
    const r = await inspectMarket(clients(V1_ROUTES), "100001", OPTS);
    expect(r.requests.map((p) => [p.source, p.endpoint])).toEqual([
      ["gamma", "/markets/{id}"],
      ["clob", "/clob-markets/{condition_id}"],
      ["clob", "/book"],
      ["clob", "/book"],
    ]);
    const [yes, no] = r.outcomes;
    expect(yes!.book.provenance.url).toContain(V1_YES);
    expect(no!.book.provenance.url).toContain(V1_NO);
    expect(yes!.book.provenance.timing).not.toEqual(no!.book.provenance.timing);
    expect(yes!.book.serverTimestamp.iso).toBe("2026-10-28T21:05:37.744Z");
    expect(no!.book.serverTimestamp.iso).toBe("2026-10-28T21:05:37.751Z");
    const starts = r.requests.map((p) => p.timing.finalAttemptStartedAt);
    expect(new Set(starts).size).toBe(4);
  });

  it("V2: uses positionIds, team-name outcomes have no YES/NO role, empty book is valid", async () => {
    const c = clients(V2_ROUTES);
    const r = await inspectMarket(c, "200002", OPTS);
    expect(r.outcomes.map((o) => [o.outcome.label, o.outcome.role, o.outcome.assetId, o.outcome.assetIdKind])).toEqual([
      ["Team Alpha", null, V2_A, "positionId"],
      ["Team Beta", null, V2_B, "positionId"],
    ]);
    const alpha = r.outcomes[0]!.assessment;
    expect(alpha.quality).toBe("valid");
    expect(alpha.metrics?.state).toBe("empty");
    expect(alpha.metrics?.midpoint).toBeNull();
    expect(decimalToString(r.outcomes[1]!.assessment.metrics!.midpoint!)).toBe("0.5");
    expect(c.calls.some((x) => x.url.includes(`token_id=${V2_A}`))).toBe(true);
  });

  it("association mismatch aborts before any book is fetched", async () => {
    const c = clients({ ...V1_ROUTES, "/clob-markets/": json({ t: [{ t: V1_YES, o: "No" }, { t: V1_NO, o: "Yes" }] }) });
    const e = await rejection(inspectMarket(c, "100001", OPTS));
    expect(e.kind).toBe("AssociationMismatch");
    expect(c.calls.some((x) => x.url.includes("/book"))).toBe(false);
  });

  it("ineligible markets are rejected with reasons", async () => {
    const c = clients({ "/markets/100001": json({ ...(fixture("gamma/v1-market.json") as object), enableOrderBook: false }) });
    const e = await rejection(inspectMarket(c, "100001", OPTS));
    expect(e.kind).toBe("Ineligible");
    expect(e.details.issues).toEqual(["order book is not enabled"]);
  });

  it("closed markets are inspected with a warning", async () => {
    const c = clients({ ...V1_ROUTES, "/markets/100001": json({ ...(fixture("gamma/v1-market.json") as object), closed: true }) });
    const r = await inspectMarket(c, "100001", OPTS);
    expect(r.warnings).toEqual(["market is closed"]);
  });

  it("an invalid book is returned as invalid with metrics withheld", async () => {
    const bad = { ...(fixture("clob/v1-no-book.json") as object), bids: [{ price: "1e-3", size: "1" }] };
    const r = await inspectMarket(clients({ ...V1_ROUTES, [`token_id=${V1_NO}`]: json(bad) }), "100001", OPTS);
    expect(r.outcomes[1]!.assessment.quality).toBe("invalid");
    expect(r.outcomes[1]!.assessment.metrics).toBeNull();
    expect(hasInvalidBook(r)).toBe(true);
  });

  it("a book reporting a different condition id is invalid, not just a warning", async () => {
    const other = { ...(fixture("clob/v1-no-book.json") as object), market: "0xdead" };
    const r = await inspectMarket(clients({ ...V1_ROUTES, [`token_id=${V1_NO}`]: json(other) }), "100001", OPTS);
    expect(r.warnings).toEqual([]);
    expect(r.outcomes[0]!.assessment.quality).toBe("valid");
    const no = r.outcomes[1]!.assessment;
    expect(no.quality).toBe("invalid");
    expect(no.metrics).toBeNull();
    expect(no.issues.map((i) => i.code)).toEqual(["CONDITION_ID_MISMATCH"]);
    expect(hasInvalidBook(r)).toBe(true);
  });

  it("unknown Gamma id (HTTP 422) maps to NotFound", async () => {
    const c = clients({ "/markets/": json({ type: "validation error", error: "id is invalid" }, 422) });
    const e = await rejection(inspectMarket(c, "999", OPTS));
    expect(e.kind).toBe("NotFound");
    expect(e.details.status).toBe(422);
  });

  it("missing order book (HTTP 404) surfaces as NotFound", async () => {
    const c = clients({ ...V1_ROUTES, [`token_id=${V1_NO}`]: json({ error: "No orderbook exists for the requested token id" }, 404) });
    const e = await rejection(inspectMarket(c, "100001", OPTS));
    expect(e.kind).toBe("NotFound");
    expect(e.message).toContain("No orderbook exists");
  });

  it("malformed book body is a Validation error", async () => {
    const c = clients({ ...V1_ROUTES, [`token_id=${V1_NO}`]: json({ market: "x", asset_id: V1_NO, bids: "none", asks: [] }) });
    expect((await rejection(inspectMarket(c, "100001", OPTS))).kind).toBe("Validation");
  });

  it("other Gamma errors propagate unchanged", async () => {
    const c = clients({ "/markets/": json({}, 400) });
    expect((await rejection(inspectMarket(c, "1", OPTS))).kind).toBe("HttpStatus");
  });
});
