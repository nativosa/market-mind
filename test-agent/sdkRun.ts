// One agent-sdk evaluation run, recorded in the same output-directory layout as a Claude CLI run so that
// eval/evaluate.ts can grade it. The events are written as a normalized execution record
// (execution.json, marketmind.agent.execution/1) plus the redacted SDK messages; run.json says
// execution.mode = "agent-sdk". All side effects come from the injected session dependencies, so the
// offline tests drive this with a fake query; a real run needs ANTHROPIC_API_KEY and is started only
// by run.ts --harness sdk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../agent-sdk/args.js";
import { loadInvestigator } from "../agent-sdk/investigator.js";
import { stableStringify } from "../agent-sdk/options.js";
import { runInvestigation, type SessionDeps } from "../agent-sdk/session.js";
import { LAUNCHED, runKeyOf } from "./eval/evaluate.js";
import { SCENARIO_SET, type EvalScenario } from "./eval/scenarios.js";
import { RUN_CONTRACT, RunMeta, stableJson, type EvalResult } from "./eval/schema.js";
import { FIXTURE_REVISION, fixtureDigest, seedEvalDb } from "./fixtures.js";
import { investigator as investigatorMeta, treeHash } from "./processes.js";

/** The initial agent-sdk subset (Stage 2.6): thin liquidity, no history, consistent history, discovery, injection. */
export const SDK_SUBSET = ["S01", "S02", "S03", "S09", "S10"] as const;
/** Runtime probes allowed under --harness sdk (Stage 2.6 Gate 2): P01 runs with no allow rules. */
export const SDK_PROBES = ["P01"] as const;
export const SDK_ALLOWED: readonly string[] = [...SDK_SUBSET, ...SDK_PROBES];

/**
 * Why each probe this invocation was asked to run did not pass. A probe is a required control, so anything
 * but a completed run with P1 PASS (not launched, inconclusive, failed) must fail the command, even though
 * the artifacts were written.
 */
export function probeFailures(requested: EvalScenario[], launchedKeys: string[], results: EvalResult[]): string[] {
  return requested
    .filter((s) => s.kind === "probe")
    .flatMap((s) => {
      const runs = results.filter((r) => r.scenarioId === s.id && launchedKeys.includes(r.runKey));
      if (runs.length === 0) return [`${s.id}: not launched`];
      return runs.flatMap((r) => {
        const p1 = r.checks.find((c) => c.id === "P1");
        return p1?.verdict === "PASS" && r.runStatus === "completed" ? [] : [`${r.runKey}: run status ${r.runStatus}, P1 ${p1?.verdict ?? "NOT_EVALUATED"}${p1 ? ` (${p1.detail})` : ""}`];
      });
    });
}

export interface SdkRunOptions {
  out: string;
  maxBudgetUsd: number;
  timeoutMs: number;
}

/** CLI arguments that make the SDK application investigate exactly this scenario. */
export const scenarioArgv = (s: EvalScenario, o: SdkRunOptions) => [
  "investigate",
  ...(s.mode === "B" ? ["--discover", "--version", "v1"] : ["--market-id", s.marketId!]),
  "--fixture",
  s.id,
  "--max-budget-usd",
  String(o.maxBudgetUsd),
  "--timeout-ms",
  String(o.timeoutMs),
];

export function recordLaunch(out: string, runKey: string, scenarioId: string, repetition: number, launchedAt: string): void {
  const p = join(out, LAUNCHED);
  const record = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { runs: unknown[] }) : { runs: [] };
  record.runs.push({ runKey, scenarioId, repetition, launchedAt });
  writeFileSync(p, stableJson({ contract: "marketmind.eval.launched/1", ...record }));
}

export async function runSdkOne(s: EvalScenario, repetition: number, o: SdkRunOptions, deps: SessionDeps, now: () => Date = () => new Date()): Promise<RunMeta> {
  if (!SDK_ALLOWED.includes(s.id)) throw new Error(`${s.id} is not in the approved agent-sdk subset (${SDK_ALLOWED.join(", ")})`);
  const runKey = runKeyOf(s.id, repetition);
  const dir = join(o.out, runKey);
  mkdirSync(dir, { recursive: true });
  const started = now();
  recordLaunch(o.out, runKey, s.id, repetition, started.toISOString());

  const args = parseArgs(scenarioArgv(s, o), { evaluationProbe: s.kind === "probe" });
  const investigator = loadInvestigator();
  // Capture raw hashes for run.json while the session runs (it reports only unchanged/changed).
  let digest = "";
  let dbPath: string | null = null;
  const dbHashes: (string | null)[] = [];
  let cwd = "";
  let projectBefore = "";
  let projectAfter = "";
  const repoHashes: string[] = [];
  const wrapped: SessionDeps = {
    ...deps,
    isolation() {
      const iso = deps.isolation();
      cwd = iso.cwd;
      projectBefore = treeHash(cwd);
      return {
        ...iso,
        remove() {
          projectAfter = treeHash(cwd);
          iso.remove();
        },
      };
    },
    seedFixture(home) {
      const db = join(home, s.db === "missing" ? "absent.sqlite" : "agent-fixtures.sqlite");
      digest = fixtureDigest(s.db === "missing" ? seedEvalDb(join(home, "digest-only.sqlite")) : seedEvalDb(db));
      dbPath = db;
      return db;
    },
    hashFile(p) {
      const h = deps.hashFile(p);
      if (p === dbPath) dbHashes.push(h);
      return h;
    },
    repoState() {
      const h = deps.repoState();
      if (h) repoHashes.push(h);
      return h;
    },
  };
  const outcome = await runInvestigation({ investigator, request: args.request, maxBudgetUsd: o.maxBudgetUsd, timeoutMs: o.timeoutMs }, wrapped);
  const r = outcome.record;
  writeFileSync(join(dir, "execution.json"), stableStringify(r) + "\n");
  writeFileSync(join(dir, "sdk-messages.jsonl"), outcome.messages.map((m) => JSON.stringify(m)).join("\n") + (outcome.messages.length ? "\n" : ""));
  writeFileSync(join(dir, "stderr.txt"), outcome.stderr);
  const notStarted = r.status === "missing_credentials" || r.status === "invalid_options";
  const meta = RunMeta.parse({
    contract: RUN_CONTRACT,
    execution: { mode: "agent-sdk", artifact: "execution.json" },
    runKey,
    scenarioId: s.id,
    scenarioSet: SCENARIO_SET,
    repetition,
    fixtureRevision: FIXTURE_REVISION,
    fixtureDigest: digest || "0".repeat(64),
    investigator: investigatorMeta(),
    // The equivalent CLI invocation (same task text); the SDK renders the skill body itself.
    prompt: `/investigate-market ${args.request.arguments}`,
    flags: ["agent-sdk", `sdk ${r.harness.sdkVersion}`, `options ${r.harness.optionsDigest}`],
    maxBudgetUsd: o.maxBudgetUsd,
    timeoutMs: o.timeoutMs,
    executedAt: started.toISOString(),
    durationMs: Math.max(0, now().getTime() - started.getTime()),
    exitCode: null,
    signal: null,
    timedOut: r.status === "timeout",
    launchError: notStarted ? `${r.status}: ${r.statusDetail}` : null,
    processCleanup: { treeKilled: r.cleanup.forcedKill, orphansFound: r.cleanup.orphansFound, orphansKilled: r.cleanup.orphansKilled },
    integrity: {
      dbBefore: dbHashes[0] ?? null,
      dbAfter: dbHashes[dbHashes.length - 1] ?? null,
      repoBefore: repoHashes[0] ?? "0".repeat(64),
      repoAfter: repoHashes[repoHashes.length - 1] ?? "0".repeat(64),
      projectBefore: projectBefore || "0".repeat(64),
      projectAfter: projectAfter || projectBefore || "0".repeat(64),
    },
  });
  writeFileSync(join(dir, "run.json"), stableJson(meta));
  return meta;
}
