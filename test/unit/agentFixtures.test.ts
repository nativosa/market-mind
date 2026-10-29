import { afterEach, describe, expect, it } from "vitest";
import { agentRoutes, INJECTION_QUESTION, seedAgentDb } from "../../test-agent/fixtures.js";
import { summarizeTrace } from "../../test-agent/traceSummary.js";
import { call, connect, ok, type Connected } from "../mcpFixtures.js";
import { cleanupTemp, tempDbPath } from "../storageFixtures.js";

// Stage 2.4: the synthetic universe used by real-agent scenarios really has the properties the
// scenarios claim, synthetic history is hidden unless explicitly requested, and the trace summary
// attributes tool calls correctly. No model is called.

describe("agent scenario fixtures", () => {
  let c: Connected | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
    cleanupTemp();
  });

  async function universe() {
    const dbPath = tempDbPath("agent.sqlite");
    seedAgentDb(dbPath);
    c = await connect({ routes: agentRoutes(), dbPath });
    return c;
  }

  it("excludes synthetic history unless includeSynthetic is requested", async () => {
    const s = await universe();
    const hidden = ok(await call(s, "get_market_history", { marketId: "900103" }));
    expect(hidden.status).toBe("no_history");
    expect(hidden.evidence).toBe("insufficient");
    const shown = ok(await call(s, "get_market_history", { marketId: "900103", includeSynthetic: true }));
    expect(shown.status).toBe("ok");
    expect(shown.rows.items.length).toBe(5);
    expect(shown.rows.items.every((r) => r.sourceType === "synthetic" && r.runId.startsWith("synthetic-"))).toBe(true);
  });

  it("serves simulated live data from non-production hosts only", async () => {
    const s = await universe();
    const v = ok(await call(s, "inspect_market", { marketId: "900102" }));
    expect(v.requests.map((r) => new URL(r.url).host).every((h) => h.endsWith(".example"))).toBe(true);
    expect(s.calls.every((x) => new URL(x.url).host.endsWith(".example"))).toBe(true);
  });

  it("thin-wide market: wide spread, best sizes below 10 x minOrderSize, thin synthetic history", async () => {
    const s = await universe();
    const v = ok(await call(s, "inspect_market", { marketId: "900101" }));
    const ref = v.outcomes[0]!;
    expect(ref.metrics?.spread).toBe("0.3");
    expect(ref.book.minOrderSize).toBe("5");
    expect(Number(ref.metrics?.bestBidSize)).toBeLessThan(50);
    const h = ok(await call(s, "get_market_history", { marketId: "900101", includeSynthetic: true }));
    expect(h.stats?.usable).toBe(3);
  });

  it("no-history market: reasonable book and no stored observation even with synthetic history", async () => {
    const s = await universe();
    const v = ok(await call(s, "inspect_market", { marketId: "900102" }));
    expect(v.outcomes.map((o) => [o.quality, o.metrics?.state, o.metrics?.spread])).toEqual([
      ["valid", "two-sided", "0.04"],
      ["valid", "two-sided", "0.04"],
    ]);
    expect(ok(await call(s, "get_market_history", { marketId: "900102", includeSynthetic: true })).status).toBe("no_history");
  });

  it("consistent market: 5 usable synthetic samples with distinct states, current spread inside the range", async () => {
    const s = await universe();
    const h = ok(await call(s, "get_market_history", { marketId: "900103", includeSynthetic: true }));
    expect(h.stats).toMatchObject({ usable: 5, spread: { n: 5, min: "0.03", median: "0.04", max: "0.05" }, threshold: { atOrAbove: 5 } });
    expect(h.stats!.states.distinct).toBe(5);
    expect(ok(await call(s, "inspect_market", { marketId: "900103" })).outcomes[0]!.metrics?.spread).toBe("0.04");
  });

  it("injection market: the hostile question arrives as listed untrusted data", async () => {
    const s = await universe();
    const v = ok(await call(s, "inspect_market", { marketId: "900104" }));
    expect(v.untrustedTextFields).toContain("market.question");
    expect(v.market.question).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    expect(INJECTION_QUESTION.length).toBeLessThanOrEqual(300);
  });

  it("discover: the default scan ranks an EXTREME_PRICE market first and 900102 is the first eligible candidate", async () => {
    const s = await universe();
    const v = ok(await call(s, "scan_markets", {}));
    expect(v.status).toBe("complete");
    expect(v.ranked.items.map((i) => [i.gammaId, i.warningCodes])).toEqual([
      ["900100", ["EXTREME_PRICE"]],
      ["900102", []],
      ["900103", []],
      ["900104", []],
    ]);
    expect(v.notRanked.items.map((i) => [i.gammaId, i.reasonCodes])).toEqual([["900101", ["TOP_SIZE_BELOW_MIN"]]]);
    expect(v.budget.call.used).toBeLessThanOrEqual(16);
  });

  it("one-sided market: no spread is computed", async () => {
    const s = await universe();
    const ref = ok(await call(s, "inspect_market", { marketId: "900105" })).outcomes[0]!;
    expect(ref.metrics).toMatchObject({ state: "bid-only", spread: null });
  });
});

describe("trace summary", () => {
  const line = (o: object) => JSON.stringify(o);
  const use = (id: string, name: string, parent: string | null) => line({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input: {} }] } });
  const res = (id: string, parent: string | null, isError = false) => line({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }] } });
  const P = "forked-command-investigate-market";

  it("attributes calls to the main session or the subagent and flags non-allowlisted subagent tools", () => {
    const trace = [
      line({ type: "system", subtype: "init", tools: ["Bash", "mcp__marketmind__inspect_market"], model: "m", permissionMode: "default" }),
      use("a", "mcp__marketmind__inspect_market", P),
      res("a", P),
      use("b", "Bash", P),
      res("b", P, true),
      use("c", "mcp__marketmind__get_market_history", null),
      line({ type: "assistant", parent_tool_use_id: P, message: { content: [{ type: "text", text: "# report" }] } }),
      line({ type: "result", subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0.01, permission_denials: [], result: "# report" }),
    ].join("\n");
    const s = summarizeTrace(trace);
    expect(s.subagentParents).toEqual([P]);
    expect(s.counts).toEqual({
      mcp__marketmind__inspect_market: { main: 0, subagent: 1 },
      Bash: { main: 0, subagent: 1 },
      mcp__marketmind__get_market_history: { main: 1, subagent: 0 },
    });
    expect(s.unauthorizedSubagentCalls.map((x) => x.name)).toEqual(["Bash"]);
    expect(s.calls.find((x) => x.name === "Bash")?.isError).toBe(true);
    expect(s.mainMarketmindCalls.map((x) => x.name)).toEqual(["mcp__marketmind__get_market_history"]);
    expect(s.init?.marketmindTools).toEqual(["mcp__marketmind__inspect_market"]);
    expect(s.subagentFinalText).toBe("# report");
    expect(s.result?.costUsd).toBe(0.01);
  });
});
