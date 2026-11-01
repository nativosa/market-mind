// Explicit authentication for the Claude CLI evaluation harness. The mode is always chosen by the caller and
// never read from what happens to be in the shell, and the two modes never fall back to each other.
//
// Measured with the pinned CLI, using fake credentials and a dead proxy (test/unit/cliAuth.test.ts):
//   - `claude auth status --json` names the credential that would be used, locally and before any model
//     request. It reports the source, not validity: an expired login still reads as logged in.
//   - apiKeySource "none" in system/init also covers bearer tokens and cloud providers, so it proves nothing
//     alone, and init arrives after the forked skill's first model request, so it cannot gate one.
//   - rate_limit_event is seen only after a request has been made.
// So the gate is `auth status` before launch; init and rate_limit_event can only confirm or stop a run.
//
// Nothing here reads a credential file or a token. Output of `auth status` can include the account email and
// organization: it is parsed into the allowlisted fields of AuthEvidence and otherwise dropped.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";

export const AuthMode = z.enum(["subscription", "api-key"]);
export type AuthMode = z.infer<typeof AuthMode>;

/** Plans a personal subscription login can report. Anything else is not positive evidence. */
const SUBSCRIPTION_PLANS = ["pro", "max", "ultra"];
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
/** The Claude Code version bundled with the pinned SDK; the fields read here were measured on it. */
export const PINNED_CLI_VERSION: string = (JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve(SDK_PACKAGE)), "package.json"), "utf8")) as { claudeCodeVersion: string }).claudeCodeVersion;

export class AuthUsageError extends Error {}

/**
 * The requested mode. The CLI harness requires it. The SDK harness keeps its API-key behaviour and refuses
 * subscription mode until Gate G0 is resolved.
 */
export function authModeFor(harness: "cli" | "sdk", value: string | undefined): AuthMode {
  if (value !== undefined && !AuthMode.safeParse(value).success) throw new AuthUsageError("--auth must be subscription or api-key");
  if (harness === "sdk") {
    if (value === "subscription") throw new AuthUsageError("--harness sdk does not support --auth subscription: SDK subscription mode is held behind Gate G0");
    return "api-key";
  }
  if (value === undefined) throw new AuthUsageError("--harness cli needs an explicit --auth subscription or --auth api-key");
  return value as AuthMode;
}

/** Process and platform variables. None selects a credential, a provider or an endpoint. */
const PLATFORM = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "SystemDrive", "WINDIR", "COMSPEC", "ComSpec", "ProgramData", "ProgramFiles", "TEMP", "TMP", "TMPDIR", "LANG", "TZ"];
/** Where the normal login lives. Only subscription mode sees the real ones. */
const LOGIN_LOCATION = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "USER", "USERNAME", "LOGNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR"];

/**
 * The explicit environment of the spawned CLI, built from allowlists so that a credential variable this file
 * has never heard of is excluded too. Subscription mode keeps the real home directory and no credential.
 * API-key mode gets the key and an empty home, so the normal login cannot be picked up.
 */
export function cliEnv(mode: AuthMode, parent: Record<string, string | undefined>, isolatedHome: string): Record<string, string> {
  const env: Record<string, string> = { DISABLE_AUTOUPDATER: "1" };
  const copy = (names: string[]) => {
    for (const k of names) {
      const v = parent[k];
      if (typeof v === "string" && v !== "") env[k] = v;
    }
  };
  copy(PLATFORM);
  if (mode === "subscription") copy(LOGIN_LOCATION);
  else {
    copy(["ANTHROPIC_API_KEY"]);
    Object.assign(env, {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: join(isolatedHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
      CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"),
    });
  }
  return env;
}

/** The only fields of `auth status` that may ever be kept. */
export const AuthEvidence = z
  .object({
    loggedIn: z.boolean().nullable(),
    authMethod: z.string().nullable(),
    apiProvider: z.string().nullable(),
    apiKeySource: z.string().nullable(),
    subscriptionType: z.string().nullable(),
  })
  .strict();
export type AuthEvidence = z.infer<typeof AuthEvidence>;

export interface AuthAssessment {
  evidence: AuthEvidence;
  problems: string[];
}

const NO_EVIDENCE: AuthEvidence = { loggedIn: null, authMethod: null, apiProvider: null, apiKeySource: null, subscriptionType: null };

/** Fails closed: a missing, unknown or unexpected value is a problem, never a pass. */
export function assessAuthStatus(mode: AuthMode, stdout: string): AuthAssessment {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { evidence: NO_EVIDENCE, problems: ["`claude auth status --json` did not return JSON"] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { evidence: NO_EVIDENCE, problems: ["`claude auth status --json` did not return an object"] };
  const j = raw as Record<string, unknown>;
  const text = (k: string) => (typeof j[k] === "string" ? j[k] : null);
  const evidence: AuthEvidence = { loggedIn: typeof j.loggedIn === "boolean" ? j.loggedIn : null, authMethod: text("authMethod"), apiProvider: text("apiProvider"), apiKeySource: text("apiKeySource"), subscriptionType: text("subscriptionType") };
  const problems: string[] = [];
  if (evidence.loggedIn !== true) problems.push("the CLI reports no usable credential");
  if (evidence.apiProvider !== "firstParty") problems.push(`API provider is ${String(evidence.apiProvider)}, not the Anthropic API`);
  if (mode === "subscription") {
    if (evidence.authMethod !== "claude.ai") problems.push(`credential is ${String(evidence.authMethod)}, not a claude.ai login`);
    // A login can sit beside a stored key: authMethod still says claude.ai, and apiKeySource shows the key.
    if (evidence.apiKeySource !== null) problems.push(`an API key is configured alongside the login (${evidence.apiKeySource}), so API billing cannot be ruled out`);
    if (!SUBSCRIPTION_PLANS.includes(evidence.subscriptionType ?? "")) problems.push(`subscription type ${String(evidence.subscriptionType)} is not a recognized personal plan`);
  } else {
    if (evidence.authMethod !== "api_key") problems.push(`credential is ${String(evidence.authMethod)}, not an API key`);
    if (evidence.apiKeySource !== "ANTHROPIC_API_KEY") problems.push(`key source is ${String(evidence.apiKeySource)}, not ANTHROPIC_API_KEY`);
    if (evidence.subscriptionType !== null) problems.push("a subscription login is visible to the API-key run");
  }
  return { evidence, problems };
}

export interface CommandResult {
  status: number | null;
  stdout: string;
}
export type RunCommand = (args: string[], options: { env: Record<string, string>; cwd: string }) => CommandResult;

/** Runs the CLI without a shell. Output stays in memory and only allowlisted fields leave this module. */
export const runClaude: RunCommand = (args, options) => {
  const r = spawnSync("claude", args, { ...options, encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.status, stdout: r.stdout ?? "" };
};

export interface Preflight extends AuthAssessment {
  mode: AuthMode;
  cliVersion: string | null;
  passed: boolean;
}

/** The gate before any model request. It runs under the exact environment the run will use. */
export function authPreflight(mode: AuthMode, env: Record<string, string>, cwd: string, run: RunCommand = runClaude): Preflight {
  const version = run(["--version"], { env, cwd });
  const cliVersion = /^\s*(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? null;
  const fail = (problem: string, evidence = NO_EVIDENCE): Preflight => ({ mode, cliVersion, evidence, problems: [problem], passed: false });
  if (version.status !== 0 || cliVersion === null) return fail("the Claude CLI did not report a version");
  if (cliVersion !== PINNED_CLI_VERSION) return fail(`Claude CLI ${cliVersion} is not the pinned ${PINNED_CLI_VERSION}, whose authentication fields were measured`);
  const status = run(["auth", "status", "--json"], { env, cwd });
  const assessed = assessAuthStatus(mode, status.stdout);
  const problems = status.status === 0 ? assessed.problems : [`\`claude auth status\` exited ${String(status.status)}`, ...assessed.problems];
  return { mode, cliVersion, evidence: assessed.evidence, problems, passed: problems.length === 0 };
}

/** The init pool of the 23 recorded v0.5.0 CLI runs, on the pinned CLI. Anything beyond it stops the run. */
const KNOWN_TOOLS = ["Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree", "ExitWorktree", "Glob", "Grep", "ListAgents", "Monitor", "NotebookEdit", "PowerShell", "PushNotification", "Read", "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "SendMessage", "Skill", "TaskStop", "ToolSearch", "WebSearch", "Write"];
const MCP_TOOLS = ["scan_markets", "inspect_market", "list_collection_runs", "get_market_history", "get_observation_details"].map((t) => `mcp__marketmind__${t}`);
const KNOWN_AGENTS = ["claude", "Explore", "general-purpose", "market-investigator", "Plan", "statusline-setup", "web-fetch"];
const KNOWN_SKILLS = ["investigate-market", "design", "design-sync", "dataviz", "update-config", "verify", "debug", "code-review", "simplify", "batch", "fewer-permission-prompts", "doctor", "loop", "schedule", "claude-api", "run", "run-skill-generator", "plugin-authoring"];

interface InitEvent {
  apiKeySource?: unknown;
  permissionMode?: unknown;
  tools?: unknown;
  agents?: unknown;
  skills?: unknown;
  plugins?: unknown;
  mcp_servers?: unknown;
}
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Authentication and boundary problems in a system/init event. Lists only what is unexpected, never a value it was not asked for. */
export function initProblems(mode: AuthMode, init: InitEvent): string[] {
  const problems: string[] = [];
  const key = typeof init.apiKeySource === "string" ? init.apiKeySource : null;
  if (mode === "subscription" && key !== "none") problems.push(`init reports key source ${String(key)}, so the run is not on the subscription login`);
  if (mode === "api-key" && key !== "ANTHROPIC_API_KEY") problems.push(`init reports key source ${String(key)}, not ANTHROPIC_API_KEY`);
  if (init.permissionMode !== "default") problems.push(`permission mode is ${String(init.permissionMode)}, not default`);
  const tools = strings(init.tools);
  const mcp = tools.filter((t) => t.startsWith("mcp__"));
  if (mcp.length !== MCP_TOOLS.length || !MCP_TOOLS.every((t) => mcp.includes(t))) problems.push(`MCP tools are [${mcp.join(", ")}], expected exactly the five MarketMind tools`);
  const unknown = (found: string[], known: string[], what: string) => {
    const extra = found.filter((x) => !known.includes(x));
    if (extra.length > 0) problems.push(`unexpected ${what}: ${extra.join(", ")}`);
  };
  unknown(tools.filter((t) => !t.startsWith("mcp__")), KNOWN_TOOLS, "tools");
  unknown(strings(init.agents), KNOWN_AGENTS, "agents");
  unknown(strings(init.skills), KNOWN_SKILLS, "skills");
  const plugins = Array.isArray(init.plugins) ? (init.plugins as { name?: unknown; path?: unknown }[]) : [];
  unknown(plugins.filter((p) => p.path !== "builtin").map((p) => String(p.name)), [], "plugins");
  const servers = Array.isArray(init.mcp_servers) ? (init.mcp_servers as { name?: unknown }[]) : [];
  unknown(servers.map((s) => String(s.name)).filter((n) => n !== "marketmind"), [], "MCP servers");
  return problems;
}

/** What a run's stream showed about authentication. Safe to record: no account data. */
export const AuthRecord = z
  .object({
    mode: AuthMode,
    preflight: AuthEvidence.optional(),
    cliVersion: z.string().nullable().optional(),
    initApiKeySource: z.string().nullable().optional(),
    /** Reported by the stream only after a model request, and only as supporting evidence. */
    rateLimitEventSeen: z.boolean().optional(),
    overageUsed: z.boolean().optional(),
    problems: z.array(z.string()).optional(),
  })
  .strict();
export type AuthRecord = z.infer<typeof AuthRecord>;

/**
 * Watches the CLI's stream as it arrives. This cannot prevent spending: init comes after the first model
 * request. It stops a run as soon as it shows the wrong credential, a wider boundary or extra usage.
 */
export class StreamWatch {
  private buffer = "";
  private sawInit = false;
  initApiKeySource: string | null = null;
  rateLimitEventSeen = false;
  overageUsed = false;
  readonly problems: string[] = [];

  constructor(private readonly mode: AuthMode) {}

  /** Feeds stdout; returns the reason to stop, if there is one. */
  feed(chunk: string): string | null {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.line(line);
    return this.problems[0] ?? null;
  }

  private line(line: string): void {
    let e: { type?: unknown; subtype?: unknown; apiKeySource?: unknown; rate_limit_info?: { isUsingOverage?: unknown; overageInUse?: unknown } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      return;
    }
    if (e.type === "system" && e.subtype === "init" && !this.sawInit) {
      this.sawInit = true;
      this.initApiKeySource = typeof e.apiKeySource === "string" ? e.apiKeySource : null;
      this.problems.push(...initProblems(this.mode, e));
    }
    if (e.type === "rate_limit_event") {
      this.rateLimitEventSeen = true;
      if (this.mode === "api-key") this.problems.push("a subscription rate-limit event appeared in an API-key run");
      if (e.rate_limit_info?.isUsingOverage === true || e.rate_limit_info?.overageInUse === true) {
        this.overageUsed = true;
        this.problems.push("the run is drawing on extra usage, which can be charged");
      }
    }
  }

  /** Problems for a stream that ended: no init means nothing confirmed the credential. */
  finish(): string[] {
    return this.sawInit ? this.problems : [...this.problems, "the stream had no init event, so the credential was not confirmed"];
  }
}

/** MCP config for one run. The server starts through the launcher, which rebuilds its environment, so no credential reaches it. */
export function mcpConfig(launcher: string, serverScript: string, tag: string, db: string, launchReport: string): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { marketmind: { type: "stdio", command: process.execPath, args: [launcher, serverScript, `--eval-tag=${tag}`], env: { MARKETMIND_DB: db, MARKETMIND_LAUNCH_REPORT: launchReport } } } };
}

/** Why a launcher report shows a credential or an unexpected variable reaching the server. */
export function serverEnvProblems(reports: { serverEnvKeys: string[] }[]): string[] {
  if (reports.length === 0) return ["the MCP launcher left no report, so credential isolation was not confirmed"];
  const bad = [...new Set(reports.flatMap((r) => r.serverEnvKeys))].filter((k) => !k.startsWith("MARKETMIND_") && !/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/i.test(k));
  return bad.length > 0 ? [`the MCP server received unexpected variables: ${bad.join(", ")}`] : [];
}
