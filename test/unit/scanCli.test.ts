import { describe, expect, it } from "vitest";
import { parseCli, SCAN_DEFAULTS } from "../../src/cli/args.js";
import { exitCodeFor, run } from "../../src/cli/run.js";
import type { MarketMindError } from "../../src/domain/errors.js";
import { fakeFetch, json, testDeps, type Reply } from "../helpers.js";
import { scanRoutes, type MarketSpec } from "../scanFixtures.js";

async function cli(argv: string[], routes: Record<string, Reply | Reply[]> = {}, extra: { signal?: AbortSignal } = {}) {
  const fake = fakeFetch(routes);
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    http: testDeps(fake.fetch, () => new Date("2026-10-28T21:05:12.000Z")).deps,
    env: { MARKETMIND_GAMMA_URL: "https://gamma.example", MARKETMIND_CLOB_URL: "https://clob.example" },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ...extra,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n"), calls: fake.calls };
}

function usageError(argv: string[]): MarketMindError {
  try {
    parseCli(argv);
  } catch (e) {
    return e as MarketMindError;
  }
  throw new Error("expected usage error");
}

const MARKETS: MarketSpec[] = [
  { id: "11", volume24hr: 30, book: { bids: [["0.40", "100"]], asks: [["0.46", "100"]] } },
  { id: "12", volume24hr: 20, book: { bids: [["0.30", "50"]], asks: [["0.40", "60"]] } },
  { id: "13", volume24hr: 10, book: { bids: [["0.40", "2"]], asks: [["0.50", "2"]] } },
];

describe("scan argument parsing", () => {
  it("applies the approved defaults", () => {
    expect(parseCli(["scan"])).toEqual({
      kind: "scan",
      version: "v1",
      discoverOrder: "volume24hr",
      maxMarkets: 10,
      top: 10,
      pageSize: 50,
      maxPages: 2,
      minSpread: "0",
      minTopSize: "10",
      includeSuspicious: false,
      depthBand: "0.05",
      maxRequests: 48,
      concurrency: 4,
      maxDurationMs: 60_000,
      json: false,
    });
    expect(SCAN_DEFAULTS.maxRequests).toBe(48);
  });

  it("accepts every option at its bounds", () => {
    expect(
      parseCli([
        "scan",
        "--version",
        "v2",
        "--discover-order",
        "none",
        "--max-markets",
        "30",
        "--top",
        "50",
        "--page-size",
        "100",
        "--max-pages",
        "3",
        "--min-spread",
        "1",
        "--min-top-size",
        "0.5",
        "--include-suspicious",
        "--depth-band",
        "none",
        "--max-requests",
        "120",
        "--concurrency",
        "8",
        "--max-duration-ms",
        "120000",
        "--json",
      ]),
    ).toMatchObject({
      version: "v2",
      discoverOrder: "none",
      maxMarkets: 30,
      top: 50,
      pageSize: 100,
      maxPages: 3,
      minSpread: "1",
      minTopSize: "0.5",
      includeSuspicious: true,
      depthBand: null,
      maxRequests: 120,
      concurrency: 8,
      maxDurationMs: 120_000,
      json: true,
    });
  });

  it.each([
    [["scan", "--max-markets", "31"]],
    [["scan", "--max-markets", "0"]],
    [["scan", "--top", "51"]],
    [["scan", "--page-size", "101"]],
    [["scan", "--max-pages", "4"]],
    [["scan", "--max-requests", "121"]],
    [["scan", "--concurrency", "9"]],
    [["scan", "--max-duration-ms", "999"]],
    [["scan", "--max-duration-ms", "120001"]],
    [["scan", "--min-spread", "1.5"]],
    [["scan", "--min-spread", "-0.1"]],
    [["scan", "--min-top-size", "-1"]],
    [["scan", "--min-top-size", "1e3"]],
    [["scan", "--discover-order", "volume_num"]],
    [["scan", "--version", "v3"]],
    [["scan", "--limit", "5"]],
    [["scan", "--market-id", "1"]],
    [["scan", "--cursor", "abc"]],
    [["markets", "--top", "5"]],
    [["inspect", "--market-id", "1", "--max-markets", "5"]],
    [["inspect", "--market-id", "1", "--version", "v1"]],
  ])("rejects %j", (argv) => {
    expect(usageError(argv).kind).toBe("Usage");
  });

  it("Cancelled maps to exit 6 (partial)", () => {
    expect(exitCodeFor("Cancelled")).toBe(6);
  });
});

describe("scan command", () => {
  it("prints ranked candidates, accounting, the disclaimer and the non-atomic window (exit 0)", async () => {
    const r = await cli(["scan", "--top", "1"], scanRoutes([MARKETS]));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("status=COMPLETE");
    expect(r.stdout).toContain("Research candidates only. Quoted spreads are not profits, expected returns or recommendations to trade.");
    expect(r.stdout).toContain("(not an atomic snapshot)");
    expect(r.stdout).toContain("Ranked candidates (showing 1 of 2)");
    expect(r.stdout).toContain("selection order = Gamma volume24hr desc (not used for ranking)");
    expect(r.stdout).toContain("1. 12: reference outcome \"Yes\" (index 0); spread 0.1 >= min 0; top-of-book size 50 shares >= min 10");
    expect(r.stdout).toContain("Accounting: discovered 3 = ranked 2 + filtered 1 + excluded 0 + failed 0 + not scanned 0");
    expect(r.stdout).toContain("13  TOP_SIZE_BELOW_MIN  top size 2 shares < min 10");
    expect(r.stdout).toContain("Requests: 10 of 48 budget");
  });

  it("emits bounded JSON with decimals as strings, provenance and counts", async () => {
    const r = await cli(["scan", "--json", "--top", "1"], scanRoutes([MARKETS]));
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as Record<string, unknown> & {
      ranked: { metrics: { spread: unknown; reference: unknown } }[];
      counts: Record<string, unknown>;
      requests: { timing: unknown; scope: string }[];
    };
    expect(body.status).toBe("complete");
    expect(body.rankedTotal).toBe(2);
    expect(body.ranked).toHaveLength(1);
    expect(body.ranked[0]!.metrics.spread).toBe("0.1");
    expect(body.ranked[0]!.metrics.reference).toMatchObject({ index: 0, label: "Yes" });
    expect(body.counts).toMatchObject({ discovered: 3, eligible: 3, selected: 3, rankedTotal: 2, filtered: 1 });
    expect(body.budget).toEqual({ limit: 48, used: 10 });
    expect(body.requests).toHaveLength(10);
    expect(body.requests.every((q) => q.timing !== null)).toBe(true);
    expect(r.stdout).not.toMatch(/\de[+-]?\d/); // no exponent notation anywhere
  });

  it("never represents spreads as profits, returns or trade recommendations", async () => {
    const r = await cli(["scan", "--json"], scanRoutes([MARKETS]));
    const body = JSON.parse(r.stdout) as { disclaimer: string; ranked: { explanation: string[] }[] };
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(body);
    expect(keys.filter((k) => /profit|return|recommend|action|signal|pnl|edge/i.test(k))).toEqual([]);
    expect(body.disclaimer).toMatch(/not profits, expected returns or recommendations to trade/);
    // Explanations come only from the enumerated factual templates.
    const templates = [/^reference outcome ".+" \(index \d+\)$/, /^spread [\d.]+ >= min [\d.]+$/, /^top-of-book size [\d.]+ shares >= min [\d.]+$/, /^book quality \w+$/];
    for (const row of body.ranked) for (const line of row.explanation) expect(templates.some((t) => t.test(line))).toBe(true);
  });

  it("returns exit 6 with a partial report when a candidate fails", async () => {
    const routes = scanRoutes([[...MARKETS, { id: "14", replies: { book0: json({ error: "boom" }, 500) } }]]);
    const r = await cli(["scan"], routes);
    expect(r.code).toBe(6);
    expect(r.stdout).toContain("status=PARTIAL");
    expect(r.stdout).toContain("Failed (1)");
    expect(r.stdout).toContain("14  HTTP_UPSTREAM_5XX");
    expect(r.stderr).toContain("scan incomplete: one or more candidates failed (exit 6)");
  });

  it("returns exit 6 and still reports when cancelled", async () => {
    const user = new AbortController();
    user.abort();
    const r = await cli(["scan", "--json"], scanRoutes([MARKETS]), { signal: user.signal });
    expect(r.code).toBe(6);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "partial", stopReasons: ["CANCELLED"], counts: { discovered: 0 } });
    expect(r.calls).toHaveLength(0);
    expect(r.stderr).toContain("scan incomplete: CANCELLED");
  });

  it("exit 4 when discovery is unavailable, exit 5 when Gamma rejects the order", async () => {
    expect((await cli(["scan"], scanRoutes([[]], { keyset: json({ error: "down" }, 503) }))).code).toBe(4);
    const rejected = await cli(["scan", "--json"], scanRoutes([[]], { keyset: json({ error: "order fields are not valid" }, 422) }));
    expect(rejected.code).toBe(5);
    expect(rejected.stderr).toContain("--discover-order none");
    expect(JSON.parse(rejected.stdout)).toMatchObject({ error: { kind: "Validation" } });
  });

  it("prints usage with exit 2 for invalid scan options", async () => {
    const r = await cli(["scan", "--max-requests", "500"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--max-requests must be an integer between 1 and 120");
    expect(r.stderr).toContain("npm run cli -- scan");
    expect(r.calls).toHaveLength(0);
  });
});

describe("scan text output details", () => {
  it("lists every bucket, warnings and duplicates; truncates long lists", async () => {
    const many: MarketSpec[] = Array.from({ length: 28 }, (_, i) => ({ id: String(100 + i), gamma: { acceptingOrders: false } }));
    const markets: MarketSpec[] = [
      { id: "11", book: { bids: [["0.001", "1000"]], asks: [["0.004", "1000"]] }, gamma: { endDate: "2020-01-01T00:00:00Z" } },
      { id: "12", book: { bids: [["0.4", "100"]], asks: [["0.4", "100"]] } },
      { id: "13", replies: { association: json({ error: "gone" }, 404) } },
      { id: "14", book: { bids: [["0.40", "3"]], asks: [["0.50", "3"]] } },
      { id: "15", book: { bids: [["0.4", "100"]], asks: [["0.45", "100"]] }, other: { bids: [["0.5", "100"]], asks: [["0.7", "100"]] } },
      ...Array.from({ length: 26 }, (_, i) => ({ id: String(200 + i), book: { bids: [["0.4", "1"]] as [string, string][], asks: [["0.5", "1"]] as [string, string][] } })),
      ...many,
    ];
    const r = await cli(["scan", "--max-markets", "30", "--max-requests", "120", "--page-size", "100", "--discover-order", "none"], scanRoutes([markets]));
    expect(r.code).toBe(6);
    expect(r.stdout).toContain("; Gamma default order");
    expect(r.stdout).toContain("Excluded (29): LOCKED_BOOK 1, NOT_ACCEPTING_ORDERS 28, SUSPICIOUS_BOOK 1");
    expect(r.stdout).toContain("inspected but structurally unsuitable:");
    expect(r.stdout).toContain("Failed (1)");
    expect(r.stdout).toContain("Filtered (26)");
    expect(r.stdout).toContain("Not scanned (1): SAMPLE_LIMIT 1");
    expect(r.stdout).toContain("11  EXTREME_PRICE");
    expect(r.stdout).toContain("11  END_DATE_PASSED");
    expect(r.stdout).toContain("15  COMPLEMENT_MISMATCH");
  });

  it("shows an empty ranking and a missing window", async () => {
    const r = await cli(["scan"], scanRoutes([[{ id: "11", book: { bids: [], asks: [] } }]]));
    expect(r.stdout).toContain("Ranked candidates (showing 0 of 0)\n  (none)");
    expect(r.stdout).toContain("Warnings: none");
    const user = new AbortController();
    user.abort();
    const cancelled = await cli(["scan"], {}, { signal: user.signal });
    expect(cancelled.stdout).toContain("No requests completed.");
    expect(cancelled.stdout).toContain("stopped: CANCELLED");
  });

  it("truncates long bucket lists in text and reports duplicates", async () => {
    const thin: MarketSpec[] = Array.from({ length: 30 }, (_, i) => ({ id: String(300 + i), book: { bids: [["0.4", "1"]], asks: [["0.5", "1"]] } }));
    const routes = scanRoutes([thin.slice(0, 29), [thin[0]!, thin[29]!]]);
    const r = await cli(["scan", "--max-markets", "30", "--max-requests", "120", "--page-size", "100"], routes);
    expect(r.stdout).toContain("Filtered (30)");
    expect(r.stdout).toContain("... 5 more (see --json)");
    expect(r.stdout).toContain("DUPLICATE_RECORD: market 300 repeated on page 2, counted once");
  });
});

describe("scan precision and error kinds", () => {
  it("preserves full decimal precision end to end in JSON", async () => {
    const markets: MarketSpec[] = [
      {
        id: "11",
        book: {
          bids: [["0.123456789012345678", "123456789012345678.000000001"]],
          asks: [["0.223456789012345678", "0.000000000000000001"]],
          raw: { tick_size: "0.000000000000000001" },
        },
        other: {
          bids: [["0.776543210987654322", "0.000000000000000001"]],
          asks: [["0.876543210987654322", "123456789012345678.000000001"]],
          raw: { tick_size: "0.000000000000000001" },
        },
      },
    ];
    const r = await cli(["scan", "--json", "--min-top-size", "0"], scanRoutes([markets]));
    const row = (JSON.parse(r.stdout) as { ranked: { metrics: Record<string, unknown> }[] }).ranked[0]!.metrics;
    expect(row.bestBid).toEqual({ price: "0.123456789012345678", size: "123456789012345678.000000001" });
    expect(row.spread).toBe("0.1");
    expect(row.topSize).toBe("0.000000000000000001");
    expect(row.midpoint).toBe("0.173456789012345678");
  });

  it("BudgetExceeded maps to exit 6", () => {
    expect(exitCodeFor("BudgetExceeded")).toBe(6);
  });
});
