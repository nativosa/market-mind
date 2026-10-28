import { describe, expect, it } from "vitest";
import { createClobClient } from "../src/adapters/polymarket/clobClient.js";
import { createGammaClient } from "../src/adapters/polymarket/gammaClient.js";
import { createHttpClient, realHttpDeps } from "../src/adapters/polymarket/httpClient.js";
import { inspectMarket, type InspectResult } from "../src/app/inspectMarket.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { decimal, decimalToString, half } from "../src/domain/decimal.js";
import { inspectEligibility, type Market, type ProtocolVersion } from "../src/domain/market.js";
import { budgetedFetch } from "./budgetedFetch.js";
import { classifySmokeError, isCandidateUnavailable, type FailureOutcome } from "./classification.js";

// Opt-in live smoke test (npm run smoke). Read-only public GETs only.
// Budget per protocol: <= 3 discovery pages + <= 2 candidates x 4 requests
// (Gamma market detail, CLOB market info, 2 books) = 11 <= 12.
const REQUEST_BUDGET = 12;
const MAX_PAGES = 3;
const PAGE_SIZE = 20;
const MAX_CANDIDATES = 2;

type SmokeOutcome = { status: "PASS"; result: InspectResult } | FailureOutcome;

async function runSmoke(version: ProtocolVersion, budget: ReturnType<typeof budgetedFetch>): Promise<SmokeOutcome> {
  const http = createHttpClient({ ...DEFAULT_CONFIG, maxRetries: 0 }, { ...realHttpDeps, fetch: budget.fetch });
  const gamma = createGammaClient(http, DEFAULT_CONFIG.gammaBaseUrl);
  const clob = createClobClient(http, DEFAULT_CONFIG.clobBaseUrl);
  const upstreamOrFail = (error: unknown, step: string): SmokeOutcome => classifySmokeError(error, step, budget.exceeded);

  // 1. Bounded discovery.
  const candidates: Market[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && candidates.length < MAX_CANDIDATES; page++) {
    let result;
    try {
      result = await gamma.listOpenMarkets({ limit: PAGE_SIZE, version, ...(cursor ? { cursor } : {}) });
    } catch (error) {
      return upstreamOrFail(error, `discovery page ${page + 1}`);
    }
    const wrongVersion = result.markets.filter((m) => m.version !== version);
    if (wrongVersion.length > 0) return { status: "FAIL", detail: `version=${version} returned ${wrongVersion[0]!.version} market` };
    for (const m of result.markets) {
      const e = inspectEligibility(m);
      if (e.eligible && e.warnings.length === 0) candidates.push(m);
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  if (candidates.length === 0) {
    return { status: "SKIP", reason: "LIVE_DATA_UNAVAILABLE", detail: `no eligible open ${version} binary market in ${MAX_PAGES} pages` };
  }

  // 2. Inspect up to MAX_CANDIDATES; data-availability problems move on to the next candidate.
  const unavailable: string[] = [];
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      return { status: "PASS", result: await inspectMarket({ gamma, clob }, candidate.gammaId, { depthBand: decimal("0.05") }) };
    } catch (error) {
      if (!budget.exceeded && isCandidateUnavailable(error)) {
        unavailable.push(`${candidate.gammaId}: [${error.kind}] ${error.message}`);
        continue;
      }
      return upstreamOrFail(error, `inspect ${candidate.gammaId}`);
    }
  }
  return { status: "SKIP", reason: "LIVE_DATA_UNAVAILABLE", detail: unavailable.join("; ") };
}

function assertInvariants(result: InspectResult, version: ProtocolVersion): void {
  expect(result.market.version).toBe(version);
  expect(result.association.gammaIndexCrossCheck).toBe("match");
  expect(result.requests).toHaveLength(4);
  for (const p of result.requests) {
    expect(p.httpStatus).toBe(200);
    expect(Date.parse(p.timing.responseReceivedAt)).toBeGreaterThanOrEqual(Date.parse(p.timing.finalAttemptStartedAt));
  }
  for (const { outcome, book, assessment } of result.outcomes) {
    expect(outcome.assetIdKind).toBe(version === "v2" ? "positionId" : "tokenId");
    expect(book.assetId).toBe(outcome.assetId);
    expect(book.provenance.url).toContain(outcome.assetId);
    expect(assessment.quality).not.toBe("invalid");
    const m = assessment.metrics!;
    if (m.bestBid && m.bestAsk) {
      expect(m.spread!.eq(m.bestAsk.price.minus(m.bestBid.price))).toBe(true);
      expect(m.midpoint!.eq(half(m.bestBid.price.plus(m.bestAsk.price)))).toBe(true);
      if (!m.crossed) {
        expect(m.bestBid.price.lte(m.midpoint!)).toBe(true);
        expect(m.midpoint!.lte(m.bestAsk.price)).toBe(true);
      }
    } else {
      expect(m.midpoint).toBeNull();
    }
  }
}

describe.each<ProtocolVersion>(["v1", "v2"])("live smoke %s", (version) => {
  it(`discovers and inspects an eligible ${version} market within ${REQUEST_BUDGET} requests`, async (ctx) => {
    const budget = budgetedFetch(REQUEST_BUDGET);
    const outcome = await runSmoke(version, budget);
    const summary = `[smoke ${version}] ${outcome.status}  requests used ${budget.urls.length}/${REQUEST_BUDGET}`;

    expect(budget.exceeded, "request budget exceeded").toBe(false);
    expect(budget.urls.length).toBeLessThanOrEqual(REQUEST_BUDGET);
    for (const url of budget.urls) expect(url.startsWith("https://")).toBe(true);

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
    console.log(
      `${summary}  market ${result.market.gammaId} "${result.market.question}"\n` +
        result.outcomes
          .map(
            ({ outcome: o, assessment: a }) =>
              `  ${o.label} (${o.assetIdKind}) quality=${a.quality} state=${a.metrics?.state} ` +
              `bid=${a.metrics?.bestBid ? decimalToString(a.metrics.bestBid.price) : "-"} ` +
              `ask=${a.metrics?.bestAsk ? decimalToString(a.metrics.bestAsk.price) : "-"}`,
          )
          .join("\n"),
    );
  });
});
