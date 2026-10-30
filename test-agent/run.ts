// Bounded real-agent evaluation runner (manual; uses model quota; never part of CI).
//
//   npx tsx test-agent/run.ts --scenario S01[,S03] | --all [--repeat N] [--out <dir>]
//        [--max-budget-usd 0.40] [--total-budget-usd 3] [--timeout-ms 300000]
//
// Each run: a fresh temp project holding only copies of the investigator files (so the main session
// cannot read golden expectations or sources), a freshly seeded synthetic database (or a missing one),
// the fixture MCP server under the production server name, Claude Code headless in default permission
// mode. The runner records the trace and run metadata, then grades everything offline (eval/evaluate.ts).
// It stops before a run that could exceed the total budget, kills the whole process tree on timeout and
// sweeps for orphaned fixture servers.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDir, LAUNCHED, runKeyOf } from "./eval/evaluate.js";
import { promptFor, SCENARIO_SET, SCENARIOS, scenarioById, type EvalScenario } from "./eval/scenarios.js";
import { RUN_CONTRACT, RunMeta, stableJson } from "./eval/schema.js";
import { renderScorecard } from "./eval/scorecard.js";
import { parseTrace } from "./eval/trace.js";
import { FIXTURE_REVISION, fixtureDigest, seedEvalDb } from "./fixtures.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const BASELINE_TAG = "v0.5.0";
export const INVESTIGATOR_FILES = { agent: ".claude/agents/market-investigator.md", skill: ".claude/skills/investigate-market/SKILL.md", settings: ".claude/settings.json" } as const;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const git = (...args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
const repoState = () => sha256(`${git("status", "--porcelain").stdout}\n${git("diff").stdout}`);

/** Hash of every file below a directory (relative path + content), for detecting writes. */
function treeHash(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else parts.push(`${relative(dir, p)}\0${sha256(readFileSync(p))}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return sha256(parts.join("\n"));
}

function investigator(): RunMeta["investigator"] {
  const hash = (p: string) => sha256(readFileSync(join(REPO, p)));
  const baseline = (p: string) => {
    const r = spawnSync("git", ["show", `${BASELINE_TAG}:${p}`], { cwd: REPO });
    return r.status === 0 ? sha256(r.stdout) : null;
  };
  const files = Object.values(INVESTIGATOR_FILES);
  const base = files.map(baseline);
  const head = git("rev-parse", "HEAD");
  const dirty = git("diff", "--quiet", "HEAD", "--", ...files);
  return {
    agentSha256: hash(INVESTIGATOR_FILES.agent),
    skillSha256: hash(INVESTIGATOR_FILES.skill),
    settingsSha256: hash(INVESTIGATOR_FILES.settings),
    baselineTag: BASELINE_TAG,
    matchesBaseline: base.some((b) => b === null) ? null : files.every((f, i) => hash(f) === base[i]),
    gitCommit: head.status === 0 ? head.stdout.trim() : null,
    gitDirty: dirty.status === null ? null : dirty.status !== 0,
  };
}

/** Process ids whose command line contains `tag` (excluding the querying process itself). */
function processesTagged(tag: string): number[] {
  if (process.platform === "win32") {
    const ps = spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${tag}%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8" });
    return ps.stdout.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n !== process.pid);
  }
  const pg = spawnSync("pgrep", ["-f", tag], { encoding: "utf8" });
  return pg.stdout.split(/\s+/).filter(Boolean).map(Number).filter((n) => n !== process.pid);
}

function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

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
    const cost = existsSync(trace) ? parseTrace(readFileSync(trace, "utf8")).result?.costUsd : null;
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
  const inRepo = relative(REPO, o.out);
  if (!inRepo.startsWith("..") && !inRepo.startsWith(".eval-out")) {
    console.error("--out inside the repository must be under .eval-out/ (gitignored)");
    process.exit(2);
  }
  mkdirSync(o.out, { recursive: true });
  console.log(`output: ${o.out}`);
  for (const s of scenarios as EvalScenario[]) {
    for (let k = 0; k < repeat; k++) {
      const existing = launched(o.out).runs.filter((r) => r.scenarioId === s.id).length;
      const spent = spentSoFar(o.out, o.maxBudgetUsd);
      if (spent + o.maxBudgetUsd > o.totalBudgetUsd + 1e-9) {
        console.log(`budget stop: spent ~$${spent.toFixed(3)} + per-run cap $${o.maxBudgetUsd} > total $${o.totalBudgetUsd}; not launching ${s.id}`);
        break;
      }
      await runOne(s, existing + 1, o);
    }
  }
  const { scorecard } = await evaluateDir(o.out);
  console.log(renderScorecard(scorecard));
  if (existsSync(o.out) && statSync(o.out).isDirectory()) console.log(`results: ${o.out}`);
}

await main();
