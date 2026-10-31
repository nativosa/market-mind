// Bounded real-agent evaluation runner (manual; uses model quota; never part of CI).
//
//   npx tsx test-agent/run.ts --scenario S01[,S03] | --all [--repeat N] [--out <dir>]
//        [--max-budget-usd 0.40] [--total-budget-usd 3] [--timeout-ms 300000] [--harness cli|sdk]
//
// --harness sdk runs the Stage 2.6 Agent SDK application (agent-sdk/) instead of `claude -p`, only for the
// approved subset and the P01 permission probe (sdkRun.ts SDK_ALLOWED), never with --all, and only with ANTHROPIC_API_KEY set (an API key
// is billed separately from a Claude subscription; Claude Code login credentials are never used).
//
// Each run: a fresh temp project holding only copies of the investigator files (so the main session
// cannot read golden expectations or sources), a freshly seeded synthetic database (or a missing one),
// the fixture MCP server under the production server name, Claude Code headless in default permission
// mode. The runner records the trace and run metadata, then grades everything offline (eval/evaluate.ts).
// It stops before a run that could exceed the total budget, kills the whole process tree on timeout and
// sweeps for orphaned fixture servers.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { evaluateDir, historicalArtifacts, historicalMessage, LAUNCHED, runKeyOf } from "./eval/evaluate.js";
import { promptFor, SCENARIO_SET, SCENARIOS, scenarioById, type EvalScenario } from "./eval/scenarios.js";
import { RUN_CONTRACT, RunMeta, stableJson } from "./eval/schema.js";
import { renderScorecard } from "./eval/scorecard.js";
import { parseExecution } from "./eval/sdkTrace.js";
import { parseTrace } from "./eval/trace.js";
import { FIXTURE_REVISION, fixtureDigest, seedEvalDb } from "./fixtures.js";
import { realDeps } from "../agent-sdk/cli.js";
import { probeFailures, runSdkOne, SDK_ALLOWED } from "./sdkRun.js";
import { INVESTIGATOR_FILES, investigator, killTree, processesTagged, REPO, repoState, sha256, treeHash } from "./processes.js";

export { BASELINE_TAG, INVESTIGATOR_FILES } from "./processes.js";

interface Options {
  out: string;
  maxBudgetUsd: number;
  totalBudgetUsd: number;
  timeoutMs: number;
}

function launched(out: string): { runs: { runKey: string; scenarioId: string; repetition: number; launchedAt: string }[] } {
  const p = join(out, LAUNCHED);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ReturnType<typeof launched>) : { runs: [] };
}

/** Estimated usage already recorded in this output directory (unknown costs count at their cap). */
function spentSoFar(out: string, cap: number): number {
  return launched(out).runs.reduce((sum, r) => {
    const trace = join(out, r.runKey, "trace.jsonl");
    const execution = join(out, r.runKey, "execution.json");
    const cost = existsSync(trace)
      ? parseTrace(readFileSync(trace, "utf8")).result?.costUsd
      : existsSync(execution)
        ? parseExecution(readFileSync(execution, "utf8")).result?.costUsd
        : null;
    return sum + (cost ?? cap);
  }, 0);
}

async function runOne(s: EvalScenario, repetition: number, o: Options): Promise<void> {
  const runKey = runKeyOf(s.id, repetition);
  const dir = join(o.out, runKey);
  mkdirSync(dir, { recursive: true });
  const record = launched(o.out);
  record.runs.push({ runKey, scenarioId: s.id, repetition, launchedAt: new Date().toISOString() });
  writeFileSync(join(o.out, LAUNCHED), stableJson({ contract: "marketmind.eval.launched/1", ...record }));

  const work = mkdtempSync(join(tmpdir(), "mm-eval-"));
  const tag = `mm-eval-${randomUUID()}`;
  const started = Date.now();
  const executedAt = new Date(started).toISOString();
  try {
    const project = join(work, "project");
    const files = s.withoutAllowRules ? [INVESTIGATOR_FILES.agent, INVESTIGATOR_FILES.skill] : Object.values(INVESTIGATOR_FILES);
    for (const f of files) {
      mkdirSync(dirname(join(project, f)), { recursive: true });
      copyFileSync(join(REPO, f), join(project, f));
    }
    const db = join(work, s.db === "missing" ? "absent.sqlite" : "agent-fixtures.sqlite");
    // The digest always covers the full fixture revision (seeded separately when the scenario's database is missing).
    const digest = fixtureDigest(s.db === "missing" ? seedEvalDb(join(work, "digest-only.sqlite")) : seedEvalDb(db));
    const mcpConfig = join(work, "mcp-eval.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { marketmind: { type: "stdio", command: process.execPath, args: [join(REPO, "test-agent", "scenario-mcp.mjs"), `--eval-tag=${tag}`], env: { MARKETMIND_DB: db } } } }));
    const prompt = promptFor(s);
    // Project permission rules are not applied in the fresh (untrusted) temp project, so the copied
    // investigator settings file is passed explicitly; the probe without allow rules passes none.
    const settingsFlag = s.withoutAllowRules ? [] : ["--settings", join(project, INVESTIGATOR_FILES.settings)];
    const flags = [
      "--strict-mcp-config",
      "--setting-sources",
      "project",
      "--permission-mode",
      "default",
      "--output-format",
      "stream-json",
      "--verbose",
      "--forward-subagent-text",
      "--no-session-persistence",
      "--max-budget-usd",
      String(o.maxBudgetUsd),
      ...(s.flags ?? []),
    ];
    const dbHash = () => (existsSync(db) ? sha256(readFileSync(db)) : null);
    const before = { db: dbHash(), repo: repoState(), project: treeHash(project) };

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let launchError: string | null = null;
    const exit = await new Promise<{ code: number | null; signal: string | null }>((done) => {
      const child = spawn("claude", ["-p", prompt, "--mcp-config", mcpConfig, ...settingsFlag, ...flags], { cwd: project, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid);
      }, o.timeoutMs);
      child.on("error", (e) => {
        launchError = e.message;
        clearTimeout(timer);
        done({ code: null, signal: null });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        done({ code, signal });
      });
    });
    const orphans = processesTagged(tag);
    for (const pid of orphans) killTree(pid);
    const remaining = orphans.length ? processesTagged(tag) : [];

    writeFileSync(join(dir, "trace.jsonl"), stdout);
    writeFileSync(join(dir, "stderr.txt"), stderr);
    const after = { db: dbHash(), repo: repoState(), project: treeHash(project) };
    const meta = RunMeta.parse({
      contract: RUN_CONTRACT,
      execution: { mode: "claude-cli", artifact: "trace.jsonl" },
      runKey,
      scenarioId: s.id,
      scenarioSet: SCENARIO_SET,
      repetition,
      fixtureRevision: FIXTURE_REVISION,
      fixtureDigest: digest,
      investigator: investigator(),
      prompt,
      flags: ["-p", "<prompt>", "--mcp-config", "<temp>/mcp-eval.json", ...(settingsFlag.length ? ["--settings", "<temp>/project/.claude/settings.json"] : []), ...flags],
      maxBudgetUsd: o.maxBudgetUsd,
      timeoutMs: o.timeoutMs,
      executedAt,
      durationMs: Date.now() - started,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      launchError,
      processCleanup: { treeKilled: timedOut, orphansFound: orphans.length, orphansKilled: orphans.length - remaining.length },
      integrity: { dbBefore: before.db, dbAfter: after.db, repoBefore: before.repo, repoAfter: after.repo, projectBefore: before.project, projectAfter: after.project },
    });
    writeFileSync(join(dir, "run.json"), stableJson(meta));
    const t = parseTrace(stdout);
    console.log(
      `${runKey}: exit ${exit.code}${timedOut ? " TIMEOUT" : ""}, ${t.calls.filter((c) => c.scope === "subagent").length} subagent calls, cost $${t.result?.costUsd ?? "?"}, ${Math.round((Date.now() - started) / 1000)} s` +
        (orphans.length ? `, orphans killed ${orphans.length - remaining.length}/${orphans.length}` : ""),
    );
  } catch (error) {
    console.error(`${runKey}: runner error: ${error instanceof Error ? error.message : String(error)}`);
    writeFileSync(join(dir, "runner-error.txt"), String(error instanceof Error ? (error.stack ?? error.message) : error));
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ids = process.argv.includes("--all") ? SCENARIOS.filter((s) => s.kind === "golden").map((s) => s.id) : (option("--scenario") ?? "").split(",").filter(Boolean);
  const scenarios = ids.map((id) => scenarioById(id));
  if (scenarios.length === 0 || scenarios.some((s) => !s)) {
    console.error(`usage: npx tsx test-agent/run.ts --scenario <${SCENARIOS.map((s) => s.id).join("|")}>[,...] | --all [--repeat N] [--out <dir>] [--max-budget-usd 0.40] [--total-budget-usd 3] [--timeout-ms 300000]`);
    process.exit(2);
  }
  const o: Options = {
    out: resolve(option("--out") ?? join(tmpdir(), "marketmind-eval", new Date().toISOString().replace(/[:.]/g, "-"))),
    maxBudgetUsd: Number(option("--max-budget-usd") ?? "0.40"),
    totalBudgetUsd: Number(option("--total-budget-usd") ?? "3"),
    timeoutMs: Number(option("--timeout-ms") ?? "300000"),
  };
  const repeat = Number(option("--repeat") ?? "1");
  const harness = option("--harness") ?? "cli";
  if (harness !== "cli" && harness !== "sdk") {
    console.error("--harness must be cli or sdk");
    process.exit(2);
  }
  if (harness === "sdk") {
    const outside = (scenarios as EvalScenario[]).filter((s) => !SDK_ALLOWED.includes(s.id));
    if (process.argv.includes("--all") || outside.length > 0) {
      console.error(`--harness sdk runs only the approved subset and probe ${SDK_ALLOWED.join(",")} (never --all)`);
      process.exit(2);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("--harness sdk needs ANTHROPIC_API_KEY (a Claude Console API key); nothing was started");
      process.exit(2);
    }
  }
  const inRepo = relative(REPO, o.out);
  if (!inRepo.startsWith("..") && !inRepo.startsWith(".eval-out")) {
    console.error("--out inside the repository must be under .eval-out/ (gitignored)");
    process.exit(2);
  }
  // Grading runs last and would refuse this directory; stop before any model usage is spent.
  const older = historicalArtifacts(o.out);
  if (older.length > 0) {
    console.error(historicalMessage(o.out, older));
    process.exit(2);
  }
  mkdirSync(o.out, { recursive: true });
  console.log(`output: ${o.out}`);
  const launchedKeys: string[] = [];
  for (const s of scenarios as EvalScenario[]) {
    for (let k = 0; k < repeat; k++) {
      const existing = launched(o.out).runs.filter((r) => r.scenarioId === s.id).length;
      const spent = spentSoFar(o.out, o.maxBudgetUsd);
      if (spent + o.maxBudgetUsd > o.totalBudgetUsd + 1e-9) {
        console.log(`budget stop: spent ~$${spent.toFixed(3)} + per-run cap $${o.maxBudgetUsd} > total $${o.totalBudgetUsd}; not launching ${s.id}`);
        break;
      }
      launchedKeys.push(runKeyOf(s.id, existing + 1));
      if (harness === "sdk") {
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        const io = { stdout: (t: string) => process.stdout.write(t), stderr: (t: string) => process.stderr.write(t), env: process.env };
        const meta = await runSdkOne(s, existing + 1, o, realDeps(io, sdk.query));
        console.log(`${meta.runKey}: agent-sdk run recorded${meta.launchError ? ` (${meta.launchError})` : ""}`);
      } else await runOne(s, existing + 1, o);
    }
  }
  const { results, scorecard } = await evaluateDir(o.out);
  console.log(renderScorecard(scorecard));
  if (existsSync(o.out) && statSync(o.out).isDirectory()) console.log(`results: ${o.out}`);
  const failures = probeFailures(scenarios as EvalScenario[], launchedKeys, results);
  for (const f of failures) console.error(`REQUIRED PROBE NOT PASSED: ${f}`);
  if (failures.length > 0) {
    console.error("the artifacts were preserved; exiting 1 because a required probe did not pass");
    process.exitCode = 1;
  }
}

await main();
