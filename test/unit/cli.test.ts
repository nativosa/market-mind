import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/adapters/polymarket/httpClient.js";
import { parseCli } from "../../src/cli/args.js";
import { shortId, table } from "../../src/cli/format.js";
import { exitCodeFor, run } from "../../src/cli/run.js";
import type { ErrorKind, MarketMindError } from "../../src/domain/errors.js";
import { fakeFetch, fixture, json, TEST_HTTP_OPTIONS, testDeps, timeoutError, type Reply } from "../helpers.js";
import { V1_NO, V1_ROUTES, V1_YES, V2_ROUTES } from "../routes.js";

async function cli(argv: string[], routes: Record<string, Reply | Reply[]> = {}, env: Record<string, string> = {}) {
  const fake = fakeFetch(routes);
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    http: testDeps(fake.fetch).deps,
    env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
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

describe("argument parsing", () => {
  it("applies defaults", () => {
    expect(parseCli(["markets"])).toEqual({ kind: "markets", limit: 5, version: "v1", cursor: null, json: false });
    expect(parseCli(["inspect", "--market-id", "123"])).toEqual({
      kind: "inspect",
      marketId: "123",
      levels: 10,
      depthBand: "0.05",
      json: false,
    });
  });

  it("accepts all documented options", () => {
    expect(parseCli(["markets", "--limit", "100", "--version", "v2", "--cursor", "abc", "--json"])).toEqual({
      kind: "markets",
      limit: 100,
      version: "v2",
      cursor: "abc",
      json: true,
    });
    expect(parseCli(["inspect", "--market-id", "1", "--levels", "0", "--depth-band", "none"])).toMatchObject({
      levels: 0,
      depthBand: null,
    });
    expect(parseCli(["inspect", "--market-id", "1", "--depth-band", "1"])).toMatchObject({ depthBand: "1" });
  });

  it("shows help with no command or --help", () => {
    expect(parseCli([])).toEqual({ kind: "help" });
    expect(parseCli(["markets", "-h"])).toEqual({ kind: "help" });
  });

  it.each([
    [["markets", "--limit", "0"]],
    [["markets", "--limit", "101"]],
    [["markets", "--limit", "abc"]],
    [["markets", "--limit", "1.5"]],
    [["markets", "--version", "v3"]],
    [["markets", "--cursor", " "]],
    [["markets", "--market-id", "1"]],
    [["markets", "extra"]],
    [["markets", "--bogus"]],
    [["inspect"]],
    [["inspect", "--market-id", "abc"]],
    [["inspect", "--market-id", "1", "--limit", "5"]],
    [["inspect", "--market-id", "1", "--levels", "51"]],
    [["inspect", "--market-id", "1", "--depth-band", "1.5"]],
    [["inspect", "--market-id", "1", "--depth-band", "-0.1"]],
    [["trade"]],
  ])("rejects %j", (argv) => {
    expect(usageError(argv).kind).toBe("Usage");
  });
});

describe("exit codes", () => {
  it.each<[ErrorKind, number]>([
    ["Usage", 2],
    ["NotFound", 3],
    ["Ineligible", 3],
    ["Timeout", 4],
    ["Network", 4],
    ["RateLimited", 4],
    ["Upstream5xx", 4],
    ["HttpStatus", 4],
    ["Validation", 5],
    ["AssociationMismatch", 5],
    ["InvalidBook", 5],
  ])("%s -> %i", (kind, code) => {
    expect(exitCodeFor(kind)).toBe(code);
  });
});

describe("markets command", () => {
  it("prints a table with per-request timing and the next cursor", async () => {
    const r = await cli(["markets", "--limit", "3"], { "/markets/keyset": json(fixture("gamma/keyset-v1.json")) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("protocol=v1");
    expect(r.stdout).toMatch(/gamma +GET \/markets\/keyset +started 21:05:12\.000Z +received 21:05:12\.010Z +10 ms +1 attempt +HTTP 200/);
    expect(r.stdout).toContain("100001");
    expect(r.stdout).toContain("Skipped 1 malformed market record(s)");
    expect(r.stdout).toContain("next cursor: cursor-page-2");
    expect(r.calls).toHaveLength(1);
  });

  it("--version v2 queries v2 explicitly", async () => {
    const r = await cli(["markets", "--version", "v2", "--limit", "2"], { "/markets/keyset": json(fixture("gamma/keyset-v2.json")) });
    expect(r.code).toBe(0);
    expect(r.calls[0]!.url).toContain("version=v2");
    expect(r.stdout).toContain("200002");
    expect(r.stdout).toContain("next cursor: (none)");
  });

  it("--json is parseable and bounded by --limit", async () => {
    const r = await cli(["markets", "--json"], { "/markets/keyset": json(fixture("gamma/keyset-v2.json")) });
    const body = JSON.parse(r.stdout) as { markets: { gammaId: string; inspectable: boolean }[]; request: { timing: object } };
    expect(body.markets).toEqual([expect.objectContaining({ gammaId: "200002", inspectable: true })]);
    expect(body.request.timing).toBeDefined();
  });

  it("prints a placeholder for an empty page", async () => {
    const r = await cli(["markets"], { "/markets/keyset": json({ markets: [], next_cursor: null }) });
    expect(r.stdout).toContain("(no markets returned)");
  });
});

describe("inspect command", () => {
  it("V1 text output attributes timestamps to their own requests", async () => {
    const r = await cli(["inspect", "--market-id", "100001"], V1_ROUTES);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Market 100001 (v1)");
    expect(r.stdout).toContain("ASSET ID (tokenId)");
    expect(r.stdout).toMatch(/Yes +YES +713210\.\.\.2563 +valid +0\.036 +0\.037 +0\.001 +0\.0365/);
    expect(r.stdout).toMatch(/GET \/book Yes \(713210\.\.\.2563\).*server book ts 21:05:37\.744Z/);
    expect(r.stdout).toMatch(/GET \/book No \(521143\.\.\.2426\).*server book ts 21:05:37\.751Z/);
    expect(r.stdout).toContain("Quality issues: none");
  });

  it("V2 text output shows positionId and no YES/NO role", async () => {
    const r = await cli(["inspect", "--market-id", "200002"], V2_ROUTES);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ASSET ID (positionId)");
    expect(r.stdout).toMatch(/Team Alpha +- +600000\.\.\.0168 +valid +- +- +- +-/);
  });

  it("--json: every decimal is a fixed-notation string and JSON round-trips", async () => {
    const r = await cli(["inspect", "--market-id", "100001", "--json", "--levels", "2"], V1_ROUTES);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as {
      outcomes: {
        metrics: Record<string, unknown>;
        levels: { bids: { price: unknown; size: unknown }[]; asks: unknown[]; truncated: boolean };
        book: { request: { url: string; timing: { responseReceivedAt: string } }; serverTimestamp: { iso: string } };
      }[];
      requests: unknown[];
    };
    const yes = body.outcomes[0]!;
    expect(yes.metrics).toMatchObject({
      bestBid: { price: "0.036", size: "117.97" },
      bestAsk: { price: "0.037", size: "3500.66" },
      spread: "0.001",
      midpoint: "0.0365",
      bidDepth: "10200582.31",
      askDepth: "2183509.49",
      depthBand: "0.05",
      askDepthWithinBand: "4400.76",
    });
    expect(yes.levels.bids).toHaveLength(2);
    expect(yes.levels.truncated).toBe(true);
    expect(yes.book.request.url).toContain("token_id=");
    expect(body.requests).toHaveLength(4);
    expect(JSON.stringify(body)).toBe(JSON.stringify(JSON.parse(JSON.stringify(body))));
    // No exponent-formatted numerics anywhere in decimal fields.
    expect(r.stdout).not.toMatch(/"\d+(\.\d+)?e[+-]?\d+"/i);
  });

  it("--json output stays bounded for a very deep book", async () => {
    const deep = {
      ...(fixture("clob/v1-yes-book.json") as object),
      bids: Array.from({ length: 500 }, (_, i) => ({ price: `0.${String(i).padStart(3, "0")}`, size: "1" })),
    };
    const r = await cli(["inspect", "--market-id", "100001", "--json"], {
      ...V1_ROUTES,
      [`token_id=${V1_YES}`]: json(deep),
    });
    const body = JSON.parse(r.stdout) as { outcomes: { levels: { bids: unknown[] }; metrics: { levelCounts: { bids: number } } }[] };
    expect(body.outcomes[0]!.levels.bids).toHaveLength(10);
    expect(body.outcomes[0]!.metrics.levelCounts.bids).toBe(500);
    expect(r.stdout.length).toBeLessThan(20_000);
  });

  it("issues are capped in JSON output", async () => {
    const malformed = Array.from({ length: 30 }, () => ({ price: "bad", size: "1" }));
    const bad = { ...(fixture("clob/v1-yes-book.json") as object), bids: malformed };
    const r = await cli(["inspect", "--market-id", "100001", "--json"], { ...V1_ROUTES, [`token_id=${V1_YES}`]: json(bad) });
    expect(r.code).toBe(5);
    const body = JSON.parse(r.stdout) as { outcomes: { quality: string; issues: unknown[]; omittedIssues: number; metrics: unknown }[] };
    expect(body.outcomes[0]!.quality).toBe("invalid");
    expect(body.outcomes[0]!.metrics).toBeNull();
    expect(body.outcomes[0]!.issues).toHaveLength(20);
    expect(body.outcomes[0]!.omittedIssues).toBe(10);
  });

  it("invalid book: prints details, exits 5", async () => {
    const bad = { ...(fixture("clob/v1-no-book.json") as object), asks: [{ price: "abc", size: "1" }] };
    const r = await cli(["inspect", "--market-id", "100001"], {
      ...V1_ROUTES,
      [`token_id=${V1_NO}`]: json(bad),
    });
    expect(r.code).toBe(5);
    expect(r.stdout).toContain("[invalid/error] MALFORMED_PRICE");
    expect(r.stderr).toContain("error [InvalidBook]");
  });

  it("association mismatch exits 5 with no metrics", async () => {
    const r = await cli(["inspect", "--market-id", "100001"], { ...V1_ROUTES, "/clob-markets/": json({ t: [] }) });
    expect(r.code).toBe(5);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error [AssociationMismatch]");
  });

  it("not found exits 3; --json also writes the error as JSON", async () => {
    const r = await cli(["inspect", "--market-id", "9", "--json"], { "/markets/9": json({ error: "id is invalid" }, 422) });
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stdout) as { error: { kind: string } }).error.kind).toBe("NotFound");
  });

  it("timeout exits 4 after exactly 1 + maxRetries attempts", async () => {
    const r = await cli(["inspect", "--market-id", "100001"], { "/markets/": timeoutError() }, { MARKETMIND_TIMEOUT_MS: "1" });
    expect(r.code).toBe(4);
    expect(r.calls).toHaveLength(3);
    expect(r.stderr).toContain("attempts: 3");
  });

  it("MARKETMIND_MAX_RETRIES=0 disables retries", async () => {
    const r = await cli(["markets"], { "/markets/keyset": json({}, 503) }, { MARKETMIND_MAX_RETRIES: "0" });
    expect(r.code).toBe(4);
    expect(r.calls).toHaveLength(1);
  });
});

describe("cli misc", () => {
  it("usage errors exit 2 and print usage", async () => {
    const r = await cli(["markets", "--limit", "0"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage:");
    expect(r.calls).toHaveLength(0);
  });

  it("help exits 0 without network", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("npm run cli -- markets");
    expect(r.calls).toHaveLength(0);
  });

  it("invalid environment configuration is a usage error", async () => {
    const r = await cli(["markets"], {}, { MARKETMIND_GAMMA_URL: "http://insecure.example" });
    expect(r.code).toBe(2);
  });

  it("unexpected (non-domain) errors exit 1", async () => {
    const out: string[] = [];
    const broken = testDeps(fakeFetch({}).fetch).deps;
    const code = await run(["markets"], {
      http: {
        ...broken,
        now: () => {
          throw new Error("clock broke");
        },
      },
      env: {},
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("clock broke");
  });

  it("formats tables and ids", () => {
    expect(shortId("12345")).toBe("12345");
    expect(shortId("71321045679252212594626385532706912750332728571942532289631379312455583992563")).toBe("713210...2563");
    expect(table(["A", "B"], [["xx", "y"]])).toBe("A   B\nxx  y");
  });

  it("http client used by the CLI never sends credentials", async () => {
    const fake = fakeFetch({ "x.example": json({}) });
    await createHttpClient(TEST_HTTP_OPTIONS, testDeps(fake.fetch).deps).getJson("gamma", "/", "https://x.example/");
    const headers = new Headers(fake.calls[0]!.init.headers);
    expect([...headers.keys()].sort()).toEqual(["accept", "user-agent"]);
  });
});
