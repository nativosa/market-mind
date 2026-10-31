import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";
import { HARD_BUDGET_CAP_USD, parseArgs, UsageError } from "../../agent-sdk/args.js";
import { Harness } from "../../agent-sdk/contract.js";
import { createGuard, MARKETMIND_TOOLS } from "../../agent-sdk/guard.js";
import { AGENT_NAME, IGNORED_FOR_MAIN_THREAD, loadInvestigator, parsePolicyFile, POLICY_FILES, REPO_ROOT, sha256 } from "../../agent-sdk/investigator.js";
import { buildEnv, buildOptions, describeOptions, DISALLOWED_BUILTINS, ENV_PASSTHROUGH, harnessOf, SDK_VERSION, serverSpec, SESSION_SETTINGS } from "../../agent-sdk/options.js";
import { optionViolations } from "../../agent-sdk/session.js";
import { ALLOWED_TOOLS } from "../../test-agent/eval/graders.js";
import { promptFor, scenarioById } from "../../test-agent/eval/scenarios.js";

// Stage 2.6: CLI arguments, investigator policy reuse, exact dependencies and the SDK option boundary.
// Pure: nothing is spawned and the SDK runtime is only imported for its exported constant list.

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const usage = (argv: string[]) => () => parseArgs(["investigate", ...argv]);

describe("CLI arguments", () => {
  it("Mode A and Mode B produce the skill's $ARGUMENTS form", () => {
    expect(parseArgs(["investigate", "--market-id", "900103", "--max-budget-usd", "0.2"]).request).toMatchObject({ mode: "A", marketId: "900103", version: null, arguments: "900103", server: "live", syntheticAuthorized: false });
    expect(parseArgs(["investigate", "--market-id", "12", "--objective", "Is depth real?", "--dry-run"]).request.arguments).toBe("12 Is depth real?");
    expect(parseArgs(["investigate", "--discover", "--dry-run"]).request).toMatchObject({ mode: "B", version: "v1", arguments: "discover v1" });
    expect(parseArgs(["investigate", "--discover", "--version", "v2", "--dry-run"]).request.arguments).toBe("discover v2");
  });

  it("fixture mode uses the evaluation scenario's exact arguments (comparable to the CLI baseline)", () => {
    for (const id of ["S01", "S02", "S03", "S10"]) {
      const s = scenarioById(id)!;
      const a = parseArgs(["investigate", "--market-id", s.marketId!, "--fixture", id, "--dry-run"]).request;
      expect(`/investigate-market ${a.arguments}`).toBe(promptFor(s));
      expect(a).toMatchObject({ server: "fixture", fixtureScenario: id, syntheticAuthorized: s.syntheticAuthorized });
    }
    const s09 = parseArgs(["investigate", "--discover", "--version", "v1", "--fixture", "S09", "--dry-run"]).request;
    expect(`/investigate-market ${s09.arguments}`).toBe(promptFor(scenarioById("S09")!));
  });

  it.each([
    [["--market-id", "abc", "--dry-run"], "numeric Gamma id"],
    [["--market-id", "1".repeat(21), "--dry-run"], "numeric Gamma id"],
    [["--dry-run"], "exactly one of"],
    [["--market-id", "1", "--discover", "--dry-run"], "exactly one of"],
    [["--market-id", "1", "--version", "v1", "--dry-run"], "only to --discover"],
    [["--discover", "--version", "v3", "--dry-run"], "v1 or v2"],
    [["--market-id", "1", "--objective", "a\nb", "--dry-run"], "printable"],
    [["--market-id", "1", "--objective", "x".repeat(501), "--dry-run"], "printable"],
    [["--market-id", "900103", "--fixture", "S99", "--dry-run"], "golden evaluation scenario"],
    [["--market-id", "900103", "--fixture", "P01", "--dry-run"], "golden evaluation scenario"],
    [["--market-id", "900101", "--fixture", "S03", "--dry-run"], "pass --market-id 900103"],
    [["--market-id", "900103", "--fixture", "S03", "--objective", "x", "--dry-run"], "not allowed with --fixture"],
    [["--market-id", "1"], "--max-budget-usd is required"],
    [["--market-id", "1", "--max-budget-usd", "0"], "greater than 0"],
    [["--market-id", "1", "--max-budget-usd", String(HARD_BUDGET_CAP_USD + 0.01)], "at most"],
    [["--market-id", "1", "--max-budget-usd", "1e-1"], "greater than 0"],
    [["--market-id", "1", "--dry-run", "--timeout-ms", "100"], "--timeout-ms"],
    [["--market-id", "1", "--dry-run", "--timeout-ms", "1.5"], "--timeout-ms"],
    [["--market-id", "1", "--dry-run", "--dry-run"], "twice"],
    [["--market-id", "1", "--dry-run", "--permission-mode", "bypassPermissions"], "unknown argument"],
    [["--market-id"], "needs a value"],
  ])("rejects %j", (argv, message) => {
    expect(usage(argv)).toThrow(UsageError);
    expect(usage(argv)).toThrow(message);
  });

  it("requires the investigate command", () => {
    expect(() => parseArgs(["trade", "--market-id", "1"])).toThrow(UsageError);
  });
});

describe("investigator policy reuse (single source of truth)", () => {
  const inv = loadInvestigator();
  const agentText = read(POLICY_FILES.agent);
  const skillText = read(POLICY_FILES.skill);

  it("the system prompt is the subagent file body, byte for byte, and the hashes are of the files", () => {
    expect(inv.definition.prompt).toBe(parsePolicyFile(agentText, "agent").body);
    expect(agentText.endsWith(inv.definition.prompt)).toBe(true);
    expect(inv.hashes).toEqual({ agentSha256: sha256(agentText), skillSha256: sha256(skillText), settingsSha256: sha256(read(POLICY_FILES.settings)) });
  });

  it("frontmatter maps exactly: tools, model, maxTurns, permissionMode; omitClaudeMd is recorded as ignored", () => {
    const fm = parsePolicyFile(agentText, "agent").frontmatter;
    expect(inv.name).toBe(AGENT_NAME);
    expect(inv.definition).toEqual({ description: fm.description, prompt: inv.definition.prompt, tools: MARKETMIND_TOOLS, model: "sonnet", maxTurns: 15, permissionMode: "dontAsk" });
    expect(inv.ignoredFrontmatter).toEqual(["omitClaudeMd"]);
    expect(Object.keys(IGNORED_FOR_MAIN_THREAD)).toEqual(["omitClaudeMd"]);
    expect("omitClaudeMd" in inv.definition).toBe(false);
  });

  it("the task prompt is the skill body with $ARGUMENTS substituted, nothing else", () => {
    const body = parsePolicyFile(skillText, "skill").body;
    const prompt = inv.renderPrompt("900103 objective");
    expect(prompt).toBe(body.replace("$ARGUMENTS", "900103 objective"));
    expect(prompt).not.toContain("$ARGUMENTS");
  });

  it("the five tools agree everywhere: subagent file, settings allow rules, guard, grader", () => {
    const settings = JSON.parse(read(POLICY_FILES.settings)) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toEqual(MARKETMIND_TOOLS);
    expect(inv.tools).toEqual(MARKETMIND_TOOLS);
    expect(ALLOWED_TOOLS).toEqual(MARKETMIND_TOOLS);
  });

  it("user arguments can never make the prompt start with a slash command", () => {
    for (const args of ["/doctor", "/init", "900103 /security-review"]) expect(inv.renderPrompt(args).trimStart().startsWith("#")).toBe(true);
  });

  it("rejects unmapped frontmatter and malformed files instead of silently dropping policy", () => {
    expect(() => parsePolicyFile("no frontmatter", "x")).toThrow("missing frontmatter");
    expect(() => parsePolicyFile("---\n bad line\n---\nbody", "x")).toThrow("unsupported frontmatter line");
  });
});

describe("exact dependencies", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
  const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version: string; dev?: boolean }> };

  it("the SDK and its peers are exact dev pins, matching the lockfile and the installed SDK", () => {
    expect(pkg.devDependencies["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.302");
    expect(pkg.devDependencies["@anthropic-ai/sdk"]).toBe("0.135.0");
    expect(pkg.devDependencies["@modelcontextprotocol/sdk"]).toBe("1.32.1");
    expect(SDK_VERSION).toBe("0.3.302");
    for (const name of ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@modelcontextprotocol/sdk"]) {
      expect(lock.packages[`node_modules/${name}`]).toMatchObject({ version: pkg.devDependencies[name], dev: true });
      expect(pkg.dependencies[name]).toBeUndefined();
    }
    expect(pkg.scripts.agent).toBe("tsx agent-sdk/cli.ts");
  });
});

describe("SDK options (the security boundary)", () => {
  const inv = loadInvestigator();
  const request = parseArgs(["investigate", "--market-id", "900103", "--fixture", "S03", "--dry-run"]).request;
  const iso = { cwd: "/iso/cwd", home: "/iso/home" };
  const parentEnv = {
    ANTHROPIC_API_KEY: "sk-ant-api03-TEST",
    PATH: "/usr/bin",
    HOME: "/home/real",
    USERPROFILE: "C:\\Users\\real",
    APPDATA: "C:\\Users\\real\\AppData\\Roaming",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    ANTHROPIC_AUTH_TOKEN: "bearer",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CONFIG_DIR: "/home/real/.claude",
    MARKETMIND_DB: "data/marketmind.sqlite",
  };
  const guard = createGuard({ mode: "A", syntheticAuthorized: true, agentName: inv.name });
  const server = serverSpec(request, parentEnv, "tag-1", "/iso/home/fixture.sqlite");
  const options = buildOptions({ investigator: inv, request, server, iso, parentEnv, maxBudgetUsd: 0.25, abortController: new AbortController(), guard });

  it("restricts the pool, the settings, MCP and permissions as approved", () => {
    expect(options).toMatchObject({
      agent: "market-investigator",
      tools: [],
      allowedTools: MARKETMIND_TOOLS,
      skills: [],
      plugins: [],
      settings: { disableBundledSkills: true, enabledPlugins: { "cc-plugin-agents-md@builtin": false, "cc-plugin-plugin-authoring@builtin": false }, skillOverrides: { doctor: "off" } },
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      persistSession: false,
      maxTurns: 15,
      maxBudgetUsd: 0.25,
      cwd: "/iso/cwd",
    });
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(Object.keys(options.mcpServers!)).toEqual(["marketmind"]);
    expect(options.mcpServers!.marketmind).toMatchObject({ type: "stdio", alwaysLoad: true, env: { MARKETMIND_DB: "/iso/home/fixture.sqlite" } });
    expect(options.hooks!.PreToolUse).toHaveLength(1);
    expect(typeof options.canUseTool).toBe("function");
    expect(optionViolations(options)).toEqual([]);
  });

  it("inline settings only turn things off", () => {
    expect(Object.keys(SESSION_SETTINGS).sort()).toEqual(["disableBundledSkills", "enabledPlugins", "skillOverrides"]);
    expect(Object.values(SESSION_SETTINGS.enabledPlugins)).toEqual([false, false]);
    expect(Object.values(SESSION_SETTINGS.skillOverrides)).toEqual(["off"]);
    expect(options.settings).not.toBe(SESSION_SETTINGS);
  });

  it("disallows every built-in tool the installed SDK knows about", () => {
    expect(BUILTIN_TOOL_NAMES.filter((t) => !(DISALLOWED_BUILTINS as readonly string[]).includes(t))).toEqual([]);
    for (const t of ["Bash", "PowerShell", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Agent", "Task", "Skill", "ToolSearch"]) expect(options.disallowedTools).toContain(t);
    expect(options.disallowedTools!.some((t) => t.startsWith("mcp__"))).toBe(false);
  });

  it("the subprocess environment is an allowlist: API key only, isolated config and home, no tokens or provider switches", () => {
    const env = buildEnv(parentEnv, iso);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-TEST");
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/^[/\\]iso[/\\]home[/\\]\.claude$/);
    expect([env.HOME, env.USERPROFILE]).toEqual(["/iso/home", "/iso/home"]);
    expect(env.APPDATA).not.toContain("real");
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "MARKETMIND_DB"]) expect(env[k]).toBeUndefined();
    expect(Object.values(env).join("\n")).not.toMatch(/real/);
    expect(env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe("1");
    expect(ENV_PASSTHROUGH).not.toContain("HOME" as never);
  });

  it("live mode forwards MarketMind server settings to the server only", () => {
    const live = serverSpec({ ...request, server: "live", fixtureScenario: null }, parentEnv, "t", null);
    expect(live.env).toEqual({ MARKETMIND_DB: "data/marketmind.sqlite" });
    expect(live.script.replace(/\\/g, "/")).toMatch(/\/bin\/marketmind-mcp\.mjs$/);
    expect(() => serverSpec(request, parentEnv, "t", null)).toThrow("fixture mode needs");
  });

  it("optionViolations catches every weakening of the boundary", () => {
    const bad: [string, Partial<typeof options>][] = [
      ["permissionMode", { permissionMode: "bypassPermissions" }],
      ["allowDangerouslySkipPermissions", { allowDangerouslySkipPermissions: true }],
      ["tools must be []", { tools: ["Bash"] }],
      ["tools must be []", { tools: { type: "preset", preset: "claude_code" } }],
      ["settingSources", { settingSources: ["project"] }],
      ["strictMcpConfig", { strictMcpConfig: false }],
      ["allowedTools must be exactly", { allowedTools: [...MARKETMIND_TOOLS, "Bash"] }],
      ["wildcards", { allowedTools: ["mcp__marketmind__*", ...MARKETMIND_TOOLS.slice(1)] }],
      ["mcpServers", { mcpServers: { ...options.mcpServers, github: { command: "x" } } }],
      ["skills", { skills: "all" }],
      ["settings must be exactly", { settings: "/path/to/settings.json" }],
      ["settings must be exactly", { settings: { ...SESSION_SETTINGS, disableBundledSkills: false } }],
      ["settings must be exactly", { settings: { ...SESSION_SETTINGS, enabledPlugins: { ...SESSION_SETTINGS.enabledPlugins, "cc-plugin-plugin-authoring@builtin": true } } }],
      ["settings must be exactly", { settings: { ...SESSION_SETTINGS, skillOverrides: {} } }],
      ["settings must be exactly", { settings: { ...SESSION_SETTINGS, permissions: { allow: ["Bash"] } } }],
      ["settings must be exactly", { settings: { ...SESSION_SETTINGS, hooks: {} } }],
      ["env must not carry", { env: { ...options.env, CLAUDE_CODE_OAUTH_TOKEN: "x" } }],
      ["persistSession", { persistSession: true }],
      ["PreToolUse", { hooks: {} }],
      ["main-thread agent", { agent: "general-purpose" }],
    ];
    for (const [msg, patch] of bad) expect(optionViolations({ ...options, ...patch }).join("; ")).toContain(msg);
    const withoutSettings = { ...options };
    delete withoutSettings.settings;
    expect(optionViolations(withoutSettings).join("; ")).toContain("settings must be exactly");
  });

  it("the described options carry no machine paths or environment values, and digest stably", () => {
    const d = describeOptions(options, { investigator: inv, server, timeoutMs: 300_000 });
    const text = JSON.stringify(d);
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain(REPO_ROOT.replace(/\\/g, "\\\\"));
    expect(text).not.toContain("/iso/");
    expect(text).toContain("<repo>/test-agent/scenario-mcp.mjs");
    expect(d.envKeys).toContain("ANTHROPIC_API_KEY");
    expect(d.settings).toEqual(SESSION_SETTINGS);
    const h1 = harnessOf(options, d, { investigator: inv, timeoutMs: 300_000 });
    const widened = { ...options, settings: { ...SESSION_SETTINGS, disableBundledSkills: false } };
    expect(harnessOf(widened, describeOptions(widened, { investigator: inv, server, timeoutMs: 300_000 }), { investigator: inv, timeoutMs: 300_000 }).optionsDigest).not.toBe(h1.optionsDigest);
    const again = buildOptions({ investigator: inv, request, server: serverSpec(request, parentEnv, "tag-2", "/other/x.sqlite"), iso: { cwd: "/b", home: "/c" }, parentEnv, maxBudgetUsd: 0.25, abortController: new AbortController(), guard });
    expect(harnessOf(again, describeOptions(again, { investigator: inv, server, timeoutMs: 300_000 }), { investigator: inv, timeoutMs: 300_000 }).optionsDigest).toBe(h1.optionsDigest);
    expect(h1).toMatchObject({ mode: "agent-sdk", sdkVersion: "0.3.302", mainThreadAgent: "market-investigator", permissionMode: "dontAsk", builtinTools: [], settingSources: [] });
  });

  it("the harness records the guard source hash, separately from the options digest", () => {
    const d = describeOptions(options, { investigator: inv, server, timeoutMs: 300_000 });
    const h = harnessOf(options, d, { investigator: inv, timeoutMs: 300_000 });
    expect(h.guardSha256).toBe(sha256(read("agent-sdk/guard.ts")));
    expect(JSON.stringify(d)).not.toContain(h.guardSha256);
    const { guardSha256: _g, ...older } = h;
    expect(Harness.parse(older).guardSha256).toBeNull();
    expect(Harness.safeParse({ ...h, guardSha256: "short" }).success).toBe(false);
  });
});
