// One bounded investigation of one real Polymarket market, on the owner's Claude subscription (manual; uses
// model quota; never part of CI). A demonstration, not an evaluation: nothing here is graded, and no scenario,
// fixture or synthetic database is involved.
//
//   npx tsx test-agent/live.ts --auth subscription --market-id <gammaId> --max-budget-usd 0.40 --out .live-out/<name> [--timeout-ms 300000] [--check]
//
// --check runs the gate and prints the resolved configuration: no prompt, no model request, no artifact.
//
// The session is the CLI harness's (cliAuth.ts): the authentication gate, the five-tool flags, the stream watch
// and the launcher. What differs is the server: the real bin/marketmind-mcp.mjs, with a process ceiling of 16 HTTP
// attempts and synthetic data off. Both are server settings, so they hold whatever the model calls. The server
// reads the local database if there is one and never creates it, so a missing database is reported, not filled.
//
// After the session every tool result is checked against what a live run must look like (liveProblems). That
// establishes where the evidence came from and that the report is well formed, never that the report is right.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, UsageError } from "../agent-sdk/args.js";
import { MARKETMIND_TOOLS } from "../agent-sdk/guard.js";
import { MCP_LAUNCHER, stableStringify } from "../agent-sdk/options.js";
import { Redactor } from "../agent-sdk/redact.js";
import { readLauncherReports } from "../agent-sdk/session.js";
import { APP_VERSION, DEFAULT_CONFIG, DEFAULT_DB_PATH } from "../src/config/config.js";
import { authModeFor, authPreflight, AuthUsageError, cliEnv, cliFlags, mcpConfig, serverEnvProblems, StreamWatch, type Preflight } from "./cliAuth.js";
import { LABELS, parseReport, statedLabels } from "./eval/report.js";
import { isMarketMind, parseTrace, shortName, type ParsedTrace, type ToolCall } from "./eval/trace.js";
import { INVESTIGATOR_FILES, investigator, killTree, processesTagged, REPO, repoState, sha256, treeHash } from "./processes.js";

export const LIVE_ROOT = join(REPO, ".live-out");
/** HTTP attempts per investigation, retries included: two full inspections, enforced by the server's live gate. */
export const REQUEST_CEILING = 16;
export const LIVE_HOSTS = [new URL(DEFAULT_CONFIG.gammaBaseUrl).hostname, new URL(DEFAULT_CONFIG.clobBaseUrl).hostname];
/** The investigator's Mode A budget. The CLI has no per-call guard, so this is checked after the session. */
const MODE_A_CALLS = 7;
const SECTIONS = 10;
const SERVER_SCRIPT = join(REPO, "bin", "marketmind-mcp.mjs");
export const SERVER_SETTINGS = { MARKETMIND_MCP_MAX_REQUESTS: String(REQUEST_CEILING), MARKETMIND_LIVE_ONLY: "1" };

export interface LiveOptions {
  marketId: string;
  prompt: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  out: string;
  check: boolean;
}

const FLAGS_WITH_VALUE = ["--market-id", "--max-budget-usd", "--timeout-ms"];

/** The market always comes from the command line. There is no free-text objective, the one route to authorizing synthetic history. */
export function parseLiveArgs(argv: string[]): LiveOptions {
  const forwarded: string[] = [];
  let auth: string | undefined;
  let out: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--check") check = true;
    else if (a === "--auth") {
      if (auth !== undefined) throw new UsageError("--auth given twice");
      auth = value();
    } else if (a === "--out") {
      if (out !== undefined) throw new UsageError("--out given twice");
      out = value();
    } else if (FLAGS_WITH_VALUE.includes(a)) forwarded.push(a, value());
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (authModeFor("cli", auth) !== "subscription") throw new UsageError("the live runner uses --auth subscription only");
  if (out === undefined) throw new UsageError("--out is required");
  const args = parseArgs(["investigate", ...forwarded]);
  return { marketId: args.request.marketId!, prompt: `/investigate-market ${args.request.arguments}`, maxBudgetUsd: args.maxBudgetUsd!, timeoutMs: args.timeoutMs, out: checkLiveOut(out), check };
}

const lstat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** A new directory directly under .live-out, reached through no link. Node reports a Windows junction as a symbolic link. */
export function checkLiveOut(out: string, root = LIVE_ROOT): string {
  const abs = resolve(out);
  const rel = relative(root, abs);
  if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === ".." || rel.includes(sep)) throw new UsageError(`--out must be a new directory directly under ${relative(REPO, root)}/`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(rel)) throw new UsageError("--out must end in a plain name: letters, digits, dots, dashes, underscores");
  const base = lstat(root);
  if (base && (base.isSymbolicLink() || !base.isDirectory())) throw new UsageError(`${relative(REPO, root)} must be a real directory, not a link`);
  if (lstat(abs)) throw new UsageError(`${rel} already exists; output is never overwritten`);
  return abs;
}

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Every string held under `key`, anywhere in a tool result. */
function valuesOf(v: unknown, key: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(v)) for (const x of v) valuesOf(x, key, found);
  else if (asObject(v)) {
    for (const [k, x] of Object.entries(asObject(v)!)) {
      if (k === key) found.push(x);
      else valuesOf(x, key, found);
    }
  }
  return found;
}

const isLiveTool = (c: ToolCall) => ["scan_markets", "inspect_market"].includes(shortName(c.name));
const errorOf = (c: ToolCall) => asObject(asObject(c.result.json)?.error);

export interface RequestCount {
  ceiling: number;
  /** The limit the server reported, which shows the setting reached it. Null if no live call succeeded. */
  serverLimit: number | null;
  /** Attempts the server reported. A failed call may report fewer than it made, so `exact` is false then. */
  attempts: number;
  exact: boolean;
}

export function requestCount(calls: ToolCall[]): RequestCount {
  let serverLimit: number | null = null;
  let attempts = 0;
  let exact = true;
  for (const c of calls.filter(isLiveTool)) {
    const process = asObject(asObject(asObject(c.result.json)?.budget)?.process);
    if (process && typeof process.used === "number") {
      attempts = process.used;
      serverLimit = typeof process.limit === "number" ? process.limit : serverLimit;
    } else {
      exact = false;
      const reported = asObject(errorOf(c)?.details)?.attempts;
      attempts += typeof reported === "number" ? reported : 0;
    }
  }
  return { ceiling: REQUEST_CEILING, serverLimit, attempts, exact };
}

/** What a live Mode A session must look like. Every entry is a reason not to trust the run as a live run. */
export function liveProblems(trace: ParsedTrace, marketId: string): string[] {
  const problems = [...trace.problems];
  if (!trace.subagent.started) problems.push("the investigator subagent did not start");
  if (trace.result === null) problems.push("the session reported no result");
  else if (trace.result.isError !== false) problems.push(`the session ended in error (${String(trace.result.subtype)})`);

  const main = trace.calls.filter((c) => c.scope === "main");
  if (main.length > 0) problems.push(`the main session called ${main.map((c) => c.name).join(", ")}`);
  const unknown = trace.calls.filter((c) => !MARKETMIND_TOOLS.includes(c.name));
  if (unknown.length > 0) problems.push(`calls outside the five tools: ${unknown.map((c) => c.name).join(", ")}`);
  const calls = trace.calls.filter(isMarketMind);
  if (calls.length > MODE_A_CALLS) problems.push(`${calls.length} MarketMind calls, above the budget of ${MODE_A_CALLS}`);
  if (calls.some((c) => shortName(c.name) === "scan_markets")) problems.push("scan_markets was called in an investigation of one given market");
  const seen = new Map<string, ToolCall>();
  for (const c of calls) {
    const key = stableStringify([c.name, c.input]);
    const earlier = seen.get(key);
    if (earlier && errorOf(earlier)?.retryable !== true) problems.push(`repeated identical call to ${shortName(c.name)}`);
    seen.set(key, c);
  }
  for (const c of calls) {
    if ("marketId" in c.input && c.input.marketId !== marketId) problems.push(`${shortName(c.name)} asked for market ${String(c.input.marketId)}, not ${marketId}`);
    if (c.input.includeSynthetic === true) problems.push(`${shortName(c.name)} asked for synthetic data`);
    if (c.result.status === "missing") problems.push(`${shortName(c.name)} has no result`);
    else if (asObject(c.result.json) === null) problems.push(`${shortName(c.name)} returned a result that cannot be checked`);
    const body = asObject(c.result.json);
    if (!body) continue;
    if (valuesOf(body, "sourceType").includes("synthetic")) problems.push(`${shortName(c.name)} returned synthetic data`);
    if (!errorOf(c) && body.appVersion !== APP_VERSION) problems.push(`${shortName(c.name)} came from app version ${String(body.appVersion)}, not ${APP_VERSION}`);
    if (!errorOf(c) && body.source !== (isLiveTool(c) ? "live" : "stored")) problems.push(`${shortName(c.name)} has source ${String(body.source)}`);
    for (const url of valuesOf(body, "url")) {
      let host: string | null = null;
      try {
        const u = new URL(String(url));
        host = u.protocol === "https:" ? u.hostname : null;
      } catch {
        // an unparseable address is not a production host
      }
      if (host === null || !LIVE_HOSTS.includes(host)) problems.push(`${shortName(c.name)} used ${String(url)}, which is not a production host`);
    }
  }
  const inspected = calls.filter((c) => shortName(c.name) === "inspect_market" && c.result.status === "ok" && asObject(c.result.json)?.source === "live");
  if (inspected.length === 0) problems.push("no live inspection of the market succeeded");

  const requests = requestCount(calls);
  if (requests.serverLimit !== null && requests.serverLimit !== REQUEST_CEILING) problems.push(`the server's request limit is ${requests.serverLimit}, not ${REQUEST_CEILING}`);
  if (requests.attempts > REQUEST_CEILING) problems.push(`${requests.attempts} HTTP attempts, above the ceiling of ${REQUEST_CEILING}`);

  const text = trace.subagent.finalText || (trace.result?.text ?? "");
  const report = parseReport(text);
  if (report.headingMarketId !== marketId) problems.push(`the report is headed market ${String(report.headingMarketId)}, not ${marketId}`);
  const missing = Array.from({ length: SECTIONS }, (_, i) => i + 1).filter((n) => !report.sections.some((s) => s.n === n));
  if (missing.length > 0) problems.push(`the report lacks section ${missing.join(", ")}`);
  if (statedLabels(report).length !== 1) problems.push(`the report states ${statedLabels(report).length} research labels, not one of ${LABELS.join(", ")}`);
  return [...new Set(problems)];
}

export interface EvidenceSummary {
  liveObservation: string;
  storedHistory: string;
  tags: { fact: number; calculated: number; interpretation: number; unknown: number };
}

/** The evidence by where it came from, read from the tool results rather than from the report. */
export function evidenceSummary(calls: ToolCall[], reportText: string): EvidenceSummary {
  const describe = (c: ToolCall | undefined, none: string) => {
    if (!c) return none;
    const error = errorOf(c);
    if (error) return `failed: ${String(error.category)}`;
    const body = asObject(c.result.json);
    return `${String(body?.status)} at ${String(body?.generatedAt)}`;
  };
  const last = (name: string) => calls.filter((c) => shortName(c.name) === name).at(-1);
  const history = last("get_market_history");
  const count = (re: RegExp) => [...reportText.matchAll(re)].length;
  return {
    liveObservation: describe(last("inspect_market"), "none: no live inspection was made"),
    storedHistory: history && errorOf(history)?.category === "database_missing" ? "none: no local database exists, so stored history is unknown" : asObject(history?.result.json)?.status === "no_history" ? "none: the database holds no observation of this market" : describe(history, "none: stored history was not read"),
    tags: { fact: count(/\[FACT\b/g), calculated: count(/\[CALC\b/g), interpretation: count(/\[INTERPRETATION\]/g), unknown: count(/\[UNKNOWN\]/g) },
  };
}

export interface LiveRecord {
  contract: "marketmind.live-run/1";
  source: "live";
  marketId: string;
  executedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stopReason: string | null;
  model: { investigator: string[]; session: string | null };
  auth: { mode: "subscription"; cliVersion: string | null; preflight: Preflight["evidence"]; initApiKeySource: string | null; rateLimitEventSeen: boolean; overageUsed: boolean };
  application: { appVersion: string; policy: ReturnType<typeof investigator> };
  server: { script: string; liveOnly: true; launcherReports: number; envKeys: string[] };
  tools: { total: number; byName: Record<string, number>; failed: number };
  requests: RequestCount;
  usage: { estimatedUsd: number | null; basis: string; byModel: Record<string, { inputTokens: number; outputTokens: number }> };
  evidence: EvidenceSummary;
  report: { label: string | null; sections: number; structurallyValid: boolean; note: string };
  integrity: { repoUnchanged: boolean; databaseUnchanged: boolean; databasePresent: boolean; projectUnchanged: boolean };
  processCleanup: { orphansFound: number; orphansKilled: number };
  flags: string[];
  problems: string[];
  passed: boolean;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const redactor = new Redactor([]);
export const scrub = (text: string) => redactor.text(text).replace(EMAIL, "<redacted:email>");

const cell = (v: unknown) => String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The readable artifact: a generated part that says what is known about the run, above the model's report, unedited but for redaction. */
export function renderLiveReport(r: LiveRecord, reportText: string): string {
  const rows: [string, unknown][] = [
    ["Market id", r.marketId],
    ["Observed", r.executedAt],
    ["Model", r.model.investigator.join(", ") || "unknown"],
    ["Authentication", `${r.auth.mode}, Claude Code ${String(r.auth.cliVersion)}`],
    ["Application", `MarketMind ${r.application.appVersion}, ${r.application.policy.policyVersion}, commit ${String(r.application.policy.gitCommit)}`],
    ["Tool calls", `${r.tools.total} (${Object.entries(r.tools.byName).map(([k, n]) => `${k} ${n}`).join(", ") || "none"})`],
    ["HTTP attempts", `${r.requests.exact ? "" : "at least "}${r.requests.attempts} of a ceiling of ${r.requests.ceiling}`],
    ["Estimated model usage", r.usage.estimatedUsd === null ? "unknown" : `$${r.usage.estimatedUsd.toFixed(4)} (estimate, not billing)`],
  ];
  const evidence: [string, string, string][] = [
    ["Live order-book observations", "Public Polymarket GET requests during this run; not stored", r.evidence.liveObservation],
    ["Stored historical observations", "Local database, read only", r.evidence.storedHistory],
    ["Facts and derived metrics", "`[FACT]` and `[CALC]` lines in the report", `${r.evidence.tags.fact} and ${r.evidence.tags.calculated} lines`],
    ["Agent interpretations", "`[INTERPRETATION]` lines in the report", `${r.evidence.tags.interpretation} lines`],
    ["Unknown information", "`[UNKNOWN]` lines in the report", `${r.evidence.tags.unknown} lines`],
  ];
  return [
    `# MarketMind live investigation: market ${r.marketId}`,
    "",
    "Educational research on live public data. Not a trading recommendation, and a spread is not a profit.",
    "",
    r.passed ? `Run checks passed. ${r.report.note}` : `**RUN CHECKS FAILED. Do not rely on this report.**\n\n${r.problems.map((p) => `- ${cell(p)}`).join("\n")}`,
    "",
    "| Run | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    "",
    "| Evidence | Where it comes from | In this run |",
    "|---|---|---|",
    ...evidence.map((e) => `| ${e.map(cell).join(" | ")} |`),
    "",
    "---",
    "",
    reportText.trim() === "" ? "(The investigator returned no report.)" : reportText.trim(),
    "",
  ].join("\n");
}

export interface LiveDeps {
  parentEnv: Record<string, string | undefined>;
  gate(env: Record<string, string>, cwd: string): Preflight;
  /** No uncommitted change anywhere in the repository, so the recorded commit is exact. */
  treeClean(): boolean;
  repoState(): string;
  spawn(args: string[], o: { cwd: string; env: Record<string, string> }): ChildProcess;
  serverScript: string;
  dbPath: string;
  log(line: string): void;
}

export const realLiveDeps = (): LiveDeps => ({
  parentEnv: process.env,
  gate: (env, cwd) => authPreflight("subscription", env, cwd),
  treeClean: () => {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() === "";
  },
  repoState,
  spawn: (args, o) => spawn("claude", args, { ...o, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }),
  serverScript: SERVER_SCRIPT,
  dbPath: join(REPO, DEFAULT_DB_PATH),
  log: (line) => console.log(line),
});

interface Session {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopReason: string | null;
}

/** The same stop conditions as the evaluation runner, plus a second server, which would have a ceiling of its own. */
function runSession(child: ChildProcess, watch: StreamWatch, timeoutMs: number, launchReport: string): Promise<Session> {
  return new Promise((done) => {
    const s: Session = { code: null, stdout: "", stderr: "", timedOut: false, stopReason: null };
    const stop = (reason: string) => {
      s.stopReason ??= reason;
      if (child.pid) killTree(child.pid);
    };
    const servers = setInterval(() => {
      if (readLauncherReports(launchReport).reports.length > 1) stop("a second MCP server started, which would have a request ceiling of its own");
    }, 500);
    const timer = setTimeout(() => {
      s.timedOut = true;
      stop(`timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      clearInterval(servers);
      s.code = code;
      done(s);
    };
    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      s.stdout += text;
      const reason = watch.feed(text);
      if (reason) stop(`stopped: ${reason}`);
    });
    child.stderr?.on("data", (d: Buffer) => (s.stderr += d.toString("utf8")));
    child.on("error", (e) => {
      s.stopReason ??= e.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Returns the process exit code. Nothing is written before the gate passes. */
export async function runLive(o: LiveOptions, deps: LiveDeps): Promise<number> {
  const started = Date.now();
  const work = mkdtempSync(join(tmpdir(), "mm-live-"));
  const tag = `mm-live-${randomUUID()}`;
  try {
    const project = join(work, "project");
    for (const f of Object.values(INVESTIGATOR_FILES)) {
      mkdirSync(dirname(join(project, f)), { recursive: true });
      copyFileSync(join(REPO, f), join(project, f));
    }
    const launchReport = join(work, "mcp-launcher.jsonl");
    const mcpConfigPath = join(work, "mcp-live.json");
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig(MCP_LAUNCHER, deps.serverScript, tag, deps.dbPath, launchReport, SERVER_SETTINGS)));
    const home = join(work, "home");
    const env = cliEnv("subscription", deps.parentEnv, home);
    const flags = cliFlags(o.maxBudgetUsd);
    const args = ["-p", o.prompt, "--mcp-config", mcpConfigPath, "--settings", join(project, INVESTIGATOR_FILES.settings), ...flags];
    const policy = investigator();

    const refusals = deps.treeClean() ? [] : ["the repository has uncommitted changes, so the commit could not be recorded exactly"];
    const gate = deps.gate(env, project);
    refusals.push(...gate.problems);
    if (o.check) {
      deps.log(stableStringify({ marketId: o.marketId, prompt: o.prompt, out: relative(REPO, o.out), server: relative(REPO, deps.serverScript).replace(/\\/g, "/"), serverSettings: SERVER_SETTINGS, database: existsSync(deps.dbPath) ? "present" : "missing: history will be reported as unknown", policy: policy.policyVersion, commit: policy.gitCommit, auth: { cliVersion: gate.cliVersion, ...gate.evidence }, wouldRun: refusals.length === 0, refusals, note: "No prompt was sent and no model request was made." }));
      return refusals.length === 0 ? 0 : 1;
    }
    if (refusals.length > 0) {
      deps.log(`not started: ${refusals.join("; ")}`);
      return 1;
    }

    checkLiveOut(o.out, dirname(o.out));
    mkdirSync(dirname(o.out), { recursive: true });
    mkdirSync(o.out);
    const dbHash = () => (existsSync(deps.dbPath) ? sha256(readFileSync(deps.dbPath)) : null);
    const before = { db: dbHash(), repo: deps.repoState(), project: treeHash(project) };
    const executedAt = new Date(started).toISOString();

    const watch = new StreamWatch("subscription");
    const session = await runSession(deps.spawn(args, { cwd: project, env }), watch, o.timeoutMs, launchReport);
    const orphans = processesTagged(tag);
    for (const pid of orphans) killTree(pid);
    const remaining = orphans.length ? processesTagged(tag) : [];

    writeFileSync(join(o.out, "trace.jsonl"), session.stdout);
    writeFileSync(join(o.out, "stderr.txt"), session.stderr);
    const after = { db: dbHash(), repo: deps.repoState(), project: treeHash(project) };
    const launcher = readLauncherReports(launchReport);
    const trace = parseTrace(session.stdout);
    const reportText = trace.subagent.finalText || (trace.result?.text ?? "");
    const calls = trace.calls.filter(isMarketMind);
    const settingsReached = Object.keys(SERVER_SETTINGS).filter((k) => !launcher.reports.every((r) => r.serverEnvKeys.includes(k)));
    const problems = [
      ...(session.stopReason ? [session.stopReason] : []),
      ...watch.finish(),
      ...liveProblems(trace, o.marketId),
      ...launcher.problems,
      ...serverEnvProblems(launcher.reports),
      ...(launcher.reports.length > 1 ? [`${launcher.reports.length} MCP servers started, so the ceiling did not cover the whole investigation`] : []),
      ...settingsReached.map((k) => `the server did not receive ${k}`),
      ...(before.repo === after.repo ? [] : ["the repository changed during the run"]),
      ...(before.db === after.db ? [] : ["the database changed during the run"]),
      ...(before.project === after.project ? [] : ["the temporary project changed during the run"]),
      ...(remaining.length ? [`${remaining.length} server processes could not be stopped`] : []),
    ];
    const parsed = parseReport(reportText);
    const labels = statedLabels(parsed);
    const byName: Record<string, number> = {};
    for (const c of calls) byName[shortName(c.name)] = (byName[shortName(c.name)] ?? 0) + 1;
    const record: LiveRecord = {
      contract: "marketmind.live-run/1",
      source: "live",
      marketId: o.marketId,
      executedAt,
      durationMs: Date.now() - started,
      exitCode: session.code,
      timedOut: session.timedOut,
      stopReason: session.stopReason,
      model: { investigator: trace.investigator.models, session: trace.init?.mainModel ?? null },
      auth: { mode: "subscription", cliVersion: gate.cliVersion, preflight: gate.evidence, initApiKeySource: watch.initApiKeySource, rateLimitEventSeen: watch.rateLimitEventSeen, overageUsed: watch.overageUsed },
      application: { appVersion: APP_VERSION, policy },
      server: { script: relative(REPO, deps.serverScript).replace(/\\/g, "/"), liveOnly: true, launcherReports: launcher.reports.length, envKeys: [...new Set(launcher.reports.flatMap((r) => r.serverEnvKeys))].sort() },
      tools: { total: calls.length, byName, failed: calls.filter((c) => c.result.status !== "ok").length },
      requests: requestCount(calls),
      usage: { estimatedUsd: trace.result?.costUsd ?? null, basis: "Claude Code's estimate at API rates, not billing; a subscription run draws on plan limits", byModel: Object.fromEntries(Object.entries(trace.result?.modelUsage ?? {}).map(([m, u]) => [m, { inputTokens: u.inputTokens, outputTokens: u.outputTokens }])) },
      evidence: evidenceSummary(calls, reportText),
      report: { label: labels.length === 1 ? labels[0]! : null, sections: parsed.sections.length, structurallyValid: !problems.some((p) => p.startsWith("the report ")), note: "A valid structure and label show the report is well formed, not that it is accurate." },
      integrity: { repoUnchanged: before.repo === after.repo, databaseUnchanged: before.db === after.db, databasePresent: before.db !== null, projectUnchanged: before.project === after.project },
      processCleanup: { orphansFound: orphans.length, orphansKilled: orphans.length - remaining.length },
      flags: ["-p", "<prompt>", "--mcp-config", "<temp>/mcp-live.json", "--settings", "<temp>/project/.claude/settings.json", ...flags],
      problems,
      passed: problems.length === 0,
    };
    writeFileSync(join(o.out, "run.json"), scrub(stableStringify(record)) + "\n");
    writeFileSync(join(o.out, "report.md"), scrub(renderLiveReport(record, reportText)));
    deps.log(`${record.passed ? "checks passed" : `CHECKS FAILED:\n  ${problems.map(scrub).join("\n  ")}`}\nlabel ${String(record.report.label)}; ${record.tools.total} tool calls; ${record.requests.attempts} HTTP attempts; report: ${relative(REPO, join(o.out, "report.md"))}`);
    return record.passed ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await runLive(parseLiveArgs(process.argv.slice(2)), realLiveDeps());
  } catch (e) {
    if (!(e instanceof UsageError || e instanceof AuthUsageError)) throw e;
    console.error(`${e.message}\nusage: npx tsx test-agent/live.ts --auth subscription --market-id <gammaId> --max-budget-usd <0-0.5> --out .live-out/<name> [--timeout-ms <ms>] [--check]`);
    process.exitCode = 2;
  }
}
