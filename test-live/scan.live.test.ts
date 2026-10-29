import { describe, expect, it } from "vitest";
import { realHttpDeps } from "../src/adapters/polymarket/httpClient.js";
import { countScan, scanMarkets, type ScanResult } from "../src/app/scanMarkets.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { decimal } from "../src/domain/decimal.js";
import type { ProtocolVersion } from "../src/domain/market.js";
import { budgetedFetch } from "./budgetedFetch.js";
import { classifySmokeError, type FailureOutcome } from "./classification.js";

// Opt-in live scan smoke test (npm run smoke). Read-only public GETs only.
// Budget per protocol: 1 discovery page + 3 markets x (association + 2 books) = 10 <= 12.
const REQUEST_BUDGET = 12;
const MIN_TOP_SIZE = decimal("10");

type ScanOutcome = { status: "PASS"; result: ScanResult } | FailureOutcome;

async function runScan(version: ProtocolVersion, budget: ReturnType<typeof budgetedFetch>): Promise<ScanOutcome> {
  try {
    const result = await scanMarkets(
      {
        version,
        discoverOrder: "volume24hr",
        maxMarkets: 3,
        top: 3,
        pageSize: 10,
        maxPages: 1,
        filters: { minSpread: decimal("0"), minTopSize: MIN_TOP_SIZE, includeSuspicious: false },
        depthBand: decimal("0.05"),
        maxRequests: REQUEST_BUDGET,
        concurrency: 2,
        maxDurationMs: 60_000,
      },
      {
        http: { ...realHttpDeps, fetch: budget.fetch },
        httpOptions: { ...DEFAULT_CONFIG, maxRetries: 0 },
        gammaBaseUrl: DEFAULT_CONFIG.gammaBaseUrl,
        clobBaseUrl: DEFAULT_CONFIG.clobBaseUrl,
      },
    );
    if (countScan(result).selected === 0) {
      return { status: "SKIP", reason: "LIVE_DATA_UNAVAILABLE", detail: `no eligible open ${version} binary market on the first page` };
    }
    return { status: "PASS", result };
  } catch (error) {
    return classifySmokeError(error, "scan", budget.exceeded);
  }
}

function assertInvariants(result: ScanResult, version: ProtocolVersion): void {
  const c = countScan(result);
  expect(c.discovered).toBe(c.rankedTotal + c.filtered + c.excluded + c.failed + c.notScanned);
  expect(c.selected).toBe(Math.min(c.eligible, 3));
  expect(c.notScannedByReason.SAMPLE_LIMIT).toBe(c.eligible - c.selected);
  expect(result.budget.used).toBeLessThanOrEqual(REQUEST_BUDGET);
  for (const e of result.entries) if (e.market) expect(e.market.version).toBe(version);
  for (let i = 1; i < result.ranked.length; i++) {
    expect(result.ranked[i - 1]!.metrics!.spread!.gte(result.ranked[i]!.metrics!.spread!)).toBe(true);
  }
  for (const e of result.ranked) {
    const m = e.metrics!;
    expect(m.topSize!.gte(MIN_TOP_SIZE)).toBe(true);
    expect(m.reference.index).toBe(0);
    expect(m.state).toBe("two-sided");
    expect(e.outcomes).toHaveLength(2);
    for (const o of e.outcomes) {
      expect(o.assessment.quality).not.toBe("invalid");
      expect(o.outcome.assetIdKind).toBe(version === "v2" ? "positionId" : "tokenId");
      expect(o.book.assetId).toBe(o.outcome.assetId);
    }
  }
  for (const r of result.requests) {
    expect(r.url.startsWith("https://")).toBe(true);
    if (r.timing) expect(Date.parse(r.timing.responseReceivedAt)).toBeGreaterThanOrEqual(Date.parse(r.timing.finalAttemptStartedAt));
  }
}

describe.each<ProtocolVersion>(["v1", "v2"])("live scan smoke %s", (version) => {
  it(`scans up to 3 ${version} markets within ${REQUEST_BUDGET} requests`, async (ctx) => {
    const budget = budgetedFetch(REQUEST_BUDGET);
    const outcome = await runScan(version, budget);
    const summary = `[scan smoke ${version}] ${outcome.status}  requests used ${budget.urls.length}/${REQUEST_BUDGET}`;

    expect(budget.exceeded, "request budget exceeded").toBe(false);
    for (const url of budget.urls) expect(url).toMatch(/^https:\/\/(gamma-api|clob)\.polymarket\.com\/(markets\/keyset|clob-markets\/|book\?)/);

    if (outcome.status === "SKIP") {
      console.log(`${summary}  reason=${outcome.reason}  ${outcome.detail}`);
      ctx.skip(`${outcome.reason}: ${outcome.detail}`);
      return;
    }
    if (outcome.status === "FAIL") {
      console.log(`${summary}  ${outcome.detail}`);
      expect.fail(outcome.detail);
    }

    const { result } = outcome;
    assertInvariants(result, version);
    const c = countScan(result);
    console.log(
      `${summary}  status=${result.status} stops=[${result.stopReasons.join(",")}]  discovered=${c.discovered} eligible=${c.eligible} ` +
        `inspected=${c.selected} ranked=${c.rankedTotal} filtered=${c.filtered} excluded=${c.excluded} failed=${c.failed} notScanned=${c.notScanned}\n` +
        result.entries
          .filter((e) => e.selected)
          .map((e) => `  ${e.gammaId} ${e.bucket} ${e.reasons.map((r) => r.code).join(",")} warnings=${e.warnings.map((w) => w.code).join(",") || "-"}`)
          .join("\n"),
    );
  });
});
