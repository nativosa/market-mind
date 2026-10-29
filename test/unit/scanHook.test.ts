import { describe, expect, it } from "vitest";
import { scanMarkets, type ScanEntry, type ScanOptions, type SettledMarket } from "../../src/app/scanMarkets.js";
import { scanJson } from "../../src/cli/jsonView.js";
import { decimal } from "../../src/domain/decimal.js";
import { fakeFetch, json, TEST_HTTP_OPTIONS, testDeps, type Reply } from "../helpers.js";
import { assetId, scanRoutes, type MarketSpec } from "../scanFixtures.js";

const OPTIONS: ScanOptions = {
  version: "v1",
  discoverOrder: "volume24hr",
  maxMarkets: 3,
  top: 10,
  pageSize: 50,
  maxPages: 2,
  filters: { minSpread: decimal("0"), minTopSize: decimal("10"), includeSuspicious: false },
  depthBand: decimal("0.05"),
  maxRequests: 48,
  concurrency: 1,
  maxDurationMs: 60_000,
};

async function scan(routes: Record<string, Reply | Reply[]>, onSettled?: (s: SettledMarket) => void, overrides: Partial<ScanOptions> = {}) {
  const fake = fakeFetch(routes);
  return scanMarkets(
    { ...OPTIONS, ...overrides },
    {
      http: testDeps(fake.fetch, () => new Date("2026-10-28T21:05:12.000Z")).deps,
      httpOptions: TEST_HTTP_OPTIONS,
      gammaBaseUrl: "https://gamma.example",
      clobBaseUrl: "https://clob.example",
      ...(onSettled ? { onSettled } : {}),
    },
  );
}

const MARKETS: MarketSpec[] = [
  { id: "11" },
  { id: "12", replies: { association: json({ t: [{ t: assetId("12", 0), o: "No" }, { t: assetId("12", 1), o: "Yes" }] }) } },
  { id: "13", replies: { book1: json({ error: "boom" }, 500) } },
  { id: "14", replies: { association: json({ error: "down" }, 500) } },
  { id: "15", gamma: { acceptingOrders: false } },
  { id: "16" },
];

describe("scanMarkets onSettled hook", () => {
  it("is called exactly once per selected market with its final bucket, never for unselected ones", async () => {
    const settled: SettledMarket[] = [];
    const result = await scan(scanRoutes([MARKETS]), (s) => settled.push(s), { maxMarkets: 4 });
    expect(settled.map((s) => [s.entry.gammaId, s.entry.bucket])).toEqual([
      ["11", "ranked"],
      ["12", "failed"],
      ["13", "failed"],
      ["14", "failed"],
    ]);
    expect(result.entries.filter((e) => !e.selected).map((e) => e.gammaId)).toEqual(["15", "16"]);
  });

  it("passes each market's own requests plus its discovery page, in scope order", async () => {
    const settled: SettledMarket[] = [];
    await scan(scanRoutes([MARKETS]), (s) => settled.push(s), { maxMarkets: 1 });
    expect(settled[0]!.requests.map((r) => r.scope)).toEqual(["discovery page 1", "market 11 association", "market 11 book Yes", "market 11 book No"]);
  });

  it("does not change scan results", async () => {
    const without = await scan(scanRoutes([MARKETS]), undefined, { maxMarkets: 4 });
    const withHook = await scan(scanRoutes([MARKETS]), () => undefined, { maxMarkets: 4 });
    expect(JSON.stringify(scanJson(withHook))).toBe(JSON.stringify(scanJson(without)));
  });

  it("records association status and keeps a book received before its sibling failed", async () => {
    const result = await scan(scanRoutes([MARKETS]), undefined, { maxMarkets: 6 });
    const byId: Record<string, ScanEntry> = Object.fromEntries(result.entries.map((e) => [e.gammaId!, e]));
    expect([byId["11"]!.association, byId["12"]!.association, byId["13"]!.association, byId["14"]!.association, byId["15"]!.association]).toEqual([
      "confirmed",
      "mismatch",
      "confirmed",
      "failed",
      "not_attempted",
    ]);
    expect(byId["13"]!.outcomes.map((o) => o.outcome.label)).toEqual(["Yes"]);
    expect(byId["13"]!.metrics).toBeNull();
    expect(byId["13"]!.outcomes[0]!.assessment.quality).toBe("valid");
    expect(byId["11"]!.discoveryPage).toBe(1);
  });

  it("budget-starved selected markets still settle (with only their discovery page as evidence)", async () => {
    const settled: SettledMarket[] = [];
    await scan(scanRoutes([MARKETS.slice(0, 2)]), (s) => settled.push(s), { maxMarkets: 2, maxRequests: 4 });
    expect(settled.map((s) => [s.entry.gammaId, s.entry.bucket, s.entry.reasons[0]?.code ?? null, s.requests.map((r) => r.scope)])).toEqual([
      ["11", "ranked", null, ["discovery page 1", "market 11 association", "market 11 book Yes", "market 11 book No"]],
      ["12", "notScanned", "BUDGET_EXHAUSTED", ["discovery page 1"]],
    ]);
  });
});
