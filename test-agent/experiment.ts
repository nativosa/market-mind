// The Stage 2.7 controlled comparison of policy-v1 and policy-v2 (manual; uses model quota; never part of CI).
// The design and its criteria are frozen in docs/stage-2.7-experiment.md.
//
//   npx tsx test-agent/experiment.ts --auth subscription --out .eval-out/<name> --repetitions 1|3 --max-budget-usd 0.40 --total-budget-usd <usd> [--timeout-ms 300000] [--check]
//
// --check runs the gates and prints the plan and the policy hashes: no prompt, no model request, no artifact.
//
// Each run goes through run.ts's runOne, so both arms share one code path for the authentication gate, the
// environment, the five-tool flags, the stream watch and the fixture server. The only input that differs is the
// verified policy. Neither arm reads the working tree, and this command takes no policy option: the arms are fixed.
//
// Each policy has its own directory, so results cannot mix: <out>/policy-v1/S01-r1, <out>/policy-v2/S01-r1. Nothing
// resumes. A pilot needs a directory that does not exist, so an interrupted pilot stays as it stopped. --repetitions 3
// adds r2 and r3 to a pilot only if its frozen gate passes, and only once.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DISALLOWED_BUILTINS } from "../agent-sdk/options.js";
import { MARKETMIND_TOOLS } from "../agent-sdk/guard.js";
import { authModeFor, authPreflight, AuthUsageError, cliEnv, cliFlags, type Preflight } from "./cliAuth.js";
import { evaluateDir, runKeyOf } from "./eval/evaluate.js";
import { GRADER_REVISION } from "./eval/graders.js";
import { FINAL_REPETITIONS, FROZEN_GRADER, P01_RESULT, pairReport, PILOT_REPETITIONS, renderPairReport, SCENARIO_IDS, type PairReport } from "./eval/pairs.js";
import { RUBRIC_SET, SCENARIO_SET, scenarioById, type EvalScenario } from "./eval/scenarios.js";
import { RunMeta, stableJson } from "./eval/schema.js";
import { FIXTURE_REVISION } from "./fixtures.js";
import { CONTROL, loadPolicy, repositoryGit, TREATMENT, type GitReader, type LoadedPolicy, type RegisteredPolicy } from "./policySource.js";
import { INVESTIGATOR_FILES, REPO } from "./processes.js";
import { runOne, spentSoFar, type Options } from "./run.js";

export const EVAL_ROOT = join(REPO, ".eval-out");
export const MANIFEST = "experiment.json";
const MANIFEST_CONTRACT = "marketmind.eval.experiment/1";
const REPORT_JSON = "pairs.json";
const REPORT_MD = "pairs.md";

export class ExperimentUsageError extends Error {}

export interface ExperimentOptions {
  out: string;
  repetitions: number;
  maxBudgetUsd: number;
  totalBudgetUsd: number;
  timeoutMs: number;
  check: boolean;
}

const FLAGS_WITH_VALUE = ["--auth", "--out", "--repetitions", "--max-budget-usd", "--total-budget-usd", "--timeout-ms"];

function positive(name: string, value: string | undefined, max: number): number {
  const n = Number(value);
  if (value === undefined) throw new ExperimentUsageError(`${name} is required`);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new ExperimentUsageError(`${name} must be above 0 and at most ${max}`);
  return n;
}

/** Budgets are always explicit. Every flag is listed, so a policy, scenario or path option is refused, not ignored. */
export function parseExperimentArgs(argv: string[], root = EVAL_ROOT): ExperimentOptions {
  const given = new Map<string, string>();
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--check") check = true;
    else if (FLAGS_WITH_VALUE.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new ExperimentUsageError(`${a} needs a value`);
      if (given.has(a)) throw new ExperimentUsageError(`${a} given twice`);
      given.set(a, v);
    } else throw new ExperimentUsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (authModeFor("cli", given.get("--auth")) !== "subscription") throw new ExperimentUsageError("the comparison uses --auth subscription only: authentication modes are never pooled");
  const out = given.get("--out");
  if (out === undefined) throw new ExperimentUsageError("--out is required");
  const repetitions = Number(given.get("--repetitions"));
  if (repetitions !== PILOT_REPETITIONS && repetitions !== FINAL_REPETITIONS) throw new ExperimentUsageError(`--repetitions must be ${PILOT_REPETITIONS} (the pilot) or ${FINAL_REPETITIONS} (the expansion)`);
  return {
    out: checkExperimentOut(out, root),
    repetitions,
    maxBudgetUsd: positive("--max-budget-usd", given.get("--max-budget-usd"), 0.5),
    totalBudgetUsd: positive("--total-budget-usd", given.get("--total-budget-usd"), 10),
    timeoutMs: positive("--timeout-ms", given.get("--timeout-ms") ?? "300000", 600_000),
    check,
  };
}

const lstat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** A plain name directly under .eval-out, reached through no link. */
export function checkExperimentOut(out: string, root = EVAL_ROOT): string {
  const abs = resolve(out);
  const rel = relative(root, abs);
  if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === ".." || rel.includes(sep)) throw new ExperimentUsageError(`--out must be a directory directly under ${relative(REPO, root) || root}`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(rel)) throw new ExperimentUsageError("--out must end in a plain name: letters, digits, dots, dashes, underscores");
  for (const p of [root, abs]) if (lstat(p)?.isSymbolicLink()) throw new ExperimentUsageError(`${p} must be a real directory, not a link`);
  return abs;
}

const Hashes = z.object({ agentSha256: z.string(), skillSha256: z.string(), settingsSha256: z.string() }).strict();
const Manifest = z
  .object({
    contract: z.literal(MANIFEST_CONTRACT),
    grader: z.string(),
    scenarioSet: z.string(),
    rubricSet: z.string(),
    fixtureRevision: z.string(),
    scenarios: z.array(z.string()),
    commit: z.string(),
    auth: z.literal("subscription"),
    maxBudgetUsd: z.number(),
    timeoutMs: z.number(),
    arms: z.array(z.object({ role: z.enum(["control", "treatment"]), policy: z.string(), commit: z.string(), tag: z.string().nullable(), hashes: Hashes }).strict()),
  })
  .strict();
type Manifest = z.infer<typeof Manifest>;

export interface PlannedRun {
  scenarioId: string;
  repetition: number;
  policy: RegisteredPolicy;
}

/** Pair by pair, so time drift falls on both arms. Which arm goes first alternates by scenario and repetition. */
export function runPlan(repetitions: number): PlannedRun[] {
  return Array.from({ length: repetitions }, (_, k) => k + 1).flatMap((repetition) =>
    SCENARIO_IDS.flatMap((scenarioId, i) => ((i + repetition) % 2 === 1 ? [CONTROL, TREATMENT] : [TREATMENT, CONTROL]).map((policy) => ({ scenarioId, repetition, policy }))),
  );
}

const expansionPlan = () => runPlan(FINAL_REPETITIONS).filter((r) => r.repetition > PILOT_REPETITIONS);

export interface ExperimentDeps {
  treeClean(): boolean;
  head(): string | null;
  git: GitReader;
  parentEnv: Record<string, string | undefined>;
  gate: typeof authPreflight;
  spawnCli?: Options["spawnCli"];
  p01Path: string;
  log(line: string): void;
}

export const realExperimentDeps = (): ExperimentDeps => ({
  treeClean: () => {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() === "";
  },
  head: () => {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  },
  git: repositoryGit,
  parentEnv: process.env,
  gate: authPreflight,
  p01Path: join(REPO, P01_RESULT),
  log: (line) => console.log(line),
});

const manifestOf = (policies: Record<RegisteredPolicy, LoadedPolicy>, commit: string, o: ExperimentOptions): Manifest => ({
  contract: MANIFEST_CONTRACT,
  grader: GRADER_REVISION,
  scenarioSet: SCENARIO_SET,
  rubricSet: RUBRIC_SET,
  fixtureRevision: FIXTURE_REVISION,
  scenarios: [...SCENARIO_IDS],
  commit,
  auth: "subscription",
  maxBudgetUsd: o.maxBudgetUsd,
  timeoutMs: o.timeoutMs,
  arms: (["control", "treatment"] as const).map((role) => {
    const p = policies[role === "control" ? CONTROL : TREATMENT];
    return { role, policy: p.version, commit: p.commit, tag: p.tag, hashes: p.hashes };
  }),
});

/** The tools an arm's files allow. Each list must be exactly the five, in both arms, or nothing runs. */
export function boundaryOf(policy: Pick<LoadedPolicy, "version" | "files">): { policy: string; agentTools: string[]; allowRules: string[]; problems: string[] } {
  const frontmatter = policy.files[INVESTIGATOR_FILES.agent]!.toString("utf8").split("---")[1] ?? "";
  const agentTools = (/^tools:\s*(.*)$/m.exec(frontmatter)?.[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean).sort();
  const settings = JSON.parse(policy.files[INVESTIGATOR_FILES.settings]!.toString("utf8")) as { permissions?: { allow?: string[] } };
  const allowRules = [...(settings.permissions?.allow ?? [])].sort();
  const five = JSON.stringify([...MARKETMIND_TOOLS].sort());
  const problems = [...(JSON.stringify(agentTools) === five ? [] : [`${policy.version}: the agent's tools are not exactly the five MarketMind tools`]), ...(JSON.stringify(allowRules) === five ? [] : [`${policy.version}: the allow rules are not exactly the five MarketMind tools`])];
  return { policy: policy.version, agentTools, allowRules, problems };
}

/** Null if this directory may be used. Nothing resumes: a pilot needs a new directory, and an expansion runs once, on a pilot this command made. */
function outProblem(out: string, wanted: Manifest, repetitions: number): string | null {
  if (repetitions === PILOT_REPETITIONS) return lstat(out) ? `${out} already exists: output is never overwritten, and an interrupted pilot is never resumed. A restart is a new, approved pilot in a new directory` : null;
  if (!lstat(out)) return `${out} does not exist: the expansion adds to a completed pilot`;
  const path = join(out, MANIFEST);
  if (!existsSync(path)) return `${out} is not an experiment directory; nothing was written`;
  let parsed;
  try {
    parsed = Manifest.safeParse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return `${path} is not valid JSON`;
  }
  if (!parsed.success) return `${path} does not match its contract`;
  if (stableJson(parsed.data) !== stableJson(wanted)) return "this directory was started under a different commit, policy, grader, fixture or budget, so its pairs would not be comparable";
  const started = expansionPlan().find((r) => existsSync(join(out, r.policy, runKeyOf(r.scenarioId, r.repetition))));
  return started ? `the expansion already started (${started.policy}/${runKeyOf(started.scenarioId, started.repetition)}) and is never resumed` : null;
}

/** The gate under the environment the runs will use, before anything is written. */
function gateNow(deps: ExperimentDeps): Preflight {
  const work = mkdtempSync(join(tmpdir(), "mm-experiment-"));
  try {
    const home = join(work, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    return deps.gate("subscription", cliEnv("subscription", deps.parentEnv, home), work);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

/** Why the sequence must not continue after this run. Stopped runs stay recorded, and their pairs read as incomplete. */
function stopReason(armDir: string, runKey: string): string | null {
  const path = join(armDir, runKey, "run.json");
  if (!existsSync(path)) return `${runKey} left no run record`;
  const meta = RunMeta.parse(JSON.parse(readFileSync(path, "utf8")));
  if (meta.launchError) return `${runKey}: ${meta.launchError}`;
  if (meta.timedOut) return `${runKey} timed out`;
  if (meta.exitCode !== 0) return `${runKey} exited with code ${String(meta.exitCode)}`;
  return null;
}

/** The same grader over both arms, then the paired report. */
async function gradeAndReport(out: string, repetitions: number, deps: ExperimentDeps): Promise<PairReport> {
  for (const arm of [CONTROL, TREATMENT]) if (existsSync(join(out, arm))) await evaluateDir(join(out, arm));
  const report = pairReport(out, repetitions, deps.p01Path);
  writeFileSync(join(out, REPORT_JSON), stableJson(report));
  writeFileSync(join(out, REPORT_MD), renderPairReport(report));
  return report;
}

/** Returns the process exit code. Nothing is written, and nothing starts, until every check passes. */
export async function runExperiment(o: ExperimentOptions, deps: ExperimentDeps): Promise<number> {
  const refuse = (reasons: string[]) => {
    deps.log(`not started: ${reasons.join("; ")}`);
    return 1;
  };
  const policies = { [CONTROL]: loadPolicy(CONTROL, deps.git), [TREATMENT]: loadPolicy(TREATMENT, deps.git) } as Record<RegisteredPolicy, LoadedPolicy>;
  const refusals: string[] = [];
  if (GRADER_REVISION !== FROZEN_GRADER) refusals.push(`the grader is ${GRADER_REVISION}, not the frozen ${FROZEN_GRADER}`);
  if (!deps.treeClean()) refusals.push("the repository has uncommitted changes, so the commit could not be recorded exactly");
  const commit = deps.head();
  if (commit === null) refusals.push("the commit could not be read");
  const manifest = manifestOf(policies, commit ?? "", o);
  const boundaries = [boundaryOf(policies[CONTROL]), boundaryOf(policies[TREATMENT])];
  refusals.push(...boundaries.flatMap((b) => b.problems));
  const problem = outProblem(o.out, manifest, o.repetitions);
  if (problem) refusals.push(problem);
  if (o.repetitions === FINAL_REPETITIONS && !problem) {
    const gate = pairReport(o.out, PILOT_REPETITIONS, deps.p01Path).expansion;
    if (!gate.eligible) refusals.push(`the expansion gate is not met: ${gate.conditions.filter((c) => !c.met).map((c) => `${c.id}. ${c.detail}`).join("; ")}`);
  }
  const gate = gateNow(deps);
  refusals.push(...gate.problems);

  const plan = o.repetitions === PILOT_REPETITIONS ? runPlan(PILOT_REPETITIONS) : expansionPlan();
  if (o.check) {
    const flags = cliFlags(o.maxBudgetUsd);
    const toolBoundary = { builtInTools: flags[flags.indexOf("--tools") + 1], disallowedBuiltIns: DISALLOWED_BUILTINS.length, permissionMode: flags[flags.indexOf("--permission-mode") + 1], settingSources: flags[flags.indexOf("--setting-sources") + 1], strictMcpConfig: flags.includes("--strict-mcp-config"), mcpTools: [...MARKETMIND_TOOLS].sort(), arms: boundaries.map(({ policy, agentTools, allowRules }) => ({ policy, agentTools, allowRules })), identicalInBothArms: JSON.stringify(boundaries[0]!.allowRules) === JSON.stringify(boundaries[1]!.allowRules) && JSON.stringify(boundaries[0]!.agentTools) === JSON.stringify(boundaries[1]!.agentTools) };
    deps.log(stableJson({ manifest, plan: plan.map((r) => `${r.policy}/${runKeyOf(r.scenarioId, r.repetition)}`), auth: { cliVersion: gate.cliVersion, ...gate.evidence }, toolBoundary, wouldRun: refusals.length === 0, refusals, note: "No prompt was sent and no model request was made. The session itself confirms its tool pool at init, after the first request." }));
    return refusals.length === 0 ? 0 : 1;
  }
  if (refusals.length > 0) return refuse(refusals);

  if (o.repetitions === PILOT_REPETITIONS) {
    mkdirSync(dirname(o.out), { recursive: true });
    mkdirSync(o.out); // throws if the directory appeared after the check above
    writeFileSync(join(o.out, MANIFEST), stableJson(manifest));
  }
  const base = { maxBudgetUsd: o.maxBudgetUsd, totalBudgetUsd: o.totalBudgetUsd, timeoutMs: o.timeoutMs, auth: "subscription" as const, gate: deps.gate, ...(deps.spawnCli ? { spawnCli: deps.spawnCli } : {}) };
  const spent = () => [CONTROL, TREATMENT].reduce((sum, arm) => sum + (existsSync(join(o.out, arm)) ? spentSoFar(join(o.out, arm), o.maxBudgetUsd) : 0), 0);
  let stopped: string | null = null;
  for (const run of plan) {
    if (spent() + o.maxBudgetUsd > o.totalBudgetUsd + 1e-9) {
      stopped = `budget stop: ~$${spent().toFixed(3)} recorded, and the next run could use $${o.maxBudgetUsd} of a total of $${o.totalBudgetUsd}`;
      break;
    }
    const out = join(o.out, run.policy);
    mkdirSync(out, { recursive: true });
    await runOne(scenarioById(run.scenarioId) as EvalScenario, run.repetition, { ...base, out, policy: policies[run.policy] });
    stopped = stopReason(out, runKeyOf(run.scenarioId, run.repetition));
    if (stopped) break;
  }
  const report = await gradeAndReport(o.out, o.repetitions, deps);
  deps.log(renderPairReport(report));
  if (stopped) deps.log(`STOPPED: ${stopped}`);
  return stopped === null && report.accounting.complete === report.accounting.expected ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await runExperiment(parseExperimentArgs(process.argv.slice(2)), realExperimentDeps());
  } catch (e) {
    if (!(e instanceof ExperimentUsageError || e instanceof AuthUsageError)) throw e;
    console.error(`${e.message}\nusage: npx tsx test-agent/experiment.ts --auth subscription --out .eval-out/<name> --repetitions 1|3 --max-budget-usd <0-0.5> --total-budget-usd <usd> [--timeout-ms <ms>] [--check]`);
    process.exitCode = 2;
  }
}
