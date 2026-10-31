import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../agent-sdk/args.js";
import { InvestigationResult, ExecutionRecord } from "../../agent-sdk/contract.js";
import { MARKETMIND_TOOLS } from "../../agent-sdk/guard.js";
import { loadInvestigator } from "../../agent-sdk/investigator.js";
import { optionViolations, runInvestigation, statusOfResult, type SessionDeps } from "../../agent-sdk/session.js";
import { asChild, FakeChild, fakeQuery, type FakeScript } from "../sdkFakes.js";

// Stage 2.6: the SDK session state machine, driven by a fake query (no SDK runtime, no model, no network).

const KEY = "sk-ant-api03-SENTINEL-not-a-real-key-0123456789";
const investigator = loadInvestigator();
const REPORT = "# Market investigation: 900103\n\n## 7. Research classification\n- Label: INSUFFICIENT_EVIDENCE.\n";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Harness {
  deps: SessionDeps;
  children: FakeChild[];
  killed: number[];
  progress: string[];
  removed: { value: boolean };
}
function harness(over: Partial<SessionDeps> & { env?: Record<string, string | undefined>; unkillable?: boolean; orphans?: number[][]; removeFails?: boolean } = {}): Harness {
  const children: FakeChild[] = [];
  const killed: number[] = [];
  const progress: string[] = [];
  const removed = { value: false };
  const orphanSeq = [...(over.orphans ?? [])];
  const deps: SessionDeps = {
    query: over.query ?? fakeQuery({}).query,
    parentEnv: over.env ?? { ANTHROPIC_API_KEY: KEY, PATH: "/usr/bin" },
    isolation() {
      const root = mkdtempSync(join(tmpdir(), "mm-sdk-test-"));
      roots.push(root);
      const cwd = join(root, "cwd");
      const home = join(root, "home");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(home, { recursive: true });
      return {
        cwd,
        home,
        remove: () => {
          if (over.removeFails) throw new Error(`EBUSY: resource busy ${root}`);
          rmSync(root, { recursive: true, force: true });
          removed.value = true;
        },
      };
    },
    seedFixture(dir) {
      const p = join(dir, "fixture.sqlite");
      writeFileSync(p, "fixture");
      return p;
    },
    spawn() {
      const c = new FakeChild();
      children.push(c);
      return asChild(c);
    },
    processesTagged: () => orphanSeq.shift() ?? [],
    killTree(pid) {
      killed.push(pid);
      if (!over.unkillable) for (const c of children) if (c.pid === pid) c.kill();
    },
    hashFile: (p) => (existsSync(p) ? "a".repeat(64) : null),
    repoState: () => "b".repeat(64),
    databasePath: (_r, db) => db,
    tag: () => "mm-sdk-test-tag",
    onProgress: (p) => progress.push(p.text),
    ...over,
  };
  return { deps, children, killed, progress, removed };
}
const request = (...extra: string[]) => parseArgs(["investigate", "--market-id", "900103", "--fixture", "S03", "--max-budget-usd", "0.25", ...extra]).request;
const run = (h: Harness, cfg: Partial<Parameters<typeof runInvestigation>[0]> = {}) =>
  runInvestigation({ investigator, request: request(), maxBudgetUsd: 0.25, timeoutMs: 20_000, cleanupMs: 200, ...cfg }, h.deps);
const withScript = (s: FakeScript, over: Parameters<typeof harness>[0] = {}) => {
  const f = fakeQuery({ spawn: true, ...s });
  return { ...harness({ query: f.query, ...over }), state: f.state };
};

describe("successful session", () => {
  it("runs pre-flight before releasing the prompt, records calls, and cleans up", async () => {
    const h = withScript({ calls: [{ name: MARKETMIND_TOOLS[1]!, args: { marketId: "900103" } }], report: REPORT });
    const o = await run(h);
    expect(o.result.status).toBe("completed");
    expect(h.state.preflightBeforePrompt).toBe(true);
    expect(h.state.promptReceived).toBe(investigator.renderPrompt(request().arguments));
    expect(o.result.toolCalls).toEqual([{ seq: 0, name: MARKETMIND_TOOLS[1], input: { marketId: "900103" }, outcome: "ok", errorCategory: null, deniedBy: null }]);
    expect(o.result.report.classification).toEqual(["INSUFFICIENT_EVIDENCE"]);
    expect(o.result.usage).toMatchObject({ estimatedCostUsd: 0.0123, costBasis: "list", numTurns: 3 });
    expect(o.result.cleanup).toMatchObject({ closeCalled: true, childExited: true, tempRemoved: true, problems: [] });
    expect(o.result.integrity).toEqual({ database: "unchanged", repository: "unchanged" });
    expect(h.removed.value).toBe(true);
    expect(InvestigationResult.safeParse(o.result).success).toBe(true);
    expect(ExecutionRecord.safeParse(o.record).success).toBe(true);
    expect(o.record.guard.map((d) => [d.decision, d.agentType])).toEqual([["allow", "market-investigator"]]);
    expect(h.progress.some((p) => p.includes("inspect_market"))).toBe(true);
  });

  it("the options handed to the SDK satisfy every security invariant", async () => {
    const h = withScript({ report: REPORT });
    await run(h);
    expect(optionViolations(h.state.options!)).toEqual([]);
  });
});

describe("refusals before anything runs", () => {
  it("missing ANTHROPIC_API_KEY: nothing is created or spawned", async () => {
    const f = fakeQuery({});
    let isolated = false;
    const h = harness({ query: f.query, env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth-should-never-be-used" }, isolation: () => ((isolated = true), { cwd: "", home: "", remove() {} }) });
    const o = await run(h);
    expect(o.result.status).toBe("missing_credentials");
    expect(f.state.options).toBeNull();
    expect(isolated).toBe(false);
    expect(h.children).toHaveLength(0);
    expect(o.result.cleanup.closeCalled).toBe(false);
  });

  it("the SDK rejecting options at query() is invalid_options, and still cleans up", async () => {
    const h = withScript({ throwOnCreate: "Invalid skill name" });
    const o = await run(h);
    expect(o.result.status).toBe("invalid_options");
    expect(o.result.statusDetail).toContain("Invalid skill name");
    expect(o.result.cleanup.tempRemoved).toBe(true);
  });
});

describe("pre-flight gate (no prompt is released)", () => {
  it.each([
    ["claude.ai login (apiKeySource none)", { apiKeySource: "none" }, "auth_source_rejected"],
    ["a /login managed key", { apiKeySource: "/login managed key" }, "auth_source_rejected"],
    ["a third-party provider", { apiProvider: "bedrock" }, "auth_source_rejected"],
    ["MCP server failed", { mcp: [{ name: "marketmind", status: "failed" }] }, "mcp_failed"],
    ["an extra MCP server", { mcp: [{ name: "marketmind", status: "connected", tools: MARKETMIND_TOOLS.map((t) => t.replace("mcp__marketmind__", "")) }, { name: "github", status: "connected", tools: ["create_issue"] }] }, "mcp_failed"],
    ["an extra MarketMind tool", { mcp: [{ name: "marketmind", status: "connected", tools: ["inspect_market", "delete_everything"] }] }, "mcp_failed"],
    ["investigator agent missing", { agents: ["general-purpose"] }, "preflight_failed"],
  ] as [string, FakeScript, string][])("%s", async (_name, script, status) => {
    const h = withScript({ ...script, calls: [{ name: MARKETMIND_TOOLS[1]!, args: {} }], report: REPORT });
    const o = await run(h);
    expect(o.result.status).toBe(status);
    expect(h.state.promptReceived).toBeNull();
    expect(h.state.hookCalls).toEqual([]);
    expect(o.result.cleanup.closeCalled).toBe(true);
  });

  it("an effective tool pool wider than approved at init aborts the session", async () => {
    const h = withScript({ init: { tools: [...MARKETMIND_TOOLS, "Bash"] }, calls: [{ name: "Bash", args: { command: "ls" } }], report: REPORT });
    const o = await run(h);
    expect(o.result.status).toBe("preflight_failed");
    expect(o.result.statusDetail).toContain("Bash");
    expect(h.state.hookCalls).toEqual([]);
  });

  it.each([
    ["permission mode", { permissionMode: "bypassPermissions" }],
    ["auth source", { apiKeySource: "none" }],
    ["skills", { skills: ["investigate-market"] }],
  ] as [string, NonNullable<FakeScript["init"]>][])("an init that differs in %s aborts the session", async (_n, init) => {
    const o = await run(withScript({ init, report: REPORT }));
    expect(o.result.status).toBe("preflight_failed");
  });
});

describe("validation phases and shipped skills (Claude Code 2.1.302 init shapes)", () => {
  // What Batch 1 recorded: skills: [] and plugins: [] alone, with the correct five-tool pool.
  const BUNDLED_SKILLS = ["deep-research", "dataviz", "update-config", "verify", "debug", "code-review", "simplify", "batch", "fewer-permission-prompts", "doctor", "loop", "claude-api", "workflow-authoring", "run", "run-skill-generator", "plugin-authoring"];
  const BUILTIN_PLUGINS = [
    { name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" },
    { name: "cc-plugin-plugin-authoring", path: "builtin", source: "cc-plugin-plugin-authoring@builtin" },
  ];
  // What stays advertised with SESSION_SETTINGS: built-in commands, none of them a skill.
  const BUILT_IN_COMMANDS = ["agents", "clear", "compact", "config", "context", "init", "mcp", "model", "security-review", "usage"];

  it("the Batch 1 init keeps phase 1 and phase 2 apart: passed pre-flight, failed effective session", async () => {
    const h = withScript({ init: { skills: BUNDLED_SKILLS, plugins: BUILTIN_PLUGINS }, calls: [{ name: MARKETMIND_TOOLS[1]!, args: {} }], report: REPORT });
    const o = await run(h);
    expect(o.record.status).toBe("preflight_failed");
    expect(o.record.preflight).toMatchObject({ passed: true, problems: [] });
    expect(o.record.effectiveSession).toEqual({ passed: false, problems: [`skills present: ${BUNDLED_SKILLS.join(", ")}`, "plugins present: cc-plugin-agents-md, cc-plugin-plugin-authoring"] });
    expect(o.record.statusDetail).toContain("first system/init, after the pre-prompt pre-flight passed");
    expect(h.state.hookCalls).toEqual([]);
    expect(ExecutionRecord.safeParse(o.record).success).toBe(true);
  });

  it("a pre-prompt failure leaves the effective session unreached, not passed", async () => {
    const o = await run(withScript({ apiKeySource: "none", report: REPORT }));
    expect(o.record.preflight?.passed).toBe(false);
    expect(o.record.effectiveSession).toBeNull();
  });

  it("no init before the stream ends also leaves it unreached", async () => {
    const o = await run(withScript({ crashAfter: 0 }));
    expect(o.record.status).toBe("error");
    expect(o.record.preflight?.passed).toBe(true);
    expect(o.record.effectiveSession).toBeNull();
  });

  it("the approved init passes both phases, whatever built-in commands stay advertised", async () => {
    const h = withScript({ init: { slashCommands: BUILT_IN_COMMANDS }, report: REPORT });
    const o = await run(h);
    expect(o.record.status).toBe("completed");
    expect(o.record.preflight?.passed).toBe(true);
    expect(o.record.effectiveSession).toEqual({ passed: true, problems: [] });
  });

  it.each([
    ["doctor alone", { skills: ["doctor"] }, "skills present: doctor"],
    ["plugin-authoring alone", { skills: ["plugin-authoring"] }, "skills present: plugin-authoring"],
    ["an arbitrary unexpected skill", { skills: ["exfiltrate"] }, "skills present: exfiltrate"],
    ["a user or project skill", { skills: ["investigate-market"] }, "skills present: investigate-market"],
    ["one built-in plugin", { plugins: [{ name: "cc-plugin-agents-md", path: "builtin" }] }, "plugins present: cc-plugin-agents-md"],
    ["an external plugin", { plugins: [{ name: "third-party", path: "/x" }] }, "plugins present: third-party"],
  ] as [string, NonNullable<FakeScript["init"]>, string][])("no skill or plugin is tolerated: %s", async (_n, init, problem) => {
    const h = withScript({ init, calls: [{ name: MARKETMIND_TOOLS[1]!, args: {} }], report: REPORT });
    const o = await run(h);
    expect(o.record.status).toBe("preflight_failed");
    expect(o.record.effectiveSession?.problems).toEqual([problem]);
    expect(h.state.hookCalls).toEqual([]);
  });

  it("each phase announces itself in progress output", async () => {
    const h = withScript({ report: REPORT });
    await run(h);
    expect(h.progress.some((p) => p.startsWith("pre-prompt pre-flight passed"))).toBe(true);
  });
});

describe("terminal states", () => {
  it.each([
    ["error_max_turns", "max_turns"],
    ["error_max_budget_usd", "budget_stopped"],
    ["error_during_execution", "error"],
  ] as const)("%s -> %s", async (subtype, status) => {
    const o = await run(withScript({ subtype }));
    expect(o.result.status).toBe(status);
    expect(statusOfResult(subtype, [])[0]).toBe(status);
  });

  it("an API failure is api_error, not completed, although the SDK reports subtype success", async () => {
    const h = withScript({ apiError: "API Error: 400 status code (no body)" });
    const o = await run(h);
    expect(o.result.status).toBe("api_error");
    expect(o.result.statusDetail).toContain("400 status code (no body)");
    expect(o.result.report.markdown).toBe("");
    expect(o.result.report.sectionsPresent).toEqual([]);
    expect(o.record.result).toMatchObject({ subtype: "success", isError: true, terminalReason: "api_error", modelUsage: {} });
    expect(o.record.models).toEqual(["<synthetic>"]);
    expect(o.messages.some((m) => (m as { is_api_error_message?: boolean }).is_api_error_message === true)).toBe(true); // the raw evidence stays
    expect(h.progress.some((p) => p.startsWith("finished: FAILED: api_error"))).toBe(true);
  });

  it("a normal success stays completed; is_error decides, not the subtype", () => {
    expect(statusOfResult("success", [], { isError: false, terminalReason: "completed", resultText: "report" })[0]).toBe("completed");
    expect(statusOfResult("success", [], { isError: true, terminalReason: "api_error", resultText: "x" })[0]).toBe("api_error");
    expect(statusOfResult("success", [], { isError: true, terminalReason: "other", resultText: "x" })[0]).toBe("error");
    expect(statusOfResult("error_max_turns", [], { isError: true, terminalReason: "max_turns" })[0]).toBe("max_turns");
  });

  it("a stream that ends without a result is truncated, never completed", async () => {
    const o = await run(withScript({ report: REPORT, subtype: null }));
    expect(o.result.status).toBe("truncated");
  });

  it("a crash mid-stream is an error and still cleans up", async () => {
    const o = await run(withScript({ report: REPORT, crashAfter: 1 }));
    expect(o.result.status).toBe("error");
    expect(o.result.statusDetail).toContain("exited unexpectedly");
    expect(o.result.cleanup).toMatchObject({ closeCalled: true, tempRemoved: true });
  });

  it("an authentication failure from the API is auth_failed", async () => {
    const o = await run(withScript({ authFailure: true, subtype: "error_during_execution" }));
    expect(o.result.status).toBe("auth_failed");
  });

  it("timeout aborts, interrupts and closes", async () => {
    const h = withScript({ hang: true });
    const o = await run(h, { timeoutMs: 50 });
    expect(o.result.status).toBe("timeout");
    expect(h.state.interrupted).toBe(1);
    expect(o.result.cleanup).toMatchObject({ closeCalled: true, childExited: true });
  });

  it("cancellation (SIGINT path) aborts, interrupts and closes", async () => {
    const h = withScript({ hang: true });
    const abort = new AbortController();
    setTimeout(() => abort.abort("cancelled"), 30);
    const o = await run(h, { abort });
    expect(o.result.status).toBe("cancelled");
    expect(h.state.interrupted).toBe(1);
    expect(o.result.cleanup.closeCalled).toBe(true);
  });
});

describe("cleanup failures are never reported as success", () => {
  it("an unkillable CLI child gives cleanup_failed", async () => {
    const o = await run(withScript({ report: REPORT }, { unkillable: true }));
    expect(o.result.status).toBe("cleanup_failed");
    expect(o.result.cleanup).toMatchObject({ forcedKill: true, childExited: false });
    expect(o.result.statusDetail).toContain("did not exit");
  });

  it("orphaned MarketMind servers are killed; survivors fail the run", async () => {
    const killedOk = await run(withScript({ report: REPORT }, { orphans: [[111], []] }));
    expect(killedOk.result.status).toBe("completed");
    expect(killedOk.result.cleanup).toMatchObject({ orphansFound: 1, orphansKilled: 1 });
    const survived = await run(withScript({ report: REPORT }, { orphans: [[111], [111]] }));
    expect(survived.result.status).toBe("cleanup_failed");
    expect(survived.result.cleanup.problems.join()).toContain("survived");
  });

  it("temp directories that cannot be removed fail the run (and the path is redacted)", async () => {
    const o = await run(withScript({ report: REPORT }, { removeFails: true }));
    expect(o.result.status).toBe("cleanup_failed");
    expect(o.result.statusDetail).not.toContain(tmpdir());
  });
});

describe("secrets", () => {
  it("the API key never appears in results, records, messages, progress or stderr", async () => {
    const report = `${REPORT}\nkey echo: ${KEY}\n`;
    const h = withScript({ report, calls: [{ name: MARKETMIND_TOOLS[1]!, args: { marketId: "900103" }, result: { isError: false, text: `{"note":"${KEY}"}` } }] });
    const o = await run(h);
    const all = JSON.stringify([o.result, o.record, o.messages, o.stderr, h.progress]);
    expect(all).not.toContain(KEY);
    expect(all).toContain("<redacted:key>");
    expect(JSON.stringify(h.state.options!.env)).toContain(KEY); // only the subprocess env carries it
  });
});
