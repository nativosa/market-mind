import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, describe, expect, it } from "vitest";

// Opt-in live MCP smoke test (npm run smoke): the real server process over real stdio, public GETs only.
// The server itself enforces the budget: MARKETMIND_MCP_MAX_REQUESTS=12 caps every physical attempt in the
// process. scan_markets reserves 4 (1 page + 1 market x 3) and inspect_market reserves 8 (4 requests,
// one retry each): at most 12 attempts, normally 8.
const CEILING = 12;
const LAUNCHER = fileURLToPath(new URL("../bin/marketmind-mcp.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mm-live-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Result = { isError?: boolean; content: { text?: string }[]; structuredContent?: Record<string, unknown> };
type ErrorBody = { error: { category: string; message: string } };
const TRANSIENT = ["upstream_unavailable", "rate_limited", "deadline_exceeded"];
const LIVE_URL = /^https:\/\/(gamma-api|clob)\.polymarket\.com\//;

describe("live MCP smoke", () => {
  it(`scans and inspects through the real stdio server within a server-enforced ceiling of ${CEILING} attempts`, async (ctx) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCHER],
      env: { ...getDefaultEnvironment(), MARKETMIND_MCP_MAX_REQUESTS: String(CEILING), MARKETMIND_DB: join(dir, "absent.sqlite") },
      cwd: dir,
      stderr: "pipe",
    });
    const client = new Client({ name: "marketmind-live-smoke", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(5);
      const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
      const skipOrFail = (step: string, r: Result) => {
        const e = (JSON.parse(r.content[0]!.text!) as ErrorBody).error;
        const line = `[mcp smoke] ${step}: ${e.category}: ${e.message}`;
        console.log(line);
        if (TRANSIENT.includes(e.category)) ctx.skip(`UPSTREAM_UNAVAILABLE ${line}`);
        expect.fail(line);
      };

      const scan = await call("scan_markets", { version: "v1", maxMarkets: 1, top: 1, pageSize: 10, maxRequests: 4 });
      if (scan.isError) return skipOrFail("scan_markets", scan);
      const s = scan.structuredContent as {
        status: string;
        budget: { call: { used: number }; process: { used: number } };
        ranked: { items: { gammaId: string; metrics: { spread: string | null } }[] };
        notRanked: { items: { gammaId: string | null; bucket: string }[] };
        source: string;
      };
      expect(s.source).toBe("live");
      const candidate = s.ranked.items[0]?.gammaId ?? s.notRanked.items.find((e) => e.gammaId && e.bucket !== "failed")?.gammaId ?? null;
      if (candidate === null) {
        console.log("[mcp smoke] SKIP LIVE_DATA_UNAVAILABLE: no inspectable market on the first page");
        return ctx.skip("LIVE_DATA_UNAVAILABLE");
      }

      const inspect = await call("inspect_market", { marketId: candidate, levels: 3 });
      if (inspect.isError) return skipOrFail("inspect_market", inspect);
      const i = inspect.structuredContent as {
        status: string;
        market: { gammaId: string; protocolVersion: string };
        outcomes: { metrics: { bestBid: string | null; spread: string | null } | null }[];
        requests: { url: string }[];
        budget: { call: { used: number; limit: number }; process: { used: number; limit: number } };
      };
      expect(["ok", "invalid_book"]).toContain(i.status);
      expect(i.market).toMatchObject({ gammaId: candidate, protocolVersion: "v1" });
      for (const o of i.outcomes) for (const v of [o.metrics?.bestBid, o.metrics?.spread]) if (v != null) expect(v).toMatch(/^-?\d+(\.\d+)?$/);
      for (const r of i.requests) expect(r.url).toMatch(LIVE_URL);

      // Offline tool in the same live process: no database, no request.
      const history = await call("get_market_history", { marketId: candidate });
      expect((JSON.parse(history.content[0]!.text!) as ErrorBody).error.category).toBe("database_missing");

      const total = i.budget.process.used;
      expect(total).toBe(s.budget.call.used + i.budget.call.used);
      expect(total).toBeLessThanOrEqual(CEILING);
      expect(i.budget.process.limit).toBe(CEILING);
      console.log(
        `[mcp smoke] PASS  attempts ${total}/${CEILING} (scan ${s.budget.call.used}, inspect ${i.budget.call.used})  scan ${s.status}  ` +
          `inspect ${candidate} ${i.status}  spread ${i.outcomes[0]?.metrics?.spread ?? "-"}`,
      );
    } finally {
      await client.close();
    }
  });
});
