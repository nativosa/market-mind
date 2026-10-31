// One bounded investigation session: credentials check, isolation, gated prompt, pre-flight, streaming,
// timeout and cancellation, and cleanup with bounded deadlines. Every side effect (the SDK query, child
// processes, hashing, temp directories, the clock) is injected, so the whole state machine runs offline.
//
// Lifecycle:
//   1. No ANTHROPIC_API_KEY             -> missing_credentials (nothing spawned).
//   2. Options built and checked         -> invalid_options when an invariant fails or the SDK rejects them.
//   3. query() with a GATED prompt: the user message is not released until pre-flight passes:
//        initializationResult(): apiKeySource must be ANTHROPIC_API_KEY, the investigator agent present;
//        mcpServerStatus(): only "marketmind", connected, exposing exactly the five tools.
//      The initialize handshake happens without a prompt. Whether the CLI makes any API request before the
//      first prompt is NOT established offline (see agent-sdk/README.md); it is never assumed to be free.
//   4. The first system/init after release is the second phase (effective tool pool, skills, plugins, auth
//      source, mode); a mismatch aborts the session (a model request may already have been made). The record
//      keeps the phases apart: preflight is step 3, effectiveSession is this step.
//   5. Messages stream until the result; timeout or cancellation abort -> interrupt() -> close().
//   6. finally: close(), wait for the CLI to exit (deadline), force-kill its tree, sweep orphaned MCP
//      servers by tag, remove temp dirs. A cleanup problem is never reported as a successful run.
import type { McpServerStatus, McpStdioServerConfig, Options, SDKControlInitializeResponse, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { parseReport, statedLabels } from "../test-agent/eval/report.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXECUTION_CONTRACT, INVESTIGATION_CONTRACT, LauncherReport, type Cleanup, type EffectiveSession, type ExecutionRecord, type InvestigationRequest, type InvestigationResult, type Preflight, type ResultSnapshot, type SessionStatus } from "./contract.js";
import { Recorder, type Progress } from "./events.js";
import { createGuard, MARKETMIND_TOOLS, MCP_SERVER } from "./guard.js";
import { sha256, type Investigator } from "./investigator.js";
import { buildOptions, describeOptions, harnessOf, MCP_LAUNCHER, serverSpec, SESSION_SETTINGS, stableStringify, type Isolation, type ServerSpec } from "./options.js";
import { Redactor } from "./redact.js";

/** The subset of the SDK Query this application uses. */
export interface QueryHandle extends AsyncIterable<SDKMessage> {
  initializationResult(): Promise<SDKControlInitializeResponse>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  interrupt(): Promise<unknown>;
  close(): void;
}
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;

export interface ChildHandle extends SpawnedProcess {
  readonly pid?: number | undefined;
  stderr?: { on(event: "data", listener: (d: Buffer | string) => void): unknown } | null;
}

export interface SessionDeps {
  query: QueryFn;
  parentEnv: Record<string, string | undefined>;
  /** Creates the isolated cwd and home; remove() deletes them (may throw). */
  isolation(): Isolation & { remove(): void };
  /** Seeds the fixture database for a fixture request; returns its path. */
  seedFixture(dir: string): string;
  /** Spawns the Claude Code CLI (the SDK hands us command, args, cwd and env). */
  spawn(options: SpawnOptions): ChildHandle;
  processesTagged(tag: string): number[];
  killTree(pid: number): void;
  hashFile(path: string): string | null;
  repoState(): string | null;
  databasePath(request: InvestigationRequest, fixtureDb: string | null): string | null;
  tag(): string;
  onProgress?(p: Progress): void;
  /** Timer hooks (tests use fake timers). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

export interface SessionConfig {
  investigator: Investigator;
  request: InvestigationRequest;
  maxBudgetUsd: number;
  timeoutMs: number;
  /** Deadlines for pre-flight and cleanup phases. */
  preflightMs?: number;
  cleanupMs?: number;
  abort?: AbortController;
}

export interface SessionOutcome {
  record: ExecutionRecord;
  result: InvestigationResult;
  /** SDK messages, redacted, for --out artifacts. */
  messages: unknown[];
  stderr: string;
}

const API_KEY_SOURCE = "ANTHROPIC_API_KEY";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const setEq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const qualify = (name: string) => (name.startsWith("mcp__") ? name : `mcp__${MCP_SERVER}__${name}`);

class Deadline extends Error {}
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Deadline(`${what} exceeded ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/** Reads the launcher's JSON-lines self-report; a malformed line is a problem, never ignored. */
export function readLauncherReports(path: string): { reports: LauncherReport[]; problems: string[] } {
  if (!existsSync(path)) return { reports: [], problems: [] };
  const reports: LauncherReport[] = [];
  const problems: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    const r = LauncherReport.safeParse(parsed);
    if (r.success) reports.push(r.data);
    else problems.push("malformed MCP launcher report line");
  }
  return { reports, problems };
}

/** Pure check of the security invariants of built options; returns the violations. */
export function optionViolations(o: Options): string[] {
  const v: string[] = [];
  if (o.permissionMode !== "dontAsk") v.push(`permissionMode must be dontAsk, got ${String(o.permissionMode)}`);
  if (o.allowDangerouslySkipPermissions) v.push("allowDangerouslySkipPermissions must not be set");
  if (!Array.isArray(o.tools) || o.tools.length !== 0) v.push("tools must be [] (no built-in tools)");
  if (!Array.isArray(o.settingSources) || o.settingSources.length !== 0) v.push("settingSources must be []");
  if (o.strictMcpConfig !== true) v.push("strictMcpConfig must be true");
  // No allow rules at all (the permission probe) is stricter, never looser.
  if (!setEq(o.allowedTools ?? [], MARKETMIND_TOOLS) && (o.allowedTools ?? []).length !== 0) v.push("allowedTools must be exactly the five MarketMind tools (or none, for the permission probe)");
  if ((o.allowedTools ?? []).some((t) => t.includes("*"))) v.push("allowedTools must not contain wildcards");
  if (Object.keys(o.mcpServers ?? {}).join(",") !== MCP_SERVER) v.push(`mcpServers must contain only ${MCP_SERVER}`);
  const server = o.mcpServers?.[MCP_SERVER] as McpStdioServerConfig | undefined;
  if (server?.command !== process.execPath || server.args?.[0] !== MCP_LAUNCHER) v.push("the MCP server must start through the environment-sanitizing launcher");
  for (const k of Object.keys(server?.env ?? {})) if (!k.startsWith("MARKETMIND_")) v.push(`the MCP server env must not carry ${k}`);
  if (!Array.isArray(o.skills) || o.skills.length !== 0) v.push("skills must be []");
  // Exact: inline settings can also carry permissions, hooks or env, so nothing else may appear here.
  if (stableStringify(o.settings) !== stableStringify(SESSION_SETTINGS)) v.push("settings must be exactly SESSION_SETTINGS");
  if (!o.env) v.push("env must be an explicit allowlist");
  for (const k of Object.keys(o.env ?? {})) if (/TOKEN|OAUTH|BEDROCK|VERTEX|FOUNDRY|_AWS|BASE_URL|SESSION/i.test(k)) v.push(`env must not carry ${k}`);
  if (o.persistSession !== false) v.push("persistSession must be false");
  if (!o.hooks?.PreToolUse?.length) v.push("the PreToolUse guard must be installed");
  if (!o.agent || !o.agents?.[o.agent]) v.push("the investigator must run as the main-thread agent");
  return v;
}

export async function runInvestigation(cfg: SessionConfig, deps: SessionDeps): Promise<SessionOutcome> {
  const preflightMs = cfg.preflightMs ?? 60_000;
  const cleanupMs = cfg.cleanupMs ?? 10_000;
  const abort = cfg.abort ?? new AbortController();
  const redactor = new Redactor(deps.parentEnv.ANTHROPIC_API_KEY ? [deps.parentEnv.ANTHROPIC_API_KEY] : []);
  const recorder = new Recorder();
  const guard = createGuard({ mode: cfg.request.mode, syntheticAuthorized: cfg.request.syntheticAuthorized, agentName: cfg.investigator.name });
  const prompt = cfg.investigator.renderPrompt(cfg.request.arguments);
  const messages: unknown[] = [];
  const cleanup: Cleanup = { closeCalled: false, childExited: null, forcedKill: false, orphansFound: 0, orphansKilled: 0, tempRemoved: false, problems: [] };
  let stderr = "";
  let status = "error" as SessionStatus;
  let statusDetail = "";
  let preflight: Preflight | null = null;
  let effectiveSession: EffectiveSession | null = null;
  const tag = deps.tag();
  const progress = (p: Progress) => deps.onProgress?.({ kind: p.kind, text: redactor.text(p.text) });
  const finish = (s: SessionStatus, detail: string) => {
    status = s;
    statusDetail = detail;
  };

  let options: Options | null = null;
  let iso: (Isolation & { remove(): void }) | null = null;
  let child: ChildHandle | null = null;
  let q: QueryHandle | null = null;
  let fixtureDb: string | null = null;
  let server: ServerSpec | null = null;
  let launchReport: string | null = null;
  let launcher: LauncherReport[] = [];
  const recorderProblems: string[] = [];
  let dbPath: string | null = null;
  let dbBefore: string | null = null;
  let repoBefore: string | null = null;
  let abortReason = null as "timeout" | "cancelled" | "preflight" | null;

  if (!deps.parentEnv.ANTHROPIC_API_KEY) {
    finish("missing_credentials", "ANTHROPIC_API_KEY is not set; the SDK application never uses Claude Code login credentials");
  } else {
    let timer: unknown = null;
    try {
      iso = deps.isolation();
      if (cfg.request.server === "fixture") fixtureDb = deps.seedFixture(iso.home);
      dbPath = deps.databasePath(cfg.request, fixtureDb);
      dbBefore = dbPath ? deps.hashFile(dbPath) : null;
      repoBefore = deps.repoState();
      launchReport = join(iso.home, "mcp-launcher.jsonl");
      server = serverSpec(cfg.request, deps.parentEnv, tag, fixtureDb, launchReport);
      options = buildOptions({
        investigator: cfg.investigator,
        request: cfg.request,
        server,
        iso,
        parentEnv: deps.parentEnv,
        maxBudgetUsd: cfg.maxBudgetUsd,
        abortController: abort,
        guard,
        stderr: (d) => (stderr += d),
        spawnClaudeCodeProcess: (so) => {
          const c = deps.spawn(so);
          child = c;
          c.stderr?.on("data", (d) => (stderr += d.toString()));
          // The SDK aborts this forwarded signal only after its graceful stdin-close window.
          so.signal.addEventListener("abort", () => {
            if (c.exitCode === null && c.pid) deps.killTree(c.pid);
          });
          return c;
        },
      });
      const violations = optionViolations(options);
      if (violations.length) throw Object.assign(new Error(violations.join("; ")), { invalidOptions: true });

      let release!: (go: boolean) => void;
      const gate = new Promise<boolean>((r) => (release = r));
      let finished!: () => void;
      const done = new Promise<void>((r) => (finished = r));
      async function* gatedPrompt(): AsyncGenerator<SDKUserMessage> {
        if (!(await gate)) return;
        yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
        await done; // keep the input open until the result arrives (single-turn session)
      }
      abort.signal.addEventListener("abort", () => {
        release(false);
        finished();
      });
      const st = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      timer = st(() => {
        abortReason ??= "timeout";
        abort.abort("timeout");
      }, cfg.timeoutMs);

      try {
        q = deps.query({ prompt: gatedPrompt(), options });
      } catch (e) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { invalidOptions: true });
      }

      // Pre-flight before any prompt is sent.
      preflight = await within(runPreflight(q, cfg.investigator.name), preflightMs, "pre-flight");
      if (!preflight.passed) {
        const authProblem = preflight.problems.find((p) => p.startsWith("auth:"));
        const mcpProblem = preflight.problems.find((p) => p.startsWith("mcp:"));
        abortReason = "preflight";
        finish(authProblem ? "auth_source_rejected" : mcpProblem ? "mcp_failed" : "preflight_failed", preflight.problems.join("; "));
        release(false);
        finished();
      } else {
        progress({ kind: "init", text: `pre-prompt pre-flight passed: API key source, investigator agent, ${MARKETMIND_TOOLS.length} MarketMind tools` });
        release(true);
        for await (const m of q) {
          messages.push(redactor.value(m));
          for (const p of recorder.push(m)) progress(p);
          if (m.type === "assistant" && m.error === "authentication_failed") finish("auth_failed", "the API rejected the credentials");
          if (m.type === "system" && m.subtype === "permission_denied") guard.permissionDenied(m.tool_use_id);
          if (m.type === "system" && m.subtype === "init" && recorder.initCount === 1) {
            const problems = initProblems(recorder.init!);
            effectiveSession = { problems, passed: problems.length === 0 };
            if (problems.length) {
              abortReason = "preflight";
              finish("preflight_failed", `effective session differs from the approved configuration (first system/init, after the pre-prompt pre-flight passed): ${problems.join("; ")}`);
              abort.abort("preflight");
              break;
            }
          }
          if (m.type === "result") {
            finished();
            break;
          }
        }
      }
      if (abortReason === "timeout") finish("timeout", `no result within ${cfg.timeoutMs} ms`);
      else if (abortReason === "cancelled") finish("cancelled", "cancelled by the user");
      else if (abortReason === null) {
        if (status === "auth_failed") {
          /* keep */
        } else if (abort.signal.aborted) finish("cancelled", "cancelled by the user");
        else if (!recorder.result) finish("truncated", "the message stream ended without a result");
        else finish(...statusOfResult(recorder.result.subtype, recorder.result.errors, recorder.result));
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (abort.signal.aborted && abortReason === null) abortReason = abort.signal.reason === "timeout" ? "timeout" : "cancelled";
      if ((err as { invalidOptions?: boolean }).invalidOptions) finish("invalid_options", err.message);
      else if (abortReason === "timeout" || err instanceof Deadline) finish("timeout", err instanceof Deadline ? err.message : `no result within ${cfg.timeoutMs} ms`);
      else if (abortReason === "cancelled") finish("cancelled", "cancelled by the user");
      else if (abortReason !== "preflight") finish("error", err.message);
    } finally {
      if (timer !== null) (deps.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(timer);
      if (abort.signal.aborted && q) {
        try {
          await within(Promise.resolve(q.interrupt()), 2_000, "interrupt");
        } catch {
          /* interrupt is best-effort; close() follows */
        }
      }
      if (!abort.signal.aborted) abort.abort("finished");
    }
  }

  // Cleanup, always, with bounded deadlines.
  if (q) {
    try {
      (q).close();
      cleanup.closeCalled = true;
    } catch (e) {
      cleanup.problems.push(`close() failed: ${String(e)}`);
    }
  }
  const c = child as ChildHandle | null;
  if (c) {
    const exited = c.exitCode !== null || c.signalCode != null || (await waitExit(c, cleanupMs));
    if (!exited && c.pid) {
      deps.killTree(c.pid);
      cleanup.forcedKill = true;
      cleanup.childExited = await waitExit(c, cleanupMs);
      if (!cleanup.childExited) cleanup.problems.push("the Claude Code process did not exit after a forced kill");
    } else cleanup.childExited = exited;
  }
  if (options) {
    const orphans = deps.processesTagged(tag);
    cleanup.orphansFound = orphans.length;
    for (const pid of orphans) deps.killTree(pid);
    const remaining = orphans.length ? deps.processesTagged(tag) : [];
    cleanup.orphansKilled = orphans.length - remaining.length;
    if (remaining.length) cleanup.problems.push(`${remaining.length} MarketMind server process(es) survived cleanup`);
  }
  if (launchReport) {
    const read = readLauncherReports(launchReport);
    launcher = read.reports;
    recorderProblems.push(...read.problems);
    if (preflight?.passed && launcher.length === 0) recorderProblems.push("the MCP launcher left no report although the server connected");
    for (const r of launcher) if (r.serverEnvKeys.some((k) => !k.startsWith("MARKETMIND_") && !/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/i.test(k))) recorderProblems.push(`launcher passed an unexpected variable to the server: ${r.serverEnvKeys.join(",")}`);
  }
  const dbAfter = dbPath ? deps.hashFile(dbPath) : null;
  const repoAfter = options ? deps.repoState() : null;
  if (iso) {
    try {
      iso.remove();
      cleanup.tempRemoved = true;
    } catch (e) {
      cleanup.problems.push(`temporary directories not removed: ${redactor.text(String(e))}`);
    }
  }
  if (cleanup.problems.length && (status === "completed" || status === "error" || status === "api_error")) finish("cleanup_failed", `${statusDetail ? `${status}: ${statusDetail}; ` : ""}${cleanup.problems.join("; ")}`);

  recorder.reconcile(guard);
  const report = recorder.reportText();
  const parsed = parseReport(report);
  const described = options && server ? describeOptions(options, { investigator: cfg.investigator, server, timeoutMs: cfg.timeoutMs }) : {};
  const harness = harnessOf(options ?? ({}), described, { investigator: cfg.investigator, timeoutMs: cfg.timeoutMs });
  const investigatorHashes = { ...cfg.investigator.hashes, promptSha256: sha256(prompt) };
  const calls = [...recorder.calls.values()];
  const record: ExecutionRecord = {
    contract: EXECUTION_CONTRACT,
    source: "agent-sdk",
    harness,
    investigator: investigatorHashes,
    status,
    statusDetail: redactor.text(statusDetail),
    preflight,
    effectiveSession,
    init: recorder.init,
    initCount: recorder.initCount,
    toolCalls: calls,
    guard: guard.decisions,
    canUseToolCalls: guard.canUseToolCalls,
    assistantText: recorder.assistantText,
    models: [...recorder.models].sort(),
    nestedAgentMessages: recorder.nestedAgentMessages,
    result: recorder.result,
    resultCount: recorder.resultCount,
    messageCount: recorder.messageCount,
    problems: [...recorder.problems, ...recorderProblems],
    mcpLauncher: launcher,
    cleanup,
  };
  const warnings: string[] = [];
  if (recorder.problems.length || recorderProblems.length) warnings.push(...recorder.problems, ...recorderProblems);
  if (guard.canUseToolCalls.length) warnings.push(`canUseTool was reached ${guard.canUseToolCalls.length} time(s) (denied)`);
  if (recorder.result?.modelUsage && Object.values(recorder.result.modelUsage).some((u) => u.costBasis !== "list")) warnings.push("cost basis is not list price; treat cost as unknown");
  const result: InvestigationResult = {
    contract: INVESTIGATION_CONTRACT,
    request: cfg.request,
    status,
    statusDetail: redactor.text(statusDetail),
    harness,
    investigator: investigatorHashes,
    toolCalls: calls.map((t) => ({ seq: t.seq, name: t.name, input: t.input, outcome: t.outcome, errorCategory: t.errorCategory, deniedBy: t.deniedBy })),
    denials: guard.decisions.filter((d) => d.decision === "deny"),
    report: { markdown: report, classification: report ? statedLabels(parsed) : [], sectionsPresent: parsed.sections.map((x) => x.n) },
    usage: {
      estimatedCostUsd: recorder.result?.totalCostUsd ?? null,
      costBasis: Object.values(recorder.result?.modelUsage ?? {})[0]?.costBasis ?? null,
      durationMs: recorder.result?.durationMs ?? null,
      numTurns: recorder.result?.numTurns ?? null,
      models: [...recorder.models].sort(),
    },
    integrity: {
      database: dbPath === null ? "unknown" : dbBefore === null && dbAfter === null ? "absent" : dbBefore === dbAfter ? "unchanged" : "changed",
      repository: repoBefore === null || repoAfter === null ? "unknown" : repoBefore === repoAfter ? "unchanged" : "changed",
    },
    cleanup,
    warnings: warnings.map((w) => redactor.text(w)),
  };
  return { record: redactor.value(record), result: redactor.value(result), messages, stderr: redactor.text(stderr) };
}

function waitExit(c: ChildHandle, ms: number): Promise<boolean> {
  if (c.exitCode !== null || c.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      c.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(t);
      resolve(true);
    };
    c.once("exit", onExit);
  });
}

async function runPreflight(q: QueryHandle, agentName: string): Promise<Preflight> {
  const problems: string[] = [];
  const init = await q.initializationResult();
  const apiKeySource = init.account?.apiKeySource ?? null;
  const apiProvider = init.account?.apiProvider ?? null;
  if (apiKeySource !== API_KEY_SOURCE) problems.push(`auth: credential source ${JSON.stringify(apiKeySource)} is not ${API_KEY_SOURCE}`);
  if (apiProvider !== null && apiProvider !== "firstParty") problems.push(`auth: API provider ${apiProvider} is not the Anthropic API`);
  const agentsAvailable = (init.agents ?? []).map((a) => a.name).sort();
  if (!agentsAvailable.includes(agentName)) problems.push(`agent: ${agentName} is not registered`);
  let servers = await q.mcpServerStatus();
  for (let i = 0; i < 10 && servers.some((s) => s.status === "pending"); i++) {
    await sleep(250);
    servers = await q.mcpServerStatus();
  }
  const mcpServers = servers.map((s) => ({ name: s.name, status: s.status, source: s.source ?? null, tools: (s.tools ?? []).map((t) => qualify(t.name)).sort() }));
  const mm = mcpServers.find((s) => s.name === MCP_SERVER);
  const others = mcpServers.filter((s) => s.name !== MCP_SERVER);
  if (others.length) problems.push(`mcp: unexpected servers ${others.map((s) => s.name).join(", ")}`);
  if (!mm) problems.push(`mcp: server ${MCP_SERVER} missing`);
  else {
    if (mm.status !== "connected") problems.push(`mcp: ${MCP_SERVER} is ${mm.status}`);
    else if (!setEq(mm.tools, MARKETMIND_TOOLS)) problems.push(`mcp: ${MCP_SERVER} exposes ${mm.tools.length} tools, expected exactly the five MarketMind tools`);
  }
  return { apiKeySource, apiProvider, agentsAvailable, mcpServers, problems, passed: problems.length === 0 };
}

export function initProblems(init: NonNullable<Recorder["init"]>): string[] {
  const p: string[] = [];
  if (!setEq(init.tools, MARKETMIND_TOOLS)) p.push(`tool pool is [${init.tools.join(", ")}], expected exactly the five MarketMind tools`);
  if (init.apiKeySource !== API_KEY_SOURCE) p.push(`apiKeySource ${String(init.apiKeySource)}`);
  if (init.permissionMode !== "dontAsk") p.push(`permission mode ${String(init.permissionMode)}`);
  if (init.mcpServers.some((s) => s.name !== MCP_SERVER)) p.push("unexpected MCP servers");
  if (init.skills.length) p.push(`skills present: ${init.skills.join(", ")}`);
  if (init.plugins.length) p.push(`plugins present: ${init.plugins.join(", ")}`);
  return p;
}

/**
 * The session status of a result message. Subtype "success" means the loop ended, not that a report exists:
 * an API failure arrives as success with is_error true, after a synthetic assistant message.
 */
export function statusOfResult(subtype: string, errors: string[], outcome: Partial<Pick<ResultSnapshot, "isError" | "terminalReason" | "resultText">> = {}): [SessionStatus, string] {
  if (subtype === "success" && outcome.isError === true) {
    const text = outcome.resultText?.trim() || "no detail";
    return outcome.terminalReason === "api_error" ? ["api_error", `the API request failed: ${text}`] : ["error", `the result is flagged is_error (${outcome.terminalReason ?? "no terminal reason"}): ${text}`];
  }
  switch (subtype) {
    case "success":
      return ["completed", "the investigator returned a report"];
    case "error_max_turns":
      return ["max_turns", "the investigator reached its maximum number of turns"];
    case "error_max_budget_usd":
      return ["budget_stopped", "the estimated cost reached --max-budget-usd"];
    default:
      return ["error", `${subtype}${errors.length ? `: ${errors.join("; ")}` : ""}`];
  }
}
