import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { realHttpDeps } from "../src/adapters/polymarket/httpClient.js";
import { realLiveness } from "../src/adapters/storage/processLiveness.js";
import { collectMarkets, type CollectResult } from "../src/app/collectMarkets.js";
import { collectionRuns, marketHistory } from "../src/app/marketHistory.js";
import { ANALYTICS_VERSION } from "../src/analytics/version.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { decimal } from "../src/domain/decimal.js";
import { budgetedFetch } from "./budgetedFetch.js";
import { classifySmokeError, type FailureOutcome } from "./classification.js";

// Opt-in live persistence smoke test (npm run smoke). Read-only public GETs; writes only to a
// temporary database that is deleted afterwards. Budget: 1 page + 3 markets x 3 requests = 10 <= 12.
const REQUEST_BUDGET = 12;
const dir = mkdtempSync(join(tmpdir(), "mm-live-collect-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Outcome = { status: "PASS"; result: CollectResult } | FailureOutcome;

async function runCollect(dbPath: string, budget: ReturnType<typeof budgetedFetch>): Promise<Outcome> {
  try {
    const result = await collectMarkets(
      {
        scan: {
          version: "v1",
          discoverOrder: "volume24hr",
          maxMarkets: 3,
          top: 3,
          pageSize: 10,
          maxPages: 1,
          filters: { minSpread: decimal("0"), minTopSize: decimal("10"), includeSuspicious: false },
          depthBand: decimal("0.05"),
          maxRequests: REQUEST_BUDGET,
          concurrency: 2,
          maxDurationMs: 60_000,
        },
        dbPath,
        createParentDir: false,
        maxDbBytes: 64 * 1024 * 1024,
        buildId: null,
        sourceType: "live",
      },
      {
        http: { ...realHttpDeps, fetch: budget.fetch },
        httpOptions: { ...DEFAULT_CONFIG, maxRetries: 0 },
        gammaBaseUrl: DEFAULT_CONFIG.gammaBaseUrl,
        clobBaseUrl: DEFAULT_CONFIG.clobBaseUrl,
        liveness: realLiveness,
        now: () => new Date(),
        pid: process.pid,
        nodeVersion: process.version,
        newRunId: randomUUID,
      },
    );
    if (result.scanError) return classifySmokeError(result.scanError, "collect", budget.exceeded);
    if ((result.persist.selected ?? 0) === 0) return { status: "SKIP", reason: "LIVE_DATA_UNAVAILABLE", detail: "no eligible v1 market on the first page" };
    return { status: "PASS", result };
  } catch (error) {
    return classifySmokeError(error, "collect", budget.exceeded);
  }
}

describe("live collect smoke", () => {
  it(`collects up to 3 v1 markets into a temporary database within ${REQUEST_BUDGET} requests, then queries offline`, async (ctx) => {
    const dbPath = join(dir, "live.sqlite");
    const budget = budgetedFetch(REQUEST_BUDGET);
    const outcome = await runCollect(dbPath, budget);
    const summary = `[collect smoke] ${outcome.status}  requests used ${budget.urls.length}/${REQUEST_BUDGET}`;
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
    const p = result.persist;
    expect(["complete", "partial"]).toContain(result.status);
    expect(result.accounting).toBe("verified");
    expect(result.finalized).toBe(true);
    expect(p.selected).toBe(p.persistedObservations + p.persistenceFailures + p.persistenceFailuresUnrecorded);

    // Offline queries: no further HTTP requests.
    const requestsBefore = budget.urls.length;
    const runs = collectionRuns({ dbPath, limit: 5, liveness: realLiveness, now: () => new Date() });
    expect(runs.runs[0]).toMatchObject({ runId: result.runId, status: result.status, accounting: "verified", sourceType: "live" });
    const paired = result.scan!.entries.find((e) => e.selected && e.outcomes.length === 2);
    let historyLine = "no paired observation to query";
    if (paired) {
      const h = marketHistory({
        dbPath,
        gammaId: paired.gammaId!,
        asOf: null,
        limit: 5,
        threshold: decimal("0.02"),
        analyticsVersion: ANALYTICS_VERSION,
        includeSynthetic: false,
      });
      expect(h.rows[0]!.point.pairing).toBe("paired");
      expect(h.rows[0]!.point.books.map((b) => b.label)).toEqual(paired.outcomes.map((o) => o.outcome.label));
      if (h.rows[0]!.point.metrics?.spread && paired.metrics?.spread) {
        expect(h.rows[0]!.point.metrics.spread.eq(paired.metrics.spread)).toBe(true); // exact round trip
      }
      historyLine = `history ${paired.gammaId}: usable ${h.stats.usable}, spread ${h.stats.spread.current?.toFixed() ?? "-"}`;
    }
    expect(budget.urls.length).toBe(requestsBefore);

    const size = result.footprintAfter.total;
    console.log(
      `${summary}  run ${result.runId} status=${result.status} selected=${p.selected} persisted=${p.persistedObservations} ` +
        `books=${p.booksWritten} metrics=${p.metricsWritten}  db ${size} bytes (main ${result.footprintAfter.main}, wal ${result.footprintAfter.wal}, shm ${result.footprintAfter.shm})\n  ${historyLine}`,
    );
  });
});
