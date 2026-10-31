import { describe, expect, it } from "vitest";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { canonical, classifyResponse, createGuard, MARKETMIND_TOOLS } from "../../agent-sdk/guard.js";
import { Recorder } from "../../agent-sdk/events.js";
import { Redactor } from "../../agent-sdk/redact.js";

// Stage 2.6: the PreToolUse guard, the canUseTool canary, event normalization and redaction.

const signal = new AbortController().signal;
const call = (h: HookCallback, input: Record<string, unknown>) => h(input as never, input.tool_use_id as string, { signal });
let n = 0;
function pre(g: ReturnType<typeof createGuard>, name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const id = `t${++n}`;
  return call(g.preToolUse, { hook_event_name: "PreToolUse", tool_name: name, tool_input: args, tool_use_id: id, session_id: "s", transcript_path: "", cwd: "", agent_type: "market-investigator", ...extra }).then((o) => ({
    id,
    decision: (o as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput,
  }));
}
const post = (g: ReturnType<typeof createGuard>, id: string, text: string) => call(g.postToolUse, { hook_event_name: "PostToolUse", tool_name: "x", tool_input: {}, tool_use_id: id, tool_response: [{ type: "text", text }] });
const error = (category: string, retryable: boolean) => JSON.stringify({ contract: "marketmind.error/1", error: { category, code: null, message: "m", retryable, details: {} } });
const guard = (mode: "A" | "B" = "A", syntheticAuthorized = false) => createGuard({ mode, syntheticAuthorized, agentName: "market-investigator" });
const [SCAN, INSPECT, RUNS, HISTORY, DETAILS] = MARKETMIND_TOOLS as [string, string, string, string, string];

describe("PreToolUse guard", () => {
  it("passes the five MarketMind tools on the main thread without authorizing them", async () => {
    const g = guard();
    // A hook "allow" overrides dontAsk, so it must never be emitted: the permission layer decides.
    for (const t of MARKETMIND_TOOLS) expect((await pre(g, t, { k: t })).decision).toBeUndefined();
    expect(g.decisions.every((d) => d.decision === "allow" && d.agentType === "market-investigator")).toBe(true);
  });

  it("a call the permission layer refused is neither pending nor spent", async () => {
    const g = guard();
    const first = await pre(g, INSPECT, { marketId: "1" });
    g.permissionDenied(first.id);
    expect((await pre(g, INSPECT, { marketId: "1" })).decision).toBeUndefined();
    for (let i = 0; i < 6; i++) await pre(g, DETAILS, { observationId: i });
    expect((await pre(g, SCAN, {})).decision?.permissionDecisionReason).toContain("call budget of 7");
  });

  it.each([
    ["Bash", {}, {}, "not one of the five"],
    ["PowerShell", {}, {}, "not one of the five"],
    ["Write", {}, {}, "not one of the five"],
    ["WebFetch", {}, {}, "not one of the five"],
    ["Agent", {}, {}, "not one of the five"],
    ["mcp__other__inspect_market", {}, {}, "not one of the five"],
    [INSPECT, {}, { mcp_server: { name: "evil", source: "project" } }, "unexpected MCP server"],
    [INSPECT, {}, { agent_id: "a1", agent_type: "general-purpose" }, "nested agents"],
    [INSPECT, {}, { agent_type: "general-purpose" }, "unexpected agent"],
    [HISTORY, { marketId: "1", includeSynthetic: true }, {}, "includeSynthetic"],
  ] as const)("denies %s %j %j", async (name, args, extra, reason) => {
    const r = await pre(guard(), name, args, extra);
    expect(r.decision?.permissionDecision).toBe("deny");
    expect(r.decision?.permissionDecisionReason).toContain(reason);
  });

  it("passes includeSynthetic only for an authorized synthetic scenario", async () => {
    expect((await pre(guard("A", true), HISTORY, { marketId: "1", includeSynthetic: true })).decision).toBeUndefined();
  });

  it("blocks an identical repeat of a successful or still pending call; argument order does not matter", async () => {
    const g = guard();
    const first = await pre(g, INSPECT, { marketId: "1", levels: 5 });
    expect((await pre(g, INSPECT, { levels: 5, marketId: "1" })).decision?.permissionDecisionReason).toContain("still pending");
    await post(g, first.id, '{"ok":true}');
    expect((await pre(g, INSPECT, { levels: 5, marketId: "1" })).decision?.permissionDecisionReason).toContain("identical successful call");
    expect((await pre(g, INSPECT, { marketId: "2" })).decision).toBeUndefined();
  });

  it("permits exactly one retry of a failed, retryable call; never of a non-retryable one", async () => {
    const g = guard();
    const a = await pre(g, INSPECT, { marketId: "1" });
    await post(g, a.id, error("upstream_unavailable", true));
    const retry = await pre(g, INSPECT, { marketId: "1" });
    expect(retry.decision).toBeUndefined();
    expect(g.decisions.at(-1)?.reason).toBe("retry of a failed, retryable call");
    await post(g, retry.id, error("upstream_unavailable", true));
    expect((await pre(g, INSPECT, { marketId: "1" })).decision?.permissionDecisionReason).toContain("already used");

    const b = await pre(g, HISTORY, { marketId: "1" });
    await post(g, b.id, error("invalid_arguments", false));
    expect((await pre(g, HISTORY, { marketId: "1" })).decision?.permissionDecisionReason).toContain("non-retryable");
  });

  it("a PostToolUseFailure counts as a failed call with unknown retryability (no retry)", async () => {
    const g = guard();
    const a = await pre(g, INSPECT, { marketId: "1" });
    await call(g.postToolUseFailure, { hook_event_name: "PostToolUseFailure", tool_name: INSPECT, tool_input: {}, tool_use_id: a.id, error: "MCP error -32001: Request timed out" });
    expect(g.outcomes.get(a.id)).toMatchObject({ outcome: "error", retryable: null });
    expect((await pre(g, INSPECT, { marketId: "1" })).decision?.permissionDecision).toBe("deny");
  });

  it("enforces the overall call budget (Mode A 7, Mode B 8); denied calls do not consume it", async () => {
    for (const [mode, budget] of [["A", 7], ["B", 8]] as const) {
      const g = guard(mode);
      await pre(g, "Bash");
      for (let i = 0; i < budget; i++) expect((await pre(g, DETAILS, { observationId: i })).decision).toBeUndefined();
      expect((await pre(g, SCAN, {})).decision?.permissionDecisionReason).toContain(`call budget of ${budget}`);
    }
    void RUNS;
  });

  it("canUseTool is a canary: it always denies and records the request", async () => {
    const g = guard();
    const r = await g.canUseTool("Bash", { command: "rm -rf /" }, { signal, toolUseID: "x" } as never);
    expect(r).toMatchObject({ behavior: "deny" });
    expect(g.canUseToolCalls).toEqual(["Bash"]);
  });

  it("classifies MCP responses in the shapes the CLI may report", () => {
    expect(classifyResponse([{ type: "text", text: error("market_not_found", false) }])).toEqual({ outcome: "error", category: "market_not_found", retryable: false });
    expect(classifyResponse({ content: [{ type: "text", text: error("rate_limited", true) }] })).toMatchObject({ outcome: "error", retryable: true });
    expect(classifyResponse(JSON.parse(error("x", true)))).toMatchObject({ outcome: "error" });
    expect(classifyResponse({ structuredContent: { contract: "marketmind.inspect/1" } })).toMatchObject({ outcome: "ok" });
    expect(classifyResponse("not json")).toMatchObject({ outcome: "ok" });
    expect(canonical({ b: [2, { d: 1, c: 0 }], a: null })).toBe('{"a":null,"b":[2,{"c":0,"d":1}]}');
  });
});

describe("event normalization", () => {
  const msg = (m: object) => m as never;
  it("records init, main-thread tool calls with outcomes, nested agents, the report and the result", () => {
    const r = new Recorder();
    r.push(msg({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY", claude_code_version: "2.1.302", tools: MARKETMIND_TOOLS, mcp_servers: [{ name: "marketmind", status: "connected" }], model: "claude-sonnet-5-5", permissionMode: "dontAsk", skills: [], plugins: [], agents: ["market-investigator"] }));
    r.push(msg({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "a", name: INSPECT, input: { marketId: "1" } }] } }));
    r.push(msg({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: error("upstream_unavailable", true) }] }] } }));
    r.push(msg({ type: "assistant", parent_tool_use_id: "agent-1", message: { model: "claude-haiku", content: [{ type: "text", text: "nested" }] } }));
    r.push(msg({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "zzz", content: "orphan" }] } }));
    r.push(msg({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "# Report" }] } }));
    const progress = r.push(msg({ type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 2, total_cost_usd: 0.01, modelUsage: { m: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.01, costBasis: "list" } }, permission_denials: [{ tool_name: "Bash", tool_use_id: "b", tool_input: {} }], result: "# Report", terminal_reason: "completed" }));
    expect(progress[0]?.text).toContain("estimated");
    expect(r.init).toMatchObject({ claudeCodeVersion: "2.1.302", apiKeySource: "ANTHROPIC_API_KEY", tools: MARKETMIND_TOOLS });
    expect([...r.calls.values()][0]).toMatchObject({ name: INSPECT, outcome: "error", errorCategory: "upstream_unavailable", retryable: true, parentToolUseId: null });
    expect(r.nestedAgentMessages).toBe(1);
    expect([...r.models]).toEqual(["claude-sonnet-5-5"]);
    expect(r.problems).toEqual(["tool_result without tool_use zzz"]);
    expect(r.reportText()).toBe("# Report");
    expect(r.result).toMatchObject({ subtype: "success", totalCostUsd: 0.01, terminalReason: "completed", permissionDenials: [{ toolName: "Bash", toolUseId: "b" }] });
  });

  it("reconcile marks guard and permission denials and flags hook/stream disagreements", async () => {
    const g = guard();
    const r = new Recorder();
    const okCall = await pre(g, INSPECT, { marketId: "1" });
    await post(g, okCall.id, '{"ok":true}');
    for (const [id, name] of [[okCall.id, INSPECT], ["d1", "Bash"], ["p1", HISTORY], ["h1", RUNS]] as const) r.push(msg({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name, input: {} }] } }));
    r.push(msg({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: okCall.id, is_error: true, content: "boom" }] } }));
    r.push(msg({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "h1", content: "{}" }] } }));
    g.decisions.push({ toolUseId: "d1", name: "Bash", decision: "deny", reason: "r", agentType: null });
    r.push(msg({ type: "result", subtype: "success", is_error: false, permission_denials: [{ tool_name: HISTORY, tool_use_id: "p1", tool_input: {} }], result: "" }));
    g.outcomes.set("ghost", { outcome: "ok", category: null, retryable: null, agentType: null });
    r.reconcile(g);
    const byId = Object.fromEntries([...r.calls.values()].map((c) => [c.id, [c.outcome, c.deniedBy]]));
    expect(byId).toMatchObject({ d1: ["denied", "guard"], p1: ["denied", "permission"] });
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringContaining("disagree"), expect.stringContaining("no PostToolUse observation for executed call h1"), expect.stringContaining("ghost")]));
  });
});

describe("redaction", () => {
  it("removes the key, key-shaped strings, session fields and home/temp paths", () => {
    const red = new Redactor(["sk-ant-api03-SECRET-123456"], { home: "C:\\Users\\someone", temp: "C:\\Users\\someone\\AppData\\Local\\Temp" });
    const out = red.value({
      text: "key sk-ant-api03-SECRET-123456 and sk-ant-admin01-OTHER-abcdef and Bearer abcdefghijklmnop",
      session_id: "1234",
      cwd: "C:\\Users\\someone\\x",
      nested: [{ path: "C:\\Users\\someone\\AppData\\Local\\Temp\\mm-1\\file", posix: "C:/Users/someone/project" }],
    });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/SECRET|OTHER|abcdefghijklmnop|someone|1234/);
    expect(out.nested[0]!.path).toBe("<temp>\\mm-1\\file");
    expect(out.nested[0]!.posix).toBe("<home>/project");
    expect(out.session_id).toBe("<redacted>");
  });
});
