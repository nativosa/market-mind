import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, describe, expect, it, vi } from "vitest";
import { UsageError } from "../../agent-sdk/args.js";
import { MCP_LAUNCHER } from "../../agent-sdk/options.js";
import { APP_VERSION } from "../../src/config/config.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { mcpSettings } from "../../src/mcp/server.js";
import { AuthUsageError, type Preflight } from "../../test-agent/cliAuth.js";
import { parseTrace } from "../../test-agent/eval/trace.js";
import { seedEvalDb } from "../../test-agent/fixtures.js";
import { checkLiveOut, evidenceSummary, liveProblems, LIVE_ROOT, parseLiveArgs, realLiveDeps, renderLiveReport, requestCount, runLive, scrub, SERVER_SETTINGS, type LiveDeps, type LiveOptions, type LiveRecord } from "../../test-agent/live.js";
import { REPO } from "../../test-agent/processes.js";

// Stage 2.7: the live runner, offline. Sessions run the real pinned CLI against the local Messages API stub with
// fake credentials, so nothing reaches a model. No test here reaches Polymarket: a session that uses the real
// server calls only its offline tools, and the ceiling test points the server's upstreams at a local listener.

vi.setConfig({ testTimeout: 90_000 });

const PLATFORM_PACKAGE = join(REPO, "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`);
const BINARY = join(PLATFORM_PACKAGE, process.platform === "win32" ? "claude.exe" : "claude");
const HAVE_CLI = existsSync(BINARY);
const FAKE_LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-not-real-0000000000", refreshToken: "sk-ant-ort01-FAKE-not-real-0000000000", expiresAt: 4102444800000, scopes: ["user:inference", "user:profile"], subscriptionType: "pro" } });
const FAKE_KEY = "sk-ant-api03-FAKE-live-000000000000";
const BIN_SERVER = join(REPO, "bin", "marketmind-mcp.mjs");
const FIXTURE_SERVER = join(REPO, "test-agent", "scenario-mcp.mjs");
const tool = (t: string) => `mcp__marketmind__${t}`;
const BASE = ["--auth", "subscription", "--market-id", "562802", "--max-budget-usd", "0.40", "--out", ".live-out/mvp"];
const report = (id = "900103", label = "INSUFFICIENT_EVIDENCE") => [`# Market investigation: ${id}`, ...Array.from({ length: 10 }, (_, i) => `## ${i + 1}. Section\n${i === 6 ? `Label: ${label}` : "[UNKNOWN] nothing"}`)].join("\n\n");

const dirs: string[] = [];
const temp = (prefix = "mm-livetest-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("arguments", () => {
  it("takes the market from the command line, with no fixture or objective in the prompt", () => {
    const o = parseLiveArgs(BASE);
    expect(o).toMatchObject({ marketId: "562802", prompt: "/investigate-market 562802", maxBudgetUsd: 0.4, timeoutMs: 300_000, check: false });
    expect(parseLiveArgs([...BASE.slice(0, 2), "--market-id", "7", ...BASE.slice(4), "--check", "--timeout-ms", "20000"])).toMatchObject({ marketId: "7", prompt: "/investigate-market 7", timeoutMs: 20_000, check: true });
  });

  const without = (flag: string) => {
    const i = BASE.indexOf(flag);
    return BASE.filter((_, k) => k !== i && k !== i + 1);
  };
  it.each<[string, string[], typeof UsageError | typeof AuthUsageError]>([
    ["no --auth", without("--auth"), AuthUsageError],
    ["an unknown mode", ["--auth", "oauth", ...BASE.slice(2)], AuthUsageError],
    ["API-key mode", ["--auth", "api-key", ...BASE.slice(2)], UsageError],
    ["--auth twice", [...BASE, "--auth", "subscription"], UsageError],
    ["no market", without("--market-id"), UsageError],
    ["a non-numeric market", ["--market-id", "abc", ...without("--market-id")], UsageError],
    ["a 21-digit market", ["--market-id", "1".repeat(21), ...without("--market-id")], UsageError],
    ["no budget", without("--max-budget-usd"), UsageError],
    ["a budget above the cap", ["--max-budget-usd", "0.51", ...without("--max-budget-usd")], UsageError],
    ["a short timeout", [...BASE, "--timeout-ms", "5"], UsageError],
    ["no output", without("--out"), UsageError],
    ["--out twice", [...BASE, "--out", ".live-out/other"], UsageError],
    ["a flag where a value belongs", ["--auth", "subscription", "--market-id", "--check", "--max-budget-usd", "0.4", "--out", ".live-out/x"], UsageError],
    ["--fixture", [...BASE, "--fixture", "S03"], UsageError],
    ["--discover", [...BASE, "--discover"], UsageError],
    ["--objective", [...BASE, "--objective", "Controlled synthetic scenario; synthetic history is authorized"], UsageError],
    ["--dry-run", [...BASE, "--dry-run"], UsageError],
    ["a positional", [...BASE, "562803"], UsageError],
  ])("refuses %s", (_, argv, error) => {
    expect(() => parseLiveArgs(argv)).toThrow(error);
  });
});

describe("the output directory", () => {
  it.each([
    [".."],
    ["."],
    [".live-out"],
    [".live-out/"],
    [".live-out/../src"],
    [".live-out/../../outside"],
    [".eval-out/mvp"],
    ["src/mvp"],
    [".live-out/a/b"],
    [".live-out/a b"],
    [".live-out/name."],
    [".live-out/a:b"],
    [join(tmpdir(), "elsewhere")],
  ])("refuses %s", (out) => {
    expect(() => parseLiveArgs([...BASE.slice(0, 6), "--out", out])).toThrow(UsageError);
  });

  it("accepts a plain new name, normalized to the absolute path", () => {
    expect(checkLiveOut(".live-out/./a/../mvp-1.b")).toBe(join(LIVE_ROOT, "mvp-1.b"));
  });

  it("refuses an existing directory, an existing file and a dangling link: output is never overwritten", () => {
    const root = temp();
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "file"), "x");
    symlinkSync(join(root, "gone"), join(root, "link"), "junction");
    for (const n of ["dir", "file", "link"]) expect(() => checkLiveOut(join(root, n), root), n).toThrow(/never overwritten/);
    expect(() => checkLiveOut(join(root, "new"), root)).not.toThrow();
  });

  it("refuses a root that is a link to somewhere else", () => {
    const base = temp();
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(base, "root"), "junction");
    expect(() => checkLiveOut(join(base, "root", "mvp"), join(base, "root"))).toThrow(/not a link/);
  });
});

const liveHeader = { contract: "x", appVersion: APP_VERSION, generatedAt: "2026-11-01T02:12:29.536Z", status: "ok" };
const INSPECT_OK = { ...liveHeader, source: "live", requests: [{ url: "https://gamma-api.polymarket.com/markets/1" }, { url: "https://clob.polymarket.com/book?token_id=1" }], outcomes: [{ request: { url: "https://clob.polymarket.com/book?token_id=1" } }], budget: { call: { limit: 8, used: 4 }, process: { limit: 16, used: 4, remaining: 12 } } };
const MISSING_DB = { contract: "marketmind.error/1", error: { category: "database_missing", code: "DATABASE_MISSING", message: "none", retryable: false, details: {} } };
const UPSTREAM = { contract: "marketmind.error/1", error: { category: "upstream_unavailable", code: null, message: "down", retryable: true, details: { attempts: 2 } } };
const STORED_OK = { ...liveHeader, source: "stored", rows: [{ sourceType: "live" }] };
/** The text Claude Code 2.1.302 recorded when the server's own output validation rejected a result. */
const VALIDATION_FAILURE = "Output validation error: Invalid structured content for tool get_market_history: stats.gaps.medianMs: Invalid input: expected int, received number";

interface Step {
  name: string;
  input?: Record<string, unknown>;
  result?: unknown;
  scope?: "main" | "subagent";
  isError?: boolean;
}
const inspect = (result: unknown = INSPECT_OK, input: Record<string, unknown> = { marketId: "1" }): Step => ({ name: tool("inspect_market"), input, result });
const history = (result: unknown = MISSING_DB, input: Record<string, unknown> = { marketId: "1", limit: 10 }): Step => ({ name: tool("get_market_history"), input, result, isError: true });

/** A stream as the CLI writes it, so the checks are tested on what parseTrace really produces. */
function streamOf(steps: Step[], text = report("1"), init: unknown = { type: "system", subtype: "init", model: "m", tools: [] }): string[] {
  const lines: unknown[] = [init, { type: "system", subtype: "task_started", subagent_type: "market-investigator" }];
  steps.forEach((s, i) => {
    const parent = (s.scope ?? "subagent") === "main" ? null : "forked-command-investigate-market";
    lines.push({ type: "assistant", parent_tool_use_id: parent, message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: `t${i}`, name: s.name, input: s.input ?? {} }] } });
    if (s.result !== undefined) lines.push({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: s.isError ?? false, content: typeof s.result === "string" ? s.result : JSON.stringify(s.result) }] } });
  });
  lines.push({ type: "assistant", parent_tool_use_id: "forked-command-investigate-market", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text }] } });
  lines.push({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, modelUsage: {}, result: text });
  return lines.map((l) => JSON.stringify(l));
}
const traceOf = (steps: Step[], text = report("1")) => parseTrace(streamOf(steps, text).join("\n"));
const noProblem =(steps: Step[], text?: string) => liveProblems(traceOf(steps, text), "1");

describe("provenance and session checks", () => {
  it("accepts a live inspection with no database", () => {
    expect(noProblem([inspect(), history()])).toEqual([]);
  });

  it("accepts stored live history, and one retry after a retryable error", () => {
    const stored = { ...liveHeader, source: "stored", rows: [{ sourceType: "live" }] };
    expect(noProblem([inspect(UPSTREAM), inspect(), { ...history(stored), isError: false }])).toEqual([]);
  });

  it.each<[string, Step[], string]>([
    ["a synthetic host, even when labelled live", [inspect({ ...INSPECT_OK, requests: [{ url: "https://gamma.example/markets/1" }] })], "not a production host"],
    ["a production name in a longer host", [inspect({ ...INSPECT_OK, requests: [{ url: "https://clob.polymarket.com.evil.test/book" }] })], "not a production host"],
    ["plain HTTP", [inspect({ ...INSPECT_OK, requests: [{ url: "http://clob.polymarket.com/book" }] })], "not a production host"],
    ["an unparseable address", [inspect({ ...INSPECT_OK, requests: [{ url: "::" }] })], "not a production host"],
    ["a host in a failed call", [inspect(), inspect({ contract: "e", error: { category: "upstream_unavailable", retryable: true, details: { url: "https://clob.example/x" } } }, { marketId: "1", levels: 3 })], "not a production host"],
    ["a result not labelled live", [inspect({ ...INSPECT_OK, source: "stored" })], "has source stored"],
    ["another build of the server", [inspect({ ...INSPECT_OK, appVersion: "0.6.0" })], "app version 0.6.0"],
    ["a result that cannot be read", [inspect("summary only")], "cannot be checked"],
    ["a call with no result", [inspect(undefined), { name: tool("inspect_market"), input: { marketId: "1", levels: 1 } }], "has no result"],
    ["synthetic rows in stored data", [inspect(), { ...history({ ...liveHeader, source: "stored", rows: [{ sourceType: "synthetic" }] }), isError: false }], "returned synthetic data"],
    ["a request for synthetic data", [inspect(), history(MISSING_DB, { marketId: "1", includeSynthetic: true })], "asked for synthetic data"],
    ["another market", [inspect(), history(MISSING_DB, { marketId: "2" })], "asked for market 2"],
    ["no successful inspection", [history()], "no live inspection"],
    ["a server with another limit", [inspect({ ...INSPECT_OK, budget: { process: { limit: 200, used: 4 } } })], "request limit is 200"],
    ["attempts above the ceiling", [inspect({ ...INSPECT_OK, budget: { process: { limit: 16, used: 17 } } })], "above the ceiling"],
    ["a built-in tool", [inspect(), { name: "Bash", input: { command: "x" }, result: "no" }], "outside the five tools"],
    ["another server's tool", [inspect(), { name: "mcp__other__x", result: "no" }], "outside the five tools"],
    ["an invented MarketMind tool", [inspect(), { name: tool("place_order"), result: "no" }], "outside the five tools"],
    ["a main-session call", [inspect(), { ...history(), scope: "main" }], "main session called"],
    ["a scan in a one-market investigation", [inspect(), { name: tool("scan_markets"), input: {}, result: { ...INSPECT_OK, requests: [] } }], "scan_markets was called"],
    ["an identical repeat", [inspect(), inspect()], "repeated identical call"],
    ["more calls than the budget", [inspect(), ...Array.from({ length: 7 }, (_, n) => ({ name: tool("get_observation_details"), input: { observationId: n }, result: MISSING_DB, isError: true }))], "above the budget"],
  ])("rejects %s", (_, steps, expected) => {
    expect(noProblem(steps).join(" | ")).toContain(expected);
  });

  it.each<[string, string, string]>([
    ["no report", "", "lacks section"],
    ["a missing section", report("1").replace("## 9. Section", "## Nine"), "lacks section 9"],
    ["no label", report("1").replace("Label: INSUFFICIENT_EVIDENCE", "Label: none"), "research labels"],
    ["two labels", report("1").replace("Label: INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE or WEAK_OR_MISLEADING_SIGNAL"), "2 research labels"],
    ["a report on another market", report("2"), "headed market 2"],
  ])("rejects a report with %s", (_, text, expected) => {
    expect(noProblem([inspect(), history()], text).join(" | ")).toContain(expected);
  });

  it("rejects a session whose investigator never started, or that ended in error", () => {
    const stream = (result: unknown) => parseTrace([{ type: "system", subtype: "init", tools: [] }, result].map((l) => JSON.stringify(l)).join("\n"));
    const problems = liveProblems(stream({ type: "result", subtype: "error_max_budget_usd", is_error: true, modelUsage: {} }), "1").join(" | ");
    expect(problems).toContain("did not start");
    expect(problems).toContain("ended in error");
  });

  it("counts the server's attempts, and says when a failed call makes the count a lower bound", () => {
    expect(requestCount(traceOf([inspect()]).calls)).toEqual({ ceiling: 16, serverLimit: 16, attempts: 4, exact: true });
    expect(requestCount(traceOf([inspect(), inspect(UPSTREAM, { marketId: "1", levels: 1 })]).calls)).toEqual({ ceiling: 16, serverLimit: 16, attempts: 6, exact: false });
    expect(requestCount(traceOf([history()]).calls)).toEqual({ ceiling: 16, serverLimit: null, attempts: 0, exact: true });
  });

  it("reports the source of each kind of evidence from the tool results, not from the report", () => {
    const e = evidenceSummary(traceOf([inspect(), history()]).calls, "[FACT E1] a\n[CALC E1] b\n[CALC E1] c\n[INTERPRETATION] d\n[UNKNOWN] e");
    expect(e.liveObservation).toBe("ok at 2026-11-01T02:12:29.536Z");
    expect(e.storedHistory).toContain("no local database exists");
    expect(e.tags).toEqual({ fact: 1, calculated: 2, interpretation: 1, unknown: 1 });
    const empty = { ...liveHeader, source: "stored", status: "no_history" };
    expect(evidenceSummary(traceOf([{ ...history(empty), isError: false }]).calls, "").storedHistory).toContain("holds no observation");
    expect(evidenceSummary(traceOf([]).calls, "").liveObservation).toContain("no live inspection");
    expect(evidenceSummary(traceOf([inspect(UPSTREAM)]).calls, "").liveObservation).toBe("failed: upstream_unavailable");
  });

  const stored = (result: unknown): Step => ({ ...history(result), isError: false });
  const noResult: Step = { name: tool("get_market_history"), input: { marketId: "1", limit: 10 } };
  const OUTCOMES: [string, Step, string][] = [
    ["a valid result", stored(STORED_OK), "ok at 2026-11-01T02:12:29.536Z"],
    ["no observations", stored({ ...STORED_OK, status: "no_history" }), "none: the database holds no observation of this market"],
    ["no database", history(), "none: no local database exists, so stored history is unknown"],
    ["a rejected output schema", history(VALIDATION_FAILURE), "failed: tool or output validation error"],
    ["an error in the MarketMind contract", history({ ...MISSING_DB, error: { category: "storage_error" } }), "failed: storage_error"],
    ["an error with no category", history({ error: {} }), "failed: unrecognized error"],
    ["a call with no result", noResult, "failed: no tool result"],
    ["a success that is not JSON", stored("summary only"), "failed: unreadable tool result"],
    ["a success with no status", stored({ source: "stored" }), "failed: unreadable tool result"],
  ];

  it.each(OUTCOMES)("stored history is reported for %s, and the header never shows malformed provenance", (_, step, expected) => {
    const storedHistory = evidenceSummary(traceOf([inspect(), step]).calls, "").storedHistory;
    expect(storedHistory).toBe(expected);
    expect(renderLiveReport({ ...RECORD, evidence: { ...RECORD.evidence, storedHistory } }, "")).toContain(`| Stored historical observations | Local database, read only | ${expected} |`);
  });

  it("says when stored history was never read, and treats a failed inspection the same way", () => {
    expect(evidenceSummary(traceOf([inspect()]).calls, "").storedHistory).toBe("none: stored history was not read");
    expect(evidenceSummary(traceOf([{ ...inspect(VALIDATION_FAILURE), isError: true }]).calls, "").liveObservation).toBe("failed: tool or output validation error");
  });

  it("a status of no_history in an error result is a failure, not an empty history", () => {
    expect(evidenceSummary(traceOf([history({ status: "no_history" })]).calls, "").storedHistory).toBe("failed: tool or output validation error");
  });

  it("fails the run when history could not be read, but not when there is none to read", () => {
    expect(noProblem([inspect(), stored(STORED_OK)])).toEqual([]);
    expect(noProblem([inspect(), stored({ ...STORED_OK, status: "no_history" })])).toEqual([]);
    expect(noProblem([inspect(), history()])).toEqual([]);
    expect(noProblem([inspect(), history(VALIDATION_FAILURE)]).join(" | ")).toContain("stored history could not be retrieved: tool or output validation error");
    expect(noProblem([inspect(), history({ ...MISSING_DB, error: { category: "storage_error" } })])).toEqual(["stored history could not be retrieved: storage_error"]);
    expect(noProblem([inspect(), stored({ source: "stored" })]).join(" | ")).toContain("stored history could not be retrieved: unreadable tool result");
  });

  it("judges history by its last call, so a corrected call passes and a later failure does not", () => {
    const bad = history({ ...MISSING_DB, error: { category: "invalid_arguments" } }, { marketId: "1", limit: 99 });
    expect(noProblem([inspect(), bad, stored(STORED_OK)])).toEqual([]);
    expect(noProblem([inspect(), stored(STORED_OK), bad])).toEqual(["stored history could not be retrieved: invalid_arguments"]);
  });
});

const RECORD: LiveRecord = {
  contract: "marketmind.live-run/1",
  source: "live",
  marketId: "1",
  executedAt: "2026-11-01T00:00:00.000Z",
  durationMs: 1,
  exitCode: 0,
  timedOut: false,
  stopReason: null,
  model: { investigator: ["claude-sonnet-5-5"], session: "m" },
  auth: { mode: "subscription", cliVersion: "2.1.302", preflight: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", apiKeySource: null, subscriptionType: "pro" }, initApiKeySource: "none", rateLimitEventSeen: true, overageUsed: false },
  application: { appVersion: APP_VERSION, policy: { policyVersion: "policy-v2", gitCommit: "abc" } as LiveRecord["application"]["policy"] },
  server: { script: "bin/marketmind-mcp.mjs", liveOnly: true, launcherReports: 1, envKeys: [] },
  tools: { total: 2, byName: { inspect_market: 1, get_market_history: 1 }, failed: 1 },
  requests: { ceiling: 16, serverLimit: 16, attempts: 4, exact: true },
  usage: { estimatedUsd: 0.05, basis: "estimate", byModel: {} },
  evidence: { liveObservation: "ok at t", storedHistory: "none: no local database exists, so stored history is unknown", tags: { fact: 3, calculated: 2, interpretation: 1, unknown: 4 } },
  report: { label: "INSUFFICIENT_EVIDENCE", sections: 10, structurallyValid: true, note: "A valid structure and label show the report is well formed, not that it is accurate." },
  integrity: { repoUnchanged: true, databaseUnchanged: true, databasePresent: false, projectUnchanged: true },
  processCleanup: { orphansFound: 0, orphansKilled: 0 },
  flags: [],
  problems: [],
  passed: true,
};

describe("the report", () => {
  it("separates live, stored, derived, interpreted and unknown evidence, and records the run", () => {
    const md = renderLiveReport(RECORD, report("1"));
    for (const s of ["Live order-book observations", "Stored historical observations", "no local database exists", "Facts and derived metrics", "Agent interpretations", "Unknown information", "Not a trading recommendation", "not that it is accurate", "claude-sonnet-5-5", "subscription, Claude Code 2.1.302", "policy-v2", "commit abc", "inspect_market 1", "4 of a ceiling of 16", "$0.0500 (estimate, not billing)"]) expect(md).toContain(s);
    expect(md).toContain("# Market investigation: 1");
  });

  it("puts failed checks first, and marks a lower bound and missing values", () => {
    const md = renderLiveReport({ ...RECORD, passed: false, problems: ["the database | changed"], requests: { ...RECORD.requests, exact: false }, usage: { ...RECORD.usage, estimatedUsd: null } }, "");
    expect(md.indexOf("RUN CHECKS FAILED")).toBeLessThan(md.indexOf("| Run |"));
    expect(md).toContain("the database \\| changed");
    expect(md).toContain("at least 4 of a ceiling");
    expect(md).toContain("| Estimated model usage | unknown |");
    expect(md).toContain("(The investigator returned no report.)");
  });

  it("redacts keys, tokens, emails and local paths", () => {
    const out = scrub(`${FAKE_KEY} Bearer abcdefghijklmnop0123 owner@example.com ${join(homedir(), "x")} ${join(tmpdir(), "y")}`);
    expect(out).not.toMatch(/FAKE|abcdefghijklmnop|example\.com/);
    expect(out).not.toContain(homedir());
    expect(out).not.toContain(tmpdir());
  });
});

describe("the server settings", () => {
  it("are read by the server, and an invalid live-only value stops it", () => {
    expect(mcpSettings(SERVER_SETTINGS)).toMatchObject({ processRequestLimit: 16, liveOnly: true });
    expect(mcpSettings({}).liveOnly).toBe(false);
    expect(() => mcpSettings({ MARKETMIND_LIVE_ONLY: "true" })).toThrow(MarketMindError);
  });

  it("the ceiling holds on the real server process, across tools and retries, counted outside the server", async () => {
    let connections = 0;
    const upstream = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = (upstream.address() as { port: number }).port;
    const url = `https://127.0.0.1:${port}`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_LAUNCHER, BIN_SERVER],
      env: { ...getDefaultEnvironment(), ...SERVER_SETTINGS, MARKETMIND_GAMMA_URL: url, MARKETMIND_CLOB_URL: url, MARKETMIND_DB: join(temp(), "absent.sqlite") },
      cwd: temp(),
      stderr: "pipe",
    });
    const client = new Client({ name: "ceiling-test", version: "0.0.0" });
    await client.connect(transport);
    type Result = { isError?: boolean; content: { text?: string }[]; structuredContent?: { budget?: { process: { limit: number } } } };
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
    const category = (r: Result) => (r.isError ? (JSON.parse(r.content[0]!.text!) as { error: { category: string; code: string } }).error : null);
    try {
      // Each failing inspection retries once, so it spends 2 of the 8 attempts it reserves.
      for (let i = 0; i < 5; i++) expect(category(await call("inspect_market", { marketId: String(i + 1) }))?.category).toBe("upstream_unavailable");
      expect(connections).toBe(10);
      expect(category(await call("inspect_market", { marketId: "6" }))).toMatchObject({ category: "budget_exhausted", code: "PROCESS_BUDGET_EXHAUSTED" });
      expect(connections).toBe(10);
      // What is left goes to scans, which share the same ceiling and retry too.
      while (connections < 16) await call("scan_markets", { version: "v1", maxRequests: 16 - connections });
      expect(connections).toBe(16);
      expect(category(await call("scan_markets", { version: "v1", maxRequests: 1 }))).toMatchObject({ category: "budget_exhausted", code: "PROCESS_BUDGET_EXHAUSTED" });
      expect(category(await call("inspect_market", { marketId: "7" }))?.category).toBe("budget_exhausted");
      expect(connections).toBe(16);
    } finally {
      await client.close();
      await new Promise((r) => upstream.close(r));
    }
  });

  describe("live-only mode on the real server, over a database holding synthetic runs", () => {
    const seeded = () => {
      const db = join(temp(), "seeded.sqlite");
      seedEvalDb(db);
      return db;
    };
    const connect = async (db: string, liveOnly: boolean) => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_LAUNCHER, BIN_SERVER], env: { ...getDefaultEnvironment(), MARKETMIND_DB: db, ...(liveOnly ? SERVER_SETTINGS : {}) }, cwd: temp(), stderr: "pipe" });
      const client = new Client({ name: "live-only-test", version: "0.0.0" });
      await client.connect(transport);
      return client;
    };
    type Row = { result: { isError?: boolean; content: { text: string }[]; structuredContent: { runs: { items: { sourceType: string }[] }; history: { rows: { observationId: number }[] }; observations: { items: { observationId: number }[] } } } };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => ({ result: await client.callTool({ name, arguments: args }) }) as Row;

    it("control: without it the server shows synthetic data", async () => {
      const client = await connect(seeded(), false);
      try {
        const runs = await call(client, "list_collection_runs", { limit: 50 });
        expect(JSON.stringify(runs.result.structuredContent)).toContain('"sourceType":"synthetic"');
        const history = await call(client, "get_market_history", { marketId: "900103", includeSynthetic: true });
        expect(history.result.isError).toBeFalsy();
        expect(JSON.stringify(history.result.structuredContent)).toContain('"sourceType":"synthetic"');
        const details = await call(client, "get_observation_details", { observationId: 1 });
        expect(details.result.isError).toBeFalsy();
      } finally {
        await client.close();
      }
    });

    it("with it, a model cannot reach synthetic data: not by argument, not by observation id, not in the run list", async () => {
      const client = await connect(seeded(), true);
      try {
        const history = await call(client, "get_market_history", { marketId: "900103", includeSynthetic: true });
        expect(history.result.isError).toBe(true);
        expect(history.result.content[0]!.text).toContain("invalid_arguments");
        const details = await call(client, "get_observation_details", { observationId: 1 });
        expect(details.result.isError).toBe(true);
        expect(details.result.content[0]!.text).toContain("observation_not_found");
        const runs = await call(client, "list_collection_runs", { limit: 50 });
        expect(JSON.stringify(runs.result.structuredContent)).not.toContain('"sourceType":"synthetic"');
        expect((await call(client, "get_market_history", { marketId: "900103" })).result.structuredContent).toMatchObject({ status: "no_history" });
      } finally {
        await client.close();
      }
    });
  });
});

const PASSED: Preflight = { mode: "subscription", cliVersion: "2.1.302", evidence: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", apiKeySource: null, subscriptionType: "pro" }, problems: [], passed: true };

/** Deps that never start anything real, for the runner's own behaviour. `child` is a Node script standing in for the CLI. */
function fakeDeps(over: Partial<LiveDeps> & { child?: string } = {}): { deps: LiveDeps; lines: string[]; spawned: { args: string[]; cwd: string; env: Record<string, string> }[]; out: string; options: LiveOptions; root: string } {
  const root = temp();
  const out = join(root, "live", "run");
  const lines: string[] = [];
  const spawned: { args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const db = over.dbPath ?? join(root, "absent.sqlite");
  const { child = "", ...rest } = over;
  const deps: LiveDeps = {
    parentEnv: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), HOME: root, USERPROFILE: root, ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_AUTH_TOKEN: "FAKE-bearer", CLAUDE_CODE_OAUTH_TOKEN: "FAKE-oauth", MARKETMIND_GAMMA_URL: "https://gamma.example", MARKETMIND_DB: "other.sqlite" },
    gate: () => PASSED,
    treeClean: () => true,
    repoState: () => "same",
    spawn: (args, o) => {
      spawned.push({ args, ...o });
      return spawn(process.execPath, ["-e", child, "--", ...args], { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    },
    serverScript: BIN_SERVER,
    dbPath: db,
    log: (l) => lines.push(l),
    ...rest,
  };
  return { deps, lines, spawned, out, root, options: { marketId: "1", prompt: "/investigate-market 1", maxBudgetUsd: 0.4, timeoutMs: 30_000, out, check: false } };
}
const artifact = (out: string) => JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as LiveRecord;
const INIT = (over: object = {}) => JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none", permissionMode: "default", tools: ["scan_markets", "inspect_market", "list_collection_runs", "get_market_history", "get_observation_details"].map(tool), agents: [], skills: [], plugins: [], mcp_servers: [{ name: "marketmind" }], ...over });

describe("the runner", () => {
  it("in production uses the real server and the normal database path, and never the fixture server", () => {
    const deps = realLiveDeps();
    expect(deps.serverScript).toBe(BIN_SERVER);
    expect(deps.dbPath).toBe(join(REPO, "data", "marketmind.sqlite"));
    const source = readFileSync(join(REPO, "test-agent", "live.ts"), "utf8");
    for (const banned of ["scenario-mcp", "seedEvalDb", "fixtures.js", "evaluateDir", "bypassPermissions"]) expect(source).not.toContain(banned);
  });

  it("--check runs the gate and prints the configuration, with no session and no artifact", async () => {
    const t = fakeDeps();
    expect(await runLive({ ...t.options, check: true }, t.deps)).toBe(0);
    expect(t.spawned).toEqual([]);
    expect(existsSync(t.out)).toBe(false);
    const printed = JSON.parse(t.lines[0]!) as Record<string, unknown>;
    expect(printed).toMatchObject({ marketId: "1", server: "bin/marketmind-mcp.mjs", serverSettings: { MARKETMIND_MCP_MAX_REQUESTS: "16", MARKETMIND_LIVE_ONLY: "1" }, policy: "policy-v2", wouldRun: true });
    expect(String(printed.database)).toContain("missing");
    expect(t.lines.join()).not.toContain(FAKE_KEY);
  });

  it.each<[string, Partial<LiveDeps>, string]>([
    ["a failed gate", { gate: () => ({ ...PASSED, passed: false, problems: ["credential is api_key, not a claude.ai login"] }) }, "not a claude.ai login"],
    ["uncommitted changes", { treeClean: () => false }, "uncommitted changes"],
  ])("%s starts nothing and writes nothing, and --check says so", async (_, over, expected) => {
    const t = fakeDeps(over);
    expect(await runLive(t.options, t.deps)).toBe(1);
    expect(t.lines.join()).toContain(expected);
    expect(t.spawned).toEqual([]);
    expect(existsSync(t.out)).toBe(false);
    expect(await runLive({ ...t.options, check: true }, t.deps)).toBe(1);
    expect(t.lines.at(-1)).toContain('"wouldRun": false');
  });

  it("the spawned CLI gets no credential or MarketMind variable, and the five-tool flags; the server gets only its settings", async () => {
    const t = fakeDeps();
    await runLive(t.options, t.deps);
    const { args, env } = t.spawned[0]!;
    expect(Object.keys(env).filter((k) => /ANTHROPIC|OAUTH|TOKEN|MARKETMIND/.test(k))).toEqual([]);
    expect(env.USERPROFILE).toBe(t.root);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(args[1]).toBe("/investigate-market 1");
  });

  it("never overwrites: a directory that appears after parsing stops the run before the session", async () => {
    const t = fakeDeps();
    mkdirSync(t.out, { recursive: true });
    await expect(runLive(t.options, t.deps)).rejects.toThrow(/never overwritten/);
    expect(t.spawned).toEqual([]);
  });

  it("a timeout kills the process tree, keeps what arrived, removes the temp project and fails", async () => {
    const t = fakeDeps({ child: `console.log(${JSON.stringify(INIT())}); setTimeout(() => {}, 60000);` });
    const code = await runLive({ ...t.options, timeoutMs: 1500 }, t.deps);
    expect(code).toBe(1);
    const r = artifact(t.out);
    expect(r).toMatchObject({ timedOut: true, passed: false });
    expect(r.problems[0]).toContain("timed out after 1500 ms");
    expect(readFileSync(join(t.out, "trace.jsonl"), "utf8")).toContain('"init"');
    expect(readFileSync(join(t.out, "report.md"), "utf8")).toContain("RUN CHECKS FAILED");
    expect(existsSync(t.spawned[0]!.cwd)).toBe(false);
  });

  it.each<[string, object, string]>([
    ["an API key at init", { apiKeySource: "ANTHROPIC_API_KEY" }, "not on the subscription login"],
    ["Bash in the session", { tools: ["Bash"] }, "tool pool"],
    ["an elevated mode", { permissionMode: "bypassPermissions" }, "permission mode"],
  ])("%s stops the session at once", async (_, init, expected) => {
    const t = fakeDeps({ child: `console.log(${JSON.stringify(INIT(init))}); setTimeout(() => {}, 60000);` });
    const started = Date.now();
    expect(await runLive(t.options, t.deps)).toBe(1);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(artifact(t.out).stopReason).toContain(expected);
    expect(artifact(t.out).timedOut).toBe(false);
  });

  it("extra usage stops the session at once", async () => {
    const overage = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { isUsingOverage: true } });
    const t = fakeDeps({ child: `console.log(${JSON.stringify(INIT())}); console.log(${JSON.stringify(overage)}); setTimeout(() => {}, 60000);` });
    expect(await runLive(t.options, t.deps)).toBe(1);
    expect(artifact(t.out).auth.overageUsed).toBe(true);
    expect(artifact(t.out).stopReason).toContain("extra usage");
  });

  it("a second MCP server stops the session, because it would bring a ceiling of its own", async () => {
    const line = JSON.stringify({ contract: "marketmind.mcp-launcher/1", launcherPid: 1, serverPid: 2, receivedEnvKeys: [], serverEnvKeys: [], anthropicKeyReceived: false, credentialKeysReceived: [] });
    const child = `const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config")+1],"utf8"));fs.appendFileSync(c.mcpServers.marketmind.env.MARKETMIND_LAUNCH_REPORT,${JSON.stringify(line + "\n" + line + "\n")});setTimeout(()=>{},60000);`;
    const t = fakeDeps({ child });
    expect(await runLive(t.options, t.deps)).toBe(1);
    expect(artifact(t.out).stopReason).toContain("second MCP server");
    expect(artifact(t.out).problems.join()).toContain("2 MCP servers started");
  });

  it("scrubs text from the session that reaches run.json through a problem", async () => {
    const hostile = [FAKE_KEY, "owner@example.com", join(tmpdir(), "secret-path")];
    const t = fakeDeps({ child: `console.log(${JSON.stringify(INIT({ tools: hostile }))}); setTimeout(() => {}, 60000);` });
    expect(await runLive(t.options, t.deps)).toBe(1);
    const stored = readFileSync(join(t.out, "run.json"), "utf8");
    expect(artifact(t.out).stopReason).toContain("<redacted:key>");
    for (const banned of ["sk-ant-", "owner@example.com", "secret-path"]) expect(stored, banned).not.toContain(banned === "secret-path" ? join(tmpdir(), banned) : banned);
    expect(t.lines.join()).not.toContain("sk-ant-");
  });

  it("fails if the launcher left no report, so credential isolation is unconfirmed", async () => {
    const t = fakeDeps();
    expect(await runLive(t.options, t.deps)).toBe(1);
    expect(artifact(t.out).problems.join(" | ")).toContain("left no report");
  });

  it("fails if a credential or unexpected variable reached the server", async () => {
    const keys = ["PATH", ...Object.keys(SERVER_SETTINGS), "ANTHROPIC_API_KEY"];
    const line = JSON.stringify({ contract: "marketmind.mcp-launcher/1", launcherPid: 1, serverPid: 2, receivedEnvKeys: keys, serverEnvKeys: keys, anthropicKeyReceived: true, credentialKeysReceived: ["ANTHROPIC_API_KEY"] });
    const t = fakeDeps({ child: `const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config")+1],"utf8"));fs.appendFileSync(c.mcpServers.marketmind.env.MARKETMIND_LAUNCH_REPORT,${JSON.stringify(line + "\n")});` });
    expect(await runLive(t.options, t.deps)).toBe(1);
    expect(artifact(t.out).problems.join(" | ")).toContain("unexpected variables: ANTHROPIC_API_KEY");
  });

  describe("the exit status", () => {
    /** A whole session by a stand-in CLI that passes every check unless a step or its own exit code says otherwise. */
    const session = (steps: Step[], exitCode: number) => {
      const keys = ["PATH", "MARKETMIND_DB", ...Object.keys(SERVER_SETTINGS)];
      const launcher = JSON.stringify({ contract: "marketmind.mcp-launcher/1", launcherPid: 1, serverPid: 2, receivedEnvKeys: keys, serverEnvKeys: keys, anthropicKeyReceived: false, credentialKeysReceived: [] });
      const lines = streamOf(steps, report("1"), JSON.parse(INIT()));
      return fakeDeps({ child: `const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config")+1],"utf8"));fs.appendFileSync(c.mcpServers.marketmind.env.MARKETMIND_LAUNCH_REPORT,${JSON.stringify(`${launcher}\n`)});fs.writeSync(1,${JSON.stringify(`${lines.join("\n")}\n`)});process.exitCode=${exitCode};` });
    };
    const GOOD = [inspect(), { ...history(STORED_OK), isError: false }];
    const FAILED = [inspect(), history(VALIDATION_FAILURE)];

    it("is 0 for a session that passes every check", async () => {
      const t = session(GOOD, 0);
      expect(await runLive(t.options, t.deps)).toBe(0);
      expect(artifact(t.out)).toMatchObject({ passed: true, problems: [], exitCode: 0 });
      expect(artifact(t.out).evidence.storedHistory).toBe("ok at 2026-11-01T02:12:29.536Z");
    });

    it.each([0, 3])("is 1 when history failed validation and the Claude process exited %i", async (code) => {
      const t = session(FAILED, code);
      expect(await runLive(t.options, t.deps)).toBe(1);
      const r = artifact(t.out);
      expect(r).toMatchObject({ passed: false, exitCode: code });
      expect(r.problems).toContain("stored history could not be retrieved: tool or output validation error");
      expect(r.evidence.storedHistory).toBe("failed: tool or output validation error");
      const md = readFileSync(join(t.out, "report.md"), "utf8");
      expect(md).toContain("RUN CHECKS FAILED");
      expect(md).toContain("| Local database, read only | failed: tool or output validation error |");
      expect(md).not.toContain("undefined");
    });

    it("is 1 when the Claude process failed, even if every check passed", async () => {
      const t = session(GOOD, 3);
      expect(await runLive(t.options, t.deps)).toBe(1);
      expect(artifact(t.out).problems).toEqual(["the Claude process exited with code 3"]);
    });

    it("reaches the operating system: the command sets the status the runner returned", () => {
      const noClaude = (dir: string) => !["claude", "claude.exe", "claude.cmd"].some((f) => existsSync(join(dir, f)));
      const path = (process.env.PATH ?? "").split(delimiter).filter(noClaude).join(delimiter);
      const out = ".live-out/exit-status-test";
      // With no CLI to find the gate refuses, so no session starts and no credential is read.
      const r = spawnSync(process.execPath, ["--import", "tsx", "test-agent/live.ts", ...BASE.slice(0, 6), "--out", out], { cwd: REPO, env: { ...getDefaultEnvironment(), PATH: path, Path: path }, encoding: "utf8", timeout: 60_000 });
      expect(r.stdout).toContain("not started");
      expect(r.status).toBe(1);
      expect(existsSync(join(REPO, out))).toBe(false);
    });
  });

  it("fails on a changed database, repository or temp project, and on a server that did not get its settings", async () => {
    const root = temp();
    const db = join(root, "local.sqlite");
    writeFileSync(db, "before");
    let state = 0;
    const child = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(db)},"after");fs.writeFileSync("added.txt","x");const c=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config")+1],"utf8"));fs.appendFileSync(c.mcpServers.marketmind.env.MARKETMIND_LAUNCH_REPORT,${JSON.stringify(JSON.stringify({ contract: "marketmind.mcp-launcher/1", launcherPid: 1, serverPid: 2, receivedEnvKeys: [], serverEnvKeys: ["PATH"], anthropicKeyReceived: false, credentialKeysReceived: [] }) + "\n")});`;
    const t = fakeDeps({ dbPath: db, repoState: () => String(state++), child });
    expect(await runLive(t.options, t.deps)).toBe(1);
    const r = artifact(t.out);
    expect(r.integrity).toEqual({ repoUnchanged: false, databaseUnchanged: false, databasePresent: true, projectUnchanged: false });
    for (const p of ["the repository changed", "the database changed", "temporary project changed", "did not receive MARKETMIND_MCP_MAX_REQUESTS", "did not receive MARKETMIND_LIVE_ONLY"]) expect(r.problems.join(" | ")).toContain(p);
  });
});

/** The real pinned CLI, the real launcher and the given server, against the stub. */
async function realSession(script: object, serverScript: string, over: Partial<LiveDeps> = {}): Promise<{ code: number; run: LiveRecord; out: string; md: string; requests: { session: string; tools: string[] }[]; root: string; lines: string[] }> {
  const root = temp("mm-liveboundary-");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), FAKE_LOGIN);
  const log = join(root, "stub.log");
  const portFile = join(root, "port");
  const stub = spawn(process.execPath, [join(REPO, "test", "stubApi.mjs"), log, portFile, JSON.stringify(script)], { stdio: "ignore" });
  try {
    for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 25));
    const out = join(root, "live", "run");
    const lines: string[] = [];
    let child: ChildProcess;
    const deps: LiveDeps = {
      parentEnv: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_AUTH_TOKEN: "FAKE-bearer-000000" },
      gate: () => PASSED,
      treeClean: () => true,
      repoState: () => "same",
      spawn: (args, o) => {
        child = spawn(BINARY, args, { ...o, env: { ...o.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${readFileSync(portFile, "utf8")}`, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        return child;
      },
      serverScript,
      dbPath: join(root, "absent.sqlite"),
      log: (l) => lines.push(l),
      ...over,
    };
    const code = await runLive({ marketId: "900103", prompt: "/investigate-market 900103", maxBudgetUsd: 0.4, timeoutMs: 60_000, out, check: false }, deps);
    const requests = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { session: string; tools: string[] });
    return { code, run: artifact(out), out, md: readFileSync(join(out, "report.md"), "utf8"), requests, root, lines };
  } finally {
    stub.kill();
  }
}
const HISTORY = { name: tool("get_market_history"), input: { marketId: "900103", limit: 10 } };

describe.skipIf(!HAVE_CLI)("a session on the pinned CLI", () => {
  it("the real server with no database: the session runs, history is reported as missing, and nothing is created", async () => {
    const s = await realSession({ investigator: [HISTORY, { name: tool("list_collection_runs"), input: { limit: 10 } }], report: report() }, BIN_SERVER);
    expect(s.run.server).toMatchObject({ script: "bin/marketmind-mcp.mjs", launcherReports: 1 });
    expect(s.run.server.envKeys).toEqual(expect.arrayContaining(["MARKETMIND_MCP_MAX_REQUESTS", "MARKETMIND_LIVE_ONLY", "MARKETMIND_DB"]));
    expect(s.run.server.envKeys.filter((k) => /ANTHROPIC|TOKEN|KEY|HOME|PROFILE|CLAUDE/.test(k))).toEqual([]);
    expect(s.run.evidence.storedHistory).toContain("no local database exists");
    expect(s.md).toContain("no local database exists");
    expect(s.run.integrity).toMatchObject({ databasePresent: false, databaseUnchanged: true, projectUnchanged: true });
    expect(existsSync(join(s.root, "absent.sqlite"))).toBe(false);
    expect(s.run.tools).toEqual({ total: 2, byName: { get_market_history: 1, list_collection_runs: 1 }, failed: 2 });
    expect(s.run.requests).toEqual({ ceiling: 16, serverLimit: null, attempts: 0, exact: true });
    expect(s.run.report).toMatchObject({ label: "INSUFFICIENT_EVIDENCE", sections: 10, structurallyValid: true });
    expect(s.run.auth).toMatchObject({ mode: "subscription", cliVersion: "2.1.302", initApiKeySource: "none" });
    expect(s.run.model.investigator.join()).toContain("sonnet");
    // No inspection ran, because offline tests never reach Polymarket, so the run correctly does not pass.
    expect(s.run.problems).toEqual(["no live inspection of the market succeeded"]);
    expect(s.code).toBe(1);
  });

  it("offers exactly the five tools, and the stored artifacts hold no credential, account data or local path", async () => {
    const s = await realSession({ investigator: [HISTORY], report: `${report()}\n\nFAKE ${FAKE_KEY} owner@example.com ${tmpdir()}` }, BIN_SERVER);
    for (const r of s.requests) expect(r.tools).toHaveLength(5);
    expect(new Set(s.requests.map((r) => r.session))).toEqual(new Set(["investigator"]));
    const sanitized = readFileSync(join(s.out, "run.json"), "utf8") + s.md;
    for (const banned of ["sk-ant-", "FAKE-bearer", "owner@example.com", "accessToken", "refreshToken", "orgId", s.root, "USERPROFILE"]) expect(sanitized, banned).not.toContain(banned);
    expect(readdirSync(s.out).sort()).toEqual(["report.md", "run.json", "stderr.txt", "trace.jsonl"]);
  });

  it("the fixture server cannot pass as live, though every result it gives says source: live", async () => {
    const s = await realSession({ investigator: [{ name: tool("inspect_market"), input: { marketId: "900103" } }], report: report() }, FIXTURE_SERVER);
    expect(s.run.tools.failed).toBe(0);
    expect(s.run.passed).toBe(false);
    expect(s.run.problems.join(" | ")).toContain("gamma.example");
    expect(s.md).toContain("RUN CHECKS FAILED");
  });

  it("a call to a removed tool fails the run and writes nothing", async () => {
    const s = await realSession({ investigator: [{ name: "Bash", input: { command: "echo PWNED > pwned.txt" } }, { name: "Write", input: { file_path: "pwned.txt", content: "x" } }], report: report() }, BIN_SERVER);
    expect(s.run.problems.join(" | ")).toContain("outside the five tools: Bash, Write");
    expect(s.run.integrity.projectUnchanged).toBe(true);
  });

  it("a report with the wrong structure fails the run", async () => {
    const s = await realSession({ investigator: [HISTORY], report: "not a report" }, BIN_SERVER);
    expect(s.run.report).toMatchObject({ label: null, structurallyValid: false });
    expect(s.run.problems.join(" | ")).toContain("lacks section");
  });
});
