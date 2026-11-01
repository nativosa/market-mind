import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MCP_LAUNCHER } from "../../agent-sdk/options.js";
import { loadInvestigator } from "../../agent-sdk/investigator.js";
import { policyVersionOf } from "../../agent-sdk/policy.js";
import { cliEnv, cliFlags, initProblems, mcpConfig, serverEnvProblems, StreamWatch, type AuthMode } from "../../test-agent/cliAuth.js";
import { INVESTIGATOR_FILES, REPO } from "../../test-agent/processes.js";

// Stage 2.7.4: the CLI tool boundary, measured on the real pinned CLI. It talks only to a local stub of the
// Messages API with fake credentials, so nothing here reaches a model. The flags under test come from the same
// cliFlags() the runner uses. These tests skip where the pinned binary for this platform is not installed.

vi.setConfig({ testTimeout: 90_000 });

const PLATFORM_PACKAGE = join(REPO, "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`);
const BINARY = join(PLATFORM_PACKAGE, process.platform === "win32" ? "claude.exe" : "claude");
const HAVE_CLI = existsSync(BINARY);
const FIVE = ["get_market_history", "get_observation_details", "inspect_market", "list_collection_runs", "scan_markets"].map((t) => `mcp__marketmind__${t}`);
const FAKE_KEY = "sk-ant-api03-FAKE-stub-000000000000";
const FAKE_LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-not-real-0000000000", refreshToken: "sk-ant-ort01-FAKE-not-real-0000000000", expiresAt: 4102444800000, scopes: ["user:inference", "user:profile"], subscriptionType: "pro" } });
const SKILL_PROMPT = "/investigate-market 900103 Controlled synthetic scenario. Assess the market.";
const INSPECT = { name: "mcp__marketmind__inspect_market", input: { marketId: "900103" } };

interface StubRequest {
  session: "main" | "investigator";
  model: string;
  tools: string[];
}
interface Event {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  tools?: string[];
  apiKeySource?: string;
  message?: { content?: { type: string; name?: string; is_error?: boolean; content?: unknown }[] };
  permission_denials?: { tool_name: string }[];
  result?: string;
}
interface Probe {
  stdout: string;
  init: Event;
  result: Event;
  requests: StubRequest[];
  calls: string[];
  errors: string[];
  launcher: { anthropicKeyReceived: boolean; serverEnvKeys: string[] }[];
  projectFiles: string[];
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** One real CLI process under the harness's own environment and flags, plus only the stub's address. */
async function probe(opts: { mode?: AuthMode; prompt?: string; script?: object; flags?: string[]; settings?: boolean; project?: string[] } = {}): Promise<Probe> {
  const mode = opts.mode ?? "api-key";
  const work = mkdtempSync(join(tmpdir(), "mm-boundary-"));
  dirs.push(work);
  const project = join(work, "project");
  const files = opts.project ?? Object.values(INVESTIGATOR_FILES);
  for (const f of files) {
    mkdirSync(dirname(join(project, f)), { recursive: true });
    copyFileSync(join(REPO, f), join(project, f));
  }
  const home = join(work, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (mode === "subscription") writeFileSync(join(home, ".claude", ".credentials.json"), FAKE_LOGIN);
  const log = join(work, "stub.log");
  const portFile = join(work, "port");
  const stub = spawn(process.execPath, [join(REPO, "test", "stubApi.mjs"), log, portFile, JSON.stringify(opts.script ?? {})], { stdio: "ignore" });
  try {
    for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 25));
    const parent = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: work, TMP: work, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_AUTH_TOKEN: "FAKE-bearer-000000" };
    const env = { ...cliEnv(mode, parent, home), ANTHROPIC_BASE_URL: `http://127.0.0.1:${readFileSync(portFile, "utf8")}`, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    const report = join(work, "launcher.jsonl");
    const mcpPath = join(work, "mcp.json");
    writeFileSync(mcpPath, JSON.stringify(mcpConfig(MCP_LAUNCHER, join(REPO, "test-agent", "scenario-mcp.mjs"), "boundary-test", join(work, "absent.sqlite"), report)));
    const settings = opts.settings === false ? [] : ["--settings", join(project, INVESTIGATOR_FILES.settings)];
    const r = spawnSync(BINARY, ["-p", opts.prompt ?? SKILL_PROMPT, "--mcp-config", mcpPath, ...settings, ...(opts.flags ?? cliFlags(0.4))], { cwd: project, env, encoding: "utf8", timeout: 60_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const events = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
    const blocks = events.flatMap((e) => e.message?.content ?? []);
    return {
      stdout: r.stdout,
      init: events.find((e) => e.subtype === "init") ?? {},
      result: events.find((e) => e.type === "result") ?? {},
      requests: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as StubRequest) : [],
      calls: events.flatMap((e) => (e.type === "assistant" ? (e.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => `${e.parent_tool_use_id ? "investigator" : "main"}:${b.name}`) : [])),
      errors: blocks.filter((b) => b.type === "tool_result" && b.is_error === true).map((b) => JSON.stringify(b.content)),
      launcher: existsSync(report) ? readFileSync(report, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Probe["launcher"][number]) : [],
      projectFiles: readdirSync(project),
    };
  } finally {
    stub.kill();
  }
}

describe("the flags", () => {
  it("the runner takes its flags from here, and passes its explicit environment", () => {
    const run = readFileSync(join(REPO, "test-agent", "run.ts"), "utf8");
    expect(run).toContain("const flags = cliFlags(o.maxBudgetUsd, s.flags);");
    expect(run).toContain('spawn("claude", ["-p", prompt, "--mcp-config", mcpConfigPath, ...settingsFlag, ...flags], { cwd: project, env,');
    expect(run).not.toContain('"--setting-sources"');
  });

  it("remove every built-in tool, with the disallow list as a second layer", () => {
    const flags = cliFlags(0.4);
    expect(flags[flags.indexOf("--tools") + 1]).toBe("");
    const denied = flags[flags.indexOf("--disallowedTools") + 1]!.split(",");
    for (const t of ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task", "Skill", "Workflow", "ToolSearch"]) expect(denied).toContain(t);
  });

  it("never use --allowedTools as a boundary, and keep the existing session flags", () => {
    const flags = cliFlags(0.4);
    expect(flags).not.toContain("--allowedTools");
    expect(flags).not.toContain("--restricted");
    expect(flags).not.toContain("--dangerously-skip-permissions");
    for (const f of ["--strict-mcp-config", "--setting-sources", "--permission-mode", "--no-session-persistence"]) expect(flags).toContain(f);
    expect(flags[flags.indexOf("--permission-mode") + 1]).toBe("default");
    expect(cliFlags(0.4, ["--extra"])).toContain("--extra");
  });
});

describe.skipIf(!HAVE_CLI).each<[AuthMode]>([["api-key"], ["subscription"]])("the boundary on the pinned CLI, %s session", (mode) => {
  it("the session holds exactly the five tools, and the investigator is offered exactly five", async () => {
    const p = await probe({ mode, script: { investigator: [INSPECT] } });
    expect([...p.init.tools!].sort()).toEqual(FIVE);
    expect(p.requests.length).toBeGreaterThan(0);
    for (const r of p.requests) {
      expect(r.session).toBe("investigator");
      expect([...r.tools].sort()).toEqual(FIVE);
    }
  });

  it("delegation works: the main session makes no model request, the investigator's call reaches the server, and the report returns", async () => {
    const p = await probe({ mode, script: { investigator: [INSPECT] } });
    expect(p.requests.filter((r) => r.session === "main")).toEqual([]);
    expect(p.requests.every((r) => r.model.includes("sonnet"))).toBe(true);
    expect(p.calls).toEqual(["investigator:mcp__marketmind__inspect_market"]);
    expect(p.errors).toEqual([]);
    expect(p.result.result).toBe("stub report (investigator)");
  });

  it("the harness's own checks accept this session", async () => {
    const p = await probe({ mode, script: { investigator: [INSPECT] } });
    const watch = new StreamWatch(mode);
    expect(watch.feed(p.stdout)).toBeNull();
    expect(watch.finish()).toEqual([]);
    expect(watch.initApiKeySource).toBe(mode === "api-key" ? "ANTHROPIC_API_KEY" : "none");
  });

  it("no credential reaches the MCP server", async () => {
    const p = await probe({ mode, script: { investigator: [INSPECT] } });
    expect(serverEnvProblems(p.launcher)).toEqual([]);
    expect(p.launcher[0]!.anthropicKeyReceived).toBe(mode === "api-key");
    expect(p.launcher.flatMap((l) => l.serverEnvKeys).filter((k) => /KEY|TOKEN|HOME|PROFILE/.test(k))).toEqual([]);
  });
});

describe.skipIf(!HAVE_CLI)("enforcement on the pinned CLI", () => {
  const hostile = (...names: string[]) => names.map((name) => ({ name, input: { command: "echo PWNED > pwned.txt", file_path: "pwned.txt", content: "PWNED", old_string: "a", new_string: "b", url: "http://127.0.0.1:9", query: "x", prompt: "x", description: "x", skill: "run", pattern: "*" } }));
  const DENIED = ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task", "Skill"];

  it("a main-session model cannot use a removed tool: it is not offered, and a call is refused as no such tool", async () => {
    const p = await probe({ prompt: "say hello", script: { main: hostile(...DENIED) } });
    expect(p.requests.every((r) => [...r.tools].sort().join() === FIVE.join())).toBe(true);
    expect(p.calls).toEqual(DENIED.map((t) => `main:${t}`));
    expect(p.errors).toHaveLength(DENIED.length);
    for (const e of p.errors) expect(e).toContain("No such tool available");
    expect(p.projectFiles).not.toContain("pwned.txt");
  });

  it("an investigator cannot use them either, every call in the script having reached the CLI", async () => {
    const p = await probe({ script: { investigator: hostile(...DENIED) } });
    expect(p.calls).toEqual(DENIED.map((t) => `investigator:${t}`));
    expect(p.errors).toHaveLength(DENIED.length);
    for (const e of p.errors) expect(e).toContain("No such tool available");
    expect(p.projectFiles).not.toContain("pwned.txt");
  });

  it("an invented MCP tool does not exist", async () => {
    const p = await probe({ script: { investigator: [{ name: "mcp__marketmind__place_order", input: {} }] } });
    expect(p.errors[0]).toContain("No such tool available");
  });

  it("P01's shape still works: with no allow rules the permission layer denies the investigator's call", async () => {
    const p = await probe({ settings: false, project: [INVESTIGATOR_FILES.agent, INVESTIGATOR_FILES.skill], script: { investigator: [{ name: "mcp__marketmind__inspect_market", input: { marketId: "900102" } }] } });
    expect(p.result.permission_denials?.map((d) => d.tool_name)).toEqual(["mcp__marketmind__inspect_market"]);
    expect(p.errors[0]).toContain("denied");
  });

  it("control: a widened pool really does appear in init, and the harness rejects it", async () => {
    const flags = cliFlags(0.4);
    flags[flags.indexOf("--tools") + 1] = "Bash";
    const p = await probe({ flags: flags.filter((f, i) => f !== "--disallowedTools" && flags[i - 1] !== "--disallowedTools") });
    expect(p.init.tools).toContain("Bash");
    expect(initProblems("api-key", p.init).join(" ")).toContain("tool pool");
  });

  it("control: without the flags the session is wider, as the recorded baseline was", async () => {
    const flags = cliFlags(0.4);
    const open = flags.filter((f, i) => !["--tools", "--disallowedTools"].includes(f) && !["--tools", "--disallowedTools"].includes(flags[i - 1] ?? ""));
    const p = await probe({ flags: open, prompt: "say hello" });
    expect(p.requests[0]!.tools).toContain("Bash");
    expect(p.requests[0]!.tools).toContain("Write");
  });

  it("--restricted is not used because it removes the investigator: the skill and agent are gone and the prompt reaches the main session", async () => {
    const p = await probe({ flags: [...cliFlags(0.4), "--restricted"], script: {} });
    expect(p.requests.some((r) => r.session === "main")).toBe(true);
    expect(p.requests.some((r) => r.session === "investigator")).toBe(false);
  });

  it("the policy files are the registered ones, and the investigator's prompt is what they say", async () => {
    expect(policyVersionOf(loadInvestigator(resolve(REPO)).hashes)).toBe("policy-v2");
    const p = await probe({ script: {} });
    expect(p.requests[0]!.session).toBe("investigator");
  });
});
