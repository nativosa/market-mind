// SDK Options for one investigation: the security boundary, built by a pure function so it can be
// asserted offline. Layers (allowedTools alone only auto-approves; it does not restrict the pool):
//   tools: []                 no built-in tools at all
//   disallowedTools           every built-in name again, removed from the model's context
//   skills: [], plugins: []   no skill allowlist entries, no external plugins
//   settings                  SESSION_SETTINGS: off for what ships inside Claude Code itself
//   settingSources: []        no user/project/local settings, rules, hooks or CLAUDE.md
//   strictMcpConfig + one     only the "marketmind" stdio server passed here
//   permissionMode dontAsk    anything not pre-approved is denied without prompting
//   allowedTools              exactly the five MarketMind tools (no wildcards)
//   PreToolUse guard          MarketMind policy limits (see guard.ts); canUseTool always denies
//   env allowlist             explicit subprocess environment: API key only, isolated config/home dirs
// Never bypassPermissions, never allowDangerouslySkipPermissions.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import type { McpStdioServerConfig, Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import { APP_VERSION } from "../src/config/config.js";
import type { Harness, InvestigationRequest } from "./contract.js";
import { MARKETMIND_TOOLS, MCP_SERVER, type Guard } from "./guard.js";
import { REPO_ROOT, sha256, type Investigator } from "./investigator.js";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk" as const;
/** Version of the installed SDK, read from its package.json (the package exports no ./package.json subpath). */
export const SDK_VERSION: string = (JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve(SDK_PACKAGE)), "package.json"), "utf8")) as { version: string }).version;

/** Built-in tool names of SDK 0.3.302 (BUILTIN_TOOL_NAMES), plus "Task" (the Agent tool's init name). */
export const DISALLOWED_BUILTINS = [
  "Agent", "Artifact", "AskUserQuestion", "Bash", "ClaudeDesign", "CronCreate", "CronDelete", "CronList", "Edit", "EndConversation", "EnterPlanMode",
  "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep", "ListAgents", "ListMcpResourcesTool", "LSP", "Monitor", "NotebookEdit",
  "OfferChromeSetup", "PowerShell", "Projects", "propose_skills", "ProposeGoal", "PushNotification", "Read", "ReadMcpResourceDirTool",
  "ReadMcpResourceTool", "ReadNotifications", "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "SendFeedback", "SendMessage", "SendUserFile",
  "SendUserMessage", "ShareOnboardingGuide", "ShowOnboardingRolePicker", "Skill", "SubagentHandback", "Task", "TaskCreate", "TaskGet", "TaskList",
  "TaskStop", "TaskUpdate", "TodoWrite", "ToolSearch", "WaitForMcpServers", "WebFetch", "WebSearch", "Workflow", "Write",
] as const;

/**
 * Inline settings for what ships inside Claude Code 2.1.302, which `skills: []` and `plugins: []` do not
 * reach: `skills` only filters what the model may invoke, and `plugins` only adds external plugins. Each key
 * removes an entry system/init reports (see agent-sdk/README.md):
 *   disableBundledSkills  14 bundled skills
 *   enabledPlugins        the two built-in plugins, and the plugin-authoring skill with them
 *   skillOverrides        doctor, a built-in prompt command that disableBundledSkills leaves in place
 * Nothing here grants anything. A later CLI that adds another fails the effective-session check, closed.
 */
export const SESSION_SETTINGS = {
  disableBundledSkills: true,
  enabledPlugins: { "cc-plugin-agents-md@builtin": false, "cc-plugin-plugin-authoring@builtin": false },
  skillOverrides: { doctor: "off" },
} as const satisfies Settings;

/** Variables copied from the parent environment. Everything else (tokens, provider switches, HOME) is dropped. */
export const ENV_PASSTHROUGH = ["ANTHROPIC_API_KEY", "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR"] as const;
/** MarketMind server settings forwarded to the live MCP server only (not credentials). */
/**
 * The MCP server is started through this launcher, which gives the server a fresh environment of
 * MarketMind and platform variables only: the Anthropic credential the runtime needs never reaches it,
 * whatever the runtime adds to the configured stdio env.
 */
export const MCP_LAUNCHER = join(REPO_ROOT, "agent-sdk", "mcp-launcher.mjs");
export const LAUNCH_REPORT_ENV = "MARKETMIND_LAUNCH_REPORT";
export const GUARD_SOURCE = join(REPO_ROOT, "agent-sdk", "guard.ts");
const SERVER_ENV_PASSTHROUGH = ["MARKETMIND_DB", "MARKETMIND_GAMMA_URL", "MARKETMIND_CLOB_URL", "MARKETMIND_TIMEOUT_MS", "MARKETMIND_MAX_RETRIES"] as const;

export interface Isolation {
  /** Fresh empty working directory (outside the repository). */
  cwd: string;
  /** Fresh empty directory used as CLAUDE_CONFIG_DIR, HOME and profile dirs. */
  home: string;
}

/** The explicit subprocess environment: credentials only from ANTHROPIC_API_KEY; config and home isolated. */
export function buildEnv(parent: Record<string, string | undefined>, iso: Isolation): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_PASSTHROUGH) {
    const v = parent[k];
    if (typeof v === "string" && v !== "") env[k] = v;
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: join(iso.home, ".claude"),
    HOME: iso.home,
    USERPROFILE: iso.home,
    APPDATA: join(iso.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(iso.home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(iso.home, ".config"),
    XDG_DATA_HOME: join(iso.home, ".local", "share"),
    XDG_CACHE_HOME: join(iso.home, ".cache"),
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: `market-mind/${APP_VERSION}`,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  return env;
}

export interface ServerSpec {
  /** Absolute path of the launcher script (bin/marketmind-mcp.mjs or test-agent/scenario-mcp.mjs). */
  script: string;
  env: Record<string, string>;
  /** Command-line tag used to find orphaned server processes. */
  tag: string;
}

export function serverSpec(request: InvestigationRequest, parent: Record<string, string | undefined>, tag: string, fixtureDb: string | null, launchReport: string | null = null): ServerSpec {
  // The launcher appends its names-only self-report here; it is not passed on to the server.
  const report: Record<string, string> = launchReport ? { [LAUNCH_REPORT_ENV]: launchReport } : {};
  if (request.server === "fixture") {
    if (fixtureDb === null) throw new Error("fixture mode needs a seeded database path");
    return { script: join(REPO_ROOT, "test-agent", "scenario-mcp.mjs"), env: { MARKETMIND_DB: fixtureDb, ...report }, tag };
  }
  const env: Record<string, string> = {};
  for (const k of SERVER_ENV_PASSTHROUGH) if (typeof parent[k] === "string") env[k] = parent[k];
  return { script: join(REPO_ROOT, "bin", "marketmind-mcp.mjs"), env: { ...env, ...report }, tag };
}

export interface BuildInput {
  investigator: Investigator;
  request: InvestigationRequest;
  server: ServerSpec;
  iso: Isolation;
  parentEnv: Record<string, string | undefined>;
  maxBudgetUsd: number | null;
  abortController: AbortController;
  guard: Guard;
  stderr?: (data: string) => void;
  spawnClaudeCodeProcess?: Options["spawnClaudeCodeProcess"];
}

export function buildOptions(i: BuildInput): Options {
  const mcp: McpStdioServerConfig = { type: "stdio", command: process.execPath, args: [MCP_LAUNCHER, i.server.script, `--sdk-tag=${i.server.tag}`], env: i.server.env, alwaysLoad: true };
  return {
    agent: i.investigator.name,
    agents: { [i.investigator.name]: i.investigator.definition },
    tools: [],
    allowedTools: i.request.allowRules === "none" ? [] : [...MARKETMIND_TOOLS],
    disallowedTools: [...DISALLOWED_BUILTINS],
    skills: [],
    plugins: [],
    settings: structuredClone(SESSION_SETTINGS),
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { [MCP_SERVER]: mcp },
    permissionMode: "dontAsk",
    canUseTool: i.guard.canUseTool,
    hooks: {
      PreToolUse: [{ hooks: [i.guard.preToolUse] }],
      PostToolUse: [{ hooks: [i.guard.postToolUse] }],
      PostToolUseFailure: [{ hooks: [i.guard.postToolUseFailure] }],
    },
    ...(i.investigator.definition.maxTurns ? { maxTurns: i.investigator.definition.maxTurns } : {}),
    ...(i.maxBudgetUsd !== null ? { maxBudgetUsd: i.maxBudgetUsd } : {}),
    persistSession: false,
    includePartialMessages: false,
    cwd: i.iso.cwd,
    env: buildEnv(i.parentEnv, i.iso),
    abortController: i.abortController,
    ...(i.stderr ? { stderr: i.stderr } : {}),
    ...(i.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: i.spawnClaudeCodeProcess } : {}),
  };
}

/**
 * A serializable description of the options with machine-specific values removed (paths become
 * placeholders, environment values are dropped, functions are named). Its digest identifies the harness.
 */
export function describeOptions(o: Options, i: { investigator: Investigator; server: ServerSpec; timeoutMs: number }): Record<string, unknown> {
  const mcp = o.mcpServers?.[MCP_SERVER] as McpStdioServerConfig | undefined;
  return {
    agent: o.agent ?? null,
    agents: Object.fromEntries(Object.entries(o.agents ?? {}).map(([k, d]) => [k, { ...d, prompt: `<sha256:${sha256(d.prompt)}>` }])),
    tools: o.tools ?? null,
    allowedTools: o.allowedTools ?? [],
    disallowedTools: o.disallowedTools ?? [],
    skills: o.skills ?? null,
    plugins: o.plugins ?? null,
    settings: o.settings ?? null,
    settingSources: o.settingSources ?? null,
    strictMcpConfig: o.strictMcpConfig ?? false,
    mcpServers: mcp
      ? { [MCP_SERVER]: { type: mcp.type ?? "stdio", command: "<node>", launcher: `<repo>/${relative(REPO_ROOT, MCP_LAUNCHER).replace(/\\/g, "/")}`, script: `<repo>/${relative(REPO_ROOT, i.server.script).replace(/\\/g, "/")}`, envKeys: Object.keys(mcp.env ?? {}).sort(), alwaysLoad: mcp.alwaysLoad ?? false } }
      : {},
    permissionMode: o.permissionMode ?? null,
    allowDangerouslySkipPermissions: o.allowDangerouslySkipPermissions ?? false,
    canUseTool: o.canUseTool ? "deny-all canary" : null,
    hooks: Object.fromEntries(Object.entries(o.hooks ?? {}).map(([k, v]) => [k, (v ?? []).map((m) => ({ matcher: m.matcher ?? "*", hooks: m.hooks.length }))])),
    maxTurns: o.maxTurns ?? null,
    maxBudgetUsd: o.maxBudgetUsd ?? null,
    persistSession: o.persistSession ?? true,
    includePartialMessages: o.includePartialMessages ?? false,
    cwd: "<temp>/cwd",
    envKeys: Object.keys(o.env ?? {}).sort(),
    timeoutMs: i.timeoutMs,
    ignoredFrontmatter: i.investigator.ignoredFrontmatter,
  };
}

export function harnessOf(o: Options, described: Record<string, unknown>, i: { investigator: Investigator; timeoutMs: number }): Harness {
  return {
    mode: "agent-sdk",
    sdkPackage: SDK_PACKAGE,
    sdkVersion: SDK_VERSION,
    mainThreadAgent: o.agent ?? "",
    agentDefinitionSha256: sha256(JSON.stringify(i.investigator.definition)),
    permissionMode: o.permissionMode ?? "default",
    allowedTools: o.allowedTools ?? [],
    builtinTools: Array.isArray(o.tools) ? o.tools : ["<preset>"],
    disallowedTools: o.disallowedTools ?? [],
    settingSources: o.settingSources ?? ["<cli default: all>"],
    strictMcpConfig: o.strictMcpConfig ?? false,
    maxTurns: o.maxTurns ?? null,
    maxBudgetUsd: o.maxBudgetUsd ?? null,
    timeoutMs: i.timeoutMs,
    optionsDigest: sha256(stableStringify(described)),
    guardSha256: sha256(readFileSync(GUARD_SOURCE, "utf8")),
  };
}

export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2);
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
