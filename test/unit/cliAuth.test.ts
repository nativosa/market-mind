import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MCP_LAUNCHER } from "../../agent-sdk/options.js";
import { assessAuthStatus, authModeFor, authPreflight, AuthRecord, AuthUsageError, cliEnv, initProblems, mcpConfig, PINNED_CLI_VERSION, serverEnvProblems, StreamWatch, type AuthMode, type RunCommand } from "../../test-agent/cliAuth.js";
import { compareDirs } from "../../test-agent/eval/compare.js";
import { evaluateDir } from "../../test-agent/eval/evaluate.js";
import { computeGolden } from "../../test-agent/eval/golden.js";
import { scenarioById } from "../../test-agent/eval/scenarios.js";
import { buildScorecard } from "../../test-agent/eval/scorecard.js";
import { RunMeta, stableJson } from "../../test-agent/eval/schema.js";
import { buildTrace, goodReport, runMeta } from "../evalTraces.js";

// Stage 2.7.4: explicit authentication for the CLI harness. Fake credentials and local stubs only: no real
// credential file is read and nothing here reaches a model.

vi.setConfig({ testTimeout: 90_000 });

const PARENT: Record<string, string> = {
  PATH: "/usr/bin",
  SystemRoot: "C:\\Windows",
  TEMP: "/tmp",
  HOME: "/home/owner",
  USERPROFILE: "/home/owner",
  APPDATA: "/home/owner/AppData",
  ANTHROPIC_API_KEY: "sk-ant-api03-FAKE-key-0000000000",
  ANTHROPIC_AUTH_TOKEN: "FAKE-bearer-0000000000",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-FAKE-0000000000",
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: "FAKE-session-000",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_USE_FOUNDRY: "1",
  ANTHROPIC_BASE_URL: "https://proxy.example",
  ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
  ANTHROPIC_CUSTOM_HEADERS: "x-key: FAKE",
  ANTHROPIC_PROFILE: "work",
  AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
  SOME_FUTURE_SECRET: "FAKE-unknown-000",
  CLAUDECODE: "1",
  CLAUDE_CODE_MESSAGING_TOKEN: "FAKE-msg-000",
};
const CREDENTIAL_VALUES = Object.entries(PARENT).filter(([k]) => /KEY|TOKEN|SECRET|CODE_USE_|BASE_URL|HEADERS|ANTHROPIC_PROFILE|CREDENTIALS/.test(k));

describe("mode selection", () => {
  it("the CLI harness needs an explicit mode, whatever the shell holds", () => {
    expect(() => authModeFor("cli", undefined)).toThrow("explicit --auth");
    expect(authModeFor("cli", "subscription")).toBe("subscription");
    expect(authModeFor("cli", "api-key")).toBe("api-key");
  });

  it.each(["oauth", "SUBSCRIPTION", "", "auto", "api_key"])("refuses the mode %j", (value) => {
    expect(() => authModeFor("cli", value)).toThrow(AuthUsageError);
  });

  it("the SDK harness keeps API-key behaviour and refuses subscription mode behind Gate G0", () => {
    expect(authModeFor("sdk", undefined)).toBe("api-key");
    expect(authModeFor("sdk", "api-key")).toBe("api-key");
    expect(() => authModeFor("sdk", "subscription")).toThrow("Gate G0");
  });
});

describe("child environment", () => {
  it("subscription mode holds no credential, provider or endpoint variable, and keeps the login location", () => {
    const env = cliEnv("subscription", PARENT, "/iso");
    for (const [k, v] of CREDENTIAL_VALUES) {
      expect(env[k], k).toBeUndefined();
      if (v.length > 1) expect(Object.values(env)).not.toContain(v);
    }
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/owner", USERPROFILE: "/home/owner", APPDATA: "/home/owner/AppData" });
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("API-key mode holds the key alone, with an empty home so the login cannot be picked up", () => {
    const env = cliEnv("api-key", PARENT, "/iso");
    expect(env.ANTHROPIC_API_KEY).toBe(PARENT.ANTHROPIC_API_KEY);
    for (const [k] of CREDENTIAL_VALUES.filter(([n]) => n !== "ANTHROPIC_API_KEY")) expect(env[k], k).toBeUndefined();
    expect(env).toMatchObject({ HOME: "/iso", USERPROFILE: "/iso" });
    expect(env.CLAUDE_CONFIG_DIR).toContain("iso");
    expect(Object.values(env).join(" ")).not.toContain("/home/owner");
  });

  it("is an allowlist: only known names appear", () => {
    const env = cliEnv("subscription", { ...PARENT, ANYTHING_NEW: "x" }, "/iso");
    expect(env.ANYTHING_NEW).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(["APPDATA", "DISABLE_AUTOUPDATER", "HOME", "PATH", "SystemRoot", "TEMP", "USERPROFILE"]);
  });

  it("a config directory the owner set is honoured in subscription mode only", () => {
    expect(cliEnv("subscription", { CLAUDE_CONFIG_DIR: "/custom" }, "/iso").CLAUDE_CONFIG_DIR).toBe("/custom");
    expect(cliEnv("api-key", { CLAUDE_CONFIG_DIR: "/custom" }, "/iso").CLAUDE_CONFIG_DIR).not.toBe("/custom");
  });
});

// The shapes `claude auth status --json` returned on the pinned CLI, from fake credentials.
const LOGIN = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", analyticsDisabled: true, email: "owner@example.com", orgId: "org-secret-id", orgName: "Owner Org", subscriptionType: "pro" };
const KEY = { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" };

describe("assessing auth status", () => {
  const passes = (mode: AuthMode, o: unknown) => assessAuthStatus(mode, JSON.stringify(o)).problems;

  it("positive evidence for each mode", () => {
    expect(passes("subscription", LOGIN)).toEqual([]);
    expect(passes("subscription", { ...LOGIN, subscriptionType: "max" })).toEqual([]);
    expect(passes("api-key", KEY)).toEqual([]);
  });

  it.each<[string, object]>([
    ["no credential", { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }],
    ["an API key", KEY],
    ["a bearer or OAuth token", { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }],
    ["a key helper", { loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }],
    ["Bedrock", { loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }],
    ["Vertex", { loggedIn: true, authMethod: "third_party", apiProvider: "vertex" }],
    ["a login beside a stored key", { ...LOGIN, apiKeySource: "/login managed key" }],
    ["a login with no plan", { ...LOGIN, subscriptionType: null }],
    ["a login with a missing plan", { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }],
    ["a team plan", { ...LOGIN, subscriptionType: "team" }],
    ["a login through a gateway", { ...LOGIN, apiProvider: "gateway" }],
    ["a missing method", { loggedIn: true, apiProvider: "firstParty", subscriptionType: "pro" }],
    ["a missing provider", { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }],
    ["a non-boolean login", { ...LOGIN, loggedIn: "true" }],
    ["nothing", {}],
  ])("subscription mode refuses %s", (_name, o) => {
    expect(passes("subscription", o).length).toBeGreaterThan(0);
  });

  it.each<[string, object]>([
    ["a login", LOGIN],
    ["no credential", { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }],
    ["a stored key", { ...KEY, apiKeySource: "/login managed key" }],
    ["a helper", { loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }],
    ["a key with a visible login", { ...KEY, subscriptionType: "pro" }],
    ["a token", { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }],
  ])("API-key mode refuses %s", (_name, o) => {
    expect(passes("api-key", o).length).toBeGreaterThan(0);
  });

  it.each(["", "not json", "[]", "null", "42"])("output that is not an object fails closed: %j", (out) => {
    expect(assessAuthStatus("subscription", out).problems.length).toBeGreaterThan(0);
  });

  it("keeps only allowlisted fields: no email, organization or token reaches the evidence", () => {
    const { evidence } = assessAuthStatus("subscription", JSON.stringify({ ...LOGIN, accessToken: "sk-ant-oat01-FAKE-000" }));
    expect(Object.keys(evidence).sort()).toEqual(["apiKeySource", "apiProvider", "authMethod", "loggedIn", "subscriptionType"]);
    expect(JSON.stringify(evidence)).not.toMatch(/owner@example|org-secret|Owner Org|sk-ant/);
    expect(AuthRecord.safeParse({ mode: "subscription", preflight: { ...evidence, email: "owner@example.com" } }).success).toBe(false);
  });
});

describe("the gate", () => {
  const fake = (replies: Record<string, { status?: number | null; stdout: string }>) => {
    const calls: { args: string[]; env: Record<string, string>; cwd: string }[] = [];
    const run: RunCommand = (args, o) => {
      calls.push({ args, ...o });
      const r = replies[args.join(" ")];
      return { status: r?.status === undefined ? 0 : r.status, stdout: r?.stdout ?? "" };
    };
    return { run, calls };
  };
  const VERSION = { "--version": { stdout: `${PINNED_CLI_VERSION} (Claude Code)\n` } };

  it("passes on positive evidence, under the environment it was given", () => {
    const env = cliEnv("subscription", PARENT, "/iso");
    const f = fake({ ...VERSION, "auth status --json": { stdout: JSON.stringify(LOGIN) } });
    const p = authPreflight("subscription", env, "/work", f.run);
    expect(p).toMatchObject({ passed: true, problems: [], cliVersion: PINNED_CLI_VERSION, evidence: { authMethod: "claude.ai" } });
    expect(f.calls.map((c) => c.args.join(" "))).toEqual(["--version", "auth status --json"]);
    expect(f.calls.every((c) => c.env === env && c.cwd === "/work")).toBe(true);
  });

  it("another CLI version fails before its output is trusted", () => {
    const f = fake({ "--version": { stdout: "9.9.9 (Claude Code)\n" } });
    const p = authPreflight("subscription", {}, "/w", f.run);
    expect(p.passed).toBe(false);
    expect(p.problems[0]).toContain("not the pinned");
    expect(f.calls).toHaveLength(1);
  });

  it("a missing CLI, a failed status or unusable output fails closed", () => {
    expect(authPreflight("subscription", {}, "/w", fake({ "--version": { status: null, stdout: "" } }).run).passed).toBe(false);
    expect(authPreflight("subscription", {}, "/w", fake({ "--version": { stdout: "garbage" } }).run).passed).toBe(false);
    expect(authPreflight("subscription", {}, "/w", fake({ ...VERSION, "auth status --json": { status: 1, stdout: JSON.stringify(LOGIN) } }).run).passed).toBe(false);
    expect(authPreflight("subscription", {}, "/w", fake({ ...VERSION, "auth status --json": { stdout: "" } }).run).passed).toBe(false);
  });

  it("neither mode falls back to the other", () => {
    expect(authPreflight("subscription", {}, "/w", fake({ ...VERSION, "auth status --json": { stdout: JSON.stringify(KEY) } }).run).passed).toBe(false);
    expect(authPreflight("api-key", {}, "/w", fake({ ...VERSION, "auth status --json": { stdout: JSON.stringify(LOGIN) } }).run).passed).toBe(false);
  });
});

describe("the pinned CLI, with fake credentials and a dead proxy", () => {
  const BINARY = "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
  const FAKE_LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-not-real-0000000000", refreshToken: "sk-ant-ort01-FAKE-not-real-0000000000", expiresAt: 4102444800000, scopes: ["user:inference", "user:profile"], subscriptionType: "pro" } });
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  function world(files: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), "mm-cli-auth-"));
    dirs.push(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(home, ".claude", name), content);
    return { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), TEMP: home, TMP: home, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
  }
  const status = (env: Record<string, string>) => spawnSync(BINARY, ["auth", "status", "--json"], { env, encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).stdout;
  const key = { ANTHROPIC_API_KEY: "sk-ant-api03-FAKE-0000000000000000" };

  it.skipIf(!existsSync(BINARY)).each<[string, Record<string, string>, Record<string, string>, boolean, boolean]>([
    ["a fake login", { ".credentials.json": FAKE_LOGIN }, {}, true, false],
    ["no credential", {}, {}, false, false],
    ["an API key", {}, key, false, true],
    ["a login beside an API key in the environment", { ".credentials.json": FAKE_LOGIN }, key, false, true],
    ["a login beside a bearer token", { ".credentials.json": FAKE_LOGIN }, { ANTHROPIC_AUTH_TOKEN: "FAKE-000000" }, false, false],
    ["a login beside an OAuth token variable", { ".credentials.json": FAKE_LOGIN }, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-FAKE-000" }, false, false],
    ["a login beside a provider switch", { ".credentials.json": FAKE_LOGIN }, { CLAUDE_CODE_USE_BEDROCK: "1" }, false, false],
    ["a login with a key helper in user settings", { ".credentials.json": FAKE_LOGIN, "settings.json": '{"apiKeyHelper":"echo FAKE"}' }, {}, false, false],
    ["a login with a key in user settings env", { ".credentials.json": FAKE_LOGIN, "settings.json": '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-FAKE-0000"}}' }, {}, false, true],
    ["a login beside a stored managed key", { ".credentials.json": FAKE_LOGIN, ".claude.json": '{"primaryApiKey":"sk-ant-api03-FAKE-0000"}' }, {}, false, false],
  ])("%s", (_name, files, extra, subscriptionOk, keyOk) => {
    const out = status({ ...world(files), ...extra });
    expect(assessAuthStatus("subscription", out).problems.length === 0).toBe(subscriptionOk);
    expect(assessAuthStatus("api-key", out).problems.length === 0).toBe(keyOk);
  });

  it.skipIf(!existsSync(BINARY))("the sanitized environment removes a competing key, so precedence cannot select API billing", () => {
    const w = world({ ".credentials.json": FAKE_LOGIN });
    const inherited = { ...w, ...key, ANTHROPIC_AUTH_TOKEN: "FAKE-000000", CLAUDE_CODE_USE_BEDROCK: "1" };
    expect(assessAuthStatus("subscription", status(inherited)).problems.length).toBeGreaterThan(0);
    const clean = { ...cliEnv("subscription", inherited, "/unused"), HTTPS_PROXY: w.HTTPS_PROXY };
    expect(assessAuthStatus("subscription", status(clean)).problems).toEqual([]);
  });

  it.skipIf(!existsSync(BINARY))("the pinned binary is the pinned version", () => {
    expect(spawnSync(BINARY, ["--version"], { encoding: "utf8", windowsHide: true }).stdout).toContain(PINNED_CLI_VERSION);
  });

  it.skipIf(!existsSync(BINARY))("the source is not validity: a fake login reads as logged in, so the gate cannot prove it works", () => {
    expect(JSON.parse(status(world({ ".credentials.json": FAKE_LOGIN }))) as { loggedIn: boolean }).toMatchObject({ loggedIn: true });
  });
});

const GOOD_INIT = { type: "system", subtype: "init", apiKeySource: "none", permissionMode: "default", tools: ["Task", "Bash", "Read", "mcp__marketmind__scan_markets", "mcp__marketmind__inspect_market", "mcp__marketmind__list_collection_runs", "mcp__marketmind__get_market_history", "mcp__marketmind__get_observation_details"], agents: ["claude", "market-investigator"], skills: ["investigate-market"], plugins: [{ name: "cc-plugin-telemetry", path: "builtin" }], mcp_servers: [{ name: "marketmind", status: "connected" }] };

describe("init validation", () => {
  it("accepts the expected session", () => {
    expect(initProblems("subscription", GOOD_INIT)).toEqual([]);
    expect(initProblems("api-key", { ...GOOD_INIT, apiKeySource: "ANTHROPIC_API_KEY" })).toEqual([]);
  });

  it.each<[string, object, string]>([
    ["a key on a subscription run", { apiKeySource: "ANTHROPIC_API_KEY" }, "key source"],
    ["a helper", { apiKeySource: "apiKeyHelper" }, "key source"],
    ["a managed key", { apiKeySource: "/login managed key" }, "key source"],
    ["a missing source", { apiKeySource: undefined }, "key source"],
    ["a new built-in tool", { tools: [...GOOD_INIT.tools, "WebFetch"] }, "unexpected tools"],
    ["a sixth MCP tool", { tools: [...GOOD_INIT.tools, "mcp__marketmind__place_order"] }, "MCP tools"],
    ["another server's tool", { tools: [...GOOD_INIT.tools, "mcp__github__create_issue"] }, "MCP tools"],
    ["a missing MCP tool", { tools: GOOD_INIT.tools.filter((t) => !t.endsWith("scan_markets")) }, "MCP tools"],
    ["an elevated mode", { permissionMode: "bypassPermissions" }, "permission mode"],
    ["acceptEdits", { permissionMode: "acceptEdits" }, "permission mode"],
    ["a user agent", { agents: ["market-investigator", "my-agent"] }, "unexpected agents"],
    ["a user skill", { skills: ["investigate-market", "my-skill"] }, "unexpected skills"],
    ["an installed plugin", { plugins: [{ name: "third-party", path: "/home/x/plugin" }] }, "unexpected plugins"],
    ["another MCP server", { mcp_servers: [{ name: "marketmind" }, { name: "github" }] }, "unexpected MCP servers"],
  ])("refuses %s", (_name, change, message) => {
    expect(initProblems("subscription", { ...GOOD_INIT, ...change }).join(" ")).toContain(message);
  });

  it("API-key mode refuses a session without its key", () => {
    expect(initProblems("api-key", GOOD_INIT).join(" ")).toContain("not ANTHROPIC_API_KEY");
  });

  const archive = process.env.MARKETMIND_BASELINE_DIR ?? ".eval-out/archive/v0.5.0-baseline";
  it.skipIf(!existsSync(archive))("all 23 recorded CLI sessions pass", () => {
    const runs = readdirSync(archive).filter((k) => /^[PS]\d\d-r\d/.test(k));
    expect(runs).toHaveLength(23);
    for (const k of runs) {
      const init = readFileSync(join(archive, k, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { subtype?: string; apiKeySource?: string }).find((e) => e.subtype === "init")!;
      expect(initProblems("subscription", init), k).toEqual([]);
    }
  });
});

describe("watching the stream", () => {
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  const RATE = { type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false } };

  it("a clean subscription stream gives no reason to stop, and is confirmed", () => {
    const w = new StreamWatch("subscription");
    expect(w.feed(line(RATE) + line(GOOD_INIT))).toBeNull();
    expect(w).toMatchObject({ initApiKeySource: "none", rateLimitEventSeen: true, overageUsed: false });
    expect(w.finish()).toEqual([]);
  });

  it("copes with events split across chunks, and with non-JSON lines", () => {
    const w = new StreamWatch("subscription");
    const text = `not json\n${line({ ...GOOD_INIT, apiKeySource: "ANTHROPIC_API_KEY" })}`;
    expect(w.feed(text.slice(0, 20))).toBeNull();
    expect(w.feed(text.slice(20))).toContain("key source");
  });

  it("stops on extra usage: it can be charged", () => {
    for (const info of [{ isUsingOverage: true }, { overageInUse: true }]) {
      const w = new StreamWatch("subscription");
      expect(w.feed(line({ type: "rate_limit_event", rate_limit_info: info }))).toContain("extra usage");
      expect(w.overageUsed).toBe(true);
    }
  });

  it("a subscription rate-limit event in an API-key run is a wrong credential", () => {
    expect(new StreamWatch("api-key").feed(line(RATE))).toContain("API-key run");
  });

  it("no init means nothing was confirmed, and only the first init counts", () => {
    expect(new StreamWatch("subscription").finish()[0]).toContain("no init event");
    const w = new StreamWatch("subscription");
    w.feed(line(GOOD_INIT) + line({ ...GOOD_INIT, apiKeySource: "ANTHROPIC_API_KEY" }));
    expect(w.initApiKeySource).toBe("none");
  });

  it("keeps no event content: only names of problems", () => {
    const w = new StreamWatch("subscription");
    w.feed(line({ ...GOOD_INIT, email: "owner@example.com", cwd: "/home/owner" }));
    expect(JSON.stringify(w)).not.toMatch(/owner/);
  });
});

describe("MCP credential isolation", () => {
  it("the server starts through the launcher, with no credential in its configured environment", () => {
    const c = mcpConfig("/repo/agent-sdk/mcp-launcher.mjs", "/repo/test-agent/scenario-mcp.mjs", "tag-1", "/w/db.sqlite", "/w/report.jsonl");
    const server = c.mcpServers.marketmind as { command: string; args: string[]; env: Record<string, string> };
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual(["/repo/agent-sdk/mcp-launcher.mjs", "/repo/test-agent/scenario-mcp.mjs", "--eval-tag=tag-1"]);
    expect(Object.keys(server.env).sort()).toEqual(["MARKETMIND_DB", "MARKETMIND_LAUNCH_REPORT"]);
  });

  it("the launcher withholds every credential and the home directory from the server", async () => {
    const { serverEnv } = (await import(pathToFileURL(MCP_LAUNCHER).href)) as { serverEnv: (p: Record<string, string>) => Record<string, string> };
    const env = serverEnv({ ...PARENT, MARKETMIND_DB: "/w/db" });
    for (const [k] of CREDENTIAL_VALUES) expect(env[k], k).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.APPDATA).toBeUndefined();
    expect(env.MARKETMIND_DB).toBe("/w/db");
  });

  it("the run checks the launcher's report", () => {
    expect(serverEnvProblems([{ serverEnvKeys: ["PATH", "MARKETMIND_DB", "TEMP", "SystemRoot"] }])).toEqual([]);
    expect(serverEnvProblems([{ serverEnvKeys: ["PATH", "ANTHROPIC_API_KEY"] }])[0]).toContain("ANTHROPIC_API_KEY");
    expect(serverEnvProblems([{ serverEnvKeys: ["HOME"] }])[0]).toContain("HOME");
    expect(serverEnvProblems([])[0]).toContain("no report");
  });
});

describe("provenance and compatibility", () => {
  const S03 = scenarioById("S03")!;
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const mm = (t: string, args: Record<string, unknown>) => ({ name: `mcp__marketmind__${t}`, args });
  async function gradedDir(auth?: object) {
    const out = mkdtempSync(join(tmpdir(), "mm-auth-prov-"));
    dirs.push(out);
    const g = await computeGolden(S03);
    const meta = runMeta(S03, g);
    mkdirSync(join(out, "S03-r1"));
    writeFileSync(join(out, "S03-r1", "run.json"), stableJson({ ...meta, ...(auth ? { execution: { mode: "claude-cli", artifact: "trace.jsonl", auth } } : {}) }));
    writeFileSync(join(out, "S03-r1", "trace.jsonl"), await buildTrace(S03, [mm("inspect_market", { marketId: "900103" }), mm("get_market_history", { marketId: "900103", limit: 10, includeSynthetic: true })], goodReport(g, { label: "INTERESTING_FOR_FURTHER_RESEARCH" })));
    return { out, ...(await evaluateDir(out)) };
  }
  const AUTH = { mode: "subscription", preflight: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", apiKeySource: null, subscriptionType: "pro" }, cliVersion: PINNED_CLI_VERSION, initApiKeySource: "none", rateLimitEventSeen: true, overageUsed: false, problems: [] };

  it("run records carry the mode, and results and scorecards expose it as a confounder", async () => {
    const { results, scorecard } = await gradedDir(AUTH);
    expect(results[0]!.execution.authMode).toBe("subscription");
    expect(scorecard.confounders.authModes).toEqual(["subscription"]);
  });

  it("older records stay without a mode, and read as not recorded", async () => {
    const { results, scorecard } = await gradedDir();
    expect(results[0]!.execution).toEqual({ mode: "claude-cli", source: "claude-cli-stream-json", sdkVersion: null, optionsDigest: null });
    expect(scorecard.confounders.authModes).toEqual(["not recorded"]);
    expect(RunMeta.safeParse({ ...runMeta(S03, await computeGolden(S03)), execution: { mode: "claude-cli", artifact: "trace.jsonl", auth: { mode: "password" } } }).success).toBe(false);
  });

  it("mixed modes warn on the scorecard and confound a comparison", async () => {
    const a = await gradedDir(AUTH);
    const b = await gradedDir({ mode: "api-key" });
    expect(buildScorecard([a.results[0]!, { ...b.results[0]!, runKey: "S03-r2" }]).warnings.join(" ")).toContain("authModes differ");
    expect(compareDirs(a.out, b.out).confounded).toContain("authentication mode");
    const same = await gradedDir(AUTH);
    expect(compareDirs(a.out, same.out).confounded).not.toContain("authentication mode");
  });

  it("the run record has no field for account data", () => {
    expect(AuthRecord.safeParse({ ...AUTH, email: "owner@example.com" }).success).toBe(false);
    expect(AuthRecord.safeParse({ ...AUTH, preflight: { ...AUTH.preflight, orgName: "x" } }).success).toBe(false);
  });
});

describe("the runner's arguments", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "tsx", "test-agent/run.ts", ...args], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? tmpdir(), TMP: process.env.TMP ?? tmpdir(), ...env } });

  it.each<[string, string[], Record<string, string>, string]>([
    ["no mode on the CLI harness", ["--scenario", "S03"], {}, "explicit --auth"],
    ["no mode, with a key in the shell", ["--scenario", "S03"], { ANTHROPIC_API_KEY: "sk-ant-api03-FAKE-0000" }, "explicit --auth"],
    ["an unknown mode", ["--auth", "auto", "--scenario", "S03"], {}, "--auth must be"],
    ["subscription on the SDK harness", ["--harness", "sdk", "--auth", "subscription", "--scenario", "S03"], { ANTHROPIC_API_KEY: "sk-ant-api03-FAKE-0000" }, "Gate G0"],
    ["API-key mode without a key", ["--auth", "api-key", "--scenario", "S03"], {}, "needs ANTHROPIC_API_KEY"],
    ["the SDK harness without a key", ["--harness", "sdk", "--scenario", "S03"], {}, "needs ANTHROPIC_API_KEY"],
    ["the auth check on the SDK harness", ["--harness", "sdk", "--auth-check"], { ANTHROPIC_API_KEY: "sk-ant-api03-FAKE-0000" }, "CLI harness"],
    ["an unknown harness", ["--harness", "web", "--auth", "subscription", "--scenario", "S03"], {}, "--harness must be"],
  ])("%s exits 2 before anything starts", (_name, args, env, message) => {
    const r = run(args, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
  });
});
