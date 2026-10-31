// Offline grading of a recorded evaluation directory (no Claude invocation):
//
//   npx tsx test-agent/eval/evaluate.ts <outDir> [--output <newDir>]
//
// For every launched run it writes <run>/result.json (deterministic: identical inputs give identical
// bytes) and, if absent, an UNREVIEWED <run>/review.json template; then scorecard.json and scorecard.md.
// An optional <outDir>/attributions.json (marketmind.eval.attribution/1) records documented causes of
// repository drift; it is written by the person running the evaluation, never by the grader.
//
// Artifacts written under another grader revision or contract are historical records. They are never
// overwritten: grading refuses before writing anything, and --output sends the regraded results and
// scorecard to a separate directory, leaving <outDir> untouched.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeGolden, openGolden, type Golden, type GoldenSession } from "./golden.js";
import { GRADER_REVISION, gradeRun, reviewTemplate } from "./graders.js";
import { scenarioById, type EvalScenario } from "./scenarios.js";
import { Attributions, EvalResult, executionOf, RESULT_CONTRACT, Review, RunMeta, SCORECARD_CONTRACT, stableJson } from "./schema.js";
import { parseExecution } from "./sdkTrace.js";
import { buildScorecard, renderScorecard, type Scorecard } from "./scorecard.js";

export const LAUNCHED = "launched.json";
export const ATTRIBUTIONS = "attributions.json";
export const runKeyOf = (scenarioId: string, repetition: number) => `${scenarioId}-r${repetition}`;
const scenarioOfKey = (key: string) => key.replace(/-r\d+$/, "");

const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
function readJson<T>(path: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): { value: T | null; problem: string | null } {
  const text = readText(path);
  if (text === null) return { value: null, problem: null };
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? { value: parsed.data!, problem: null } : { value: null, problem: "schema mismatch" };
  } catch {
    return { value: null, problem: "malformed JSON" };
  }
}

/** Run keys to grade: everything the runner recorded as launched, plus any run directory found. */
export function runKeys(out: string): string[] {
  const keys = new Set<string>();
  const launched = readText(join(out, LAUNCHED));
  if (launched) for (const r of (JSON.parse(launched) as { runs: { runKey: string }[] }).runs) keys.add(r.runKey);
  for (const d of readdirSync(out, { withFileTypes: true })) if (d.isDirectory() && existsSync(join(out, d.name, "run.json"))) keys.add(d.name);
  return [...keys].sort();
}

interface Graded {
  results: EvalResult[];
  scorecard: Scorecard;
  unknownScenarios: string[];
}

/**
 * The run's recorded events, by execution mode: a Claude Code stream-json trace, or an agent-sdk execution
 * record normalized by sdkTrace.parseExecution. Missing artifacts stay null (graded as missing).
 */
function eventsOf(dir: string, meta: RunMeta | null): { traceText: string | null; parsedTrace?: ReturnType<typeof parseExecution> | null } {
  if (executionOf(meta) !== "agent-sdk") return { traceText: readText(join(dir, "trace.jsonl")) };
  const text = readText(join(dir, "execution.json"));
  return { traceText: text, parsedTrace: text === null ? null : parseExecution(text) };
}

/** Existing results or scorecard in `dir` that this grader did not write; these must not be overwritten. */
export function historicalArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ rel: `${d.name}/result.json`, contract: RESULT_CONTRACT }));
  return [...results, { rel: "scorecard.json", contract: SCORECARD_CONTRACT }].flatMap(({ rel, contract }) => {
    const text = readText(join(dir, rel));
    if (text === null) return [];
    const current = `${contract} ${GRADER_REVISION}`;
    let found = "unreadable";
    try {
      const j = JSON.parse(text) as { contract?: unknown; graderRevision?: unknown; grader?: { revision?: unknown } };
      found = `${String(j.contract)} ${String(j.graderRevision ?? j.grader?.revision)}`;
    } catch {
      /* stays unreadable */
    }
    return found === current ? [] : [`${rel}: ${found} (current ${current})`];
  });
}

export const historicalMessage = (dir: string, older: string[]) =>
  `${dir} holds artifacts from another grader revision or contract; nothing was written. Regrade into a new directory with --output.\n${older.map((o) => `- ${o}`).join("\n")}`;

export class HistoricalArtifactsError extends Error {
  constructor(dir: string, readonly older: string[]) {
    super(historicalMessage(dir, older));
  }
}

export interface EvaluateOptions {
  /** Write results and the scorecard here; `out` is then only read. */
  outputDir?: string;
}

export async function evaluateDir(out: string, options: EvaluateOptions = {}): Promise<Graded> {
  const target = options.outputDir ?? out;
  const older = historicalArtifacts(target);
  if (older.length > 0) throw new HistoricalArtifactsError(target, older);
  const goldens = new Map<string, { golden: Golden; session: GoldenSession }>();
  const results: EvalResult[] = [];
  const unknownScenarios: string[] = [];
  const attributions = readJson<Attributions>(join(out, ATTRIBUTIONS), Attributions);
  try {
    for (const key of runKeys(out)) {
      const dir = join(out, key);
      const meta = readJson<RunMeta>(join(dir, "run.json"), RunMeta);
      const scenario: EvalScenario | undefined = scenarioById(meta.value?.scenarioId ?? scenarioOfKey(key));
      if (!scenario) {
        unknownScenarios.push(key);
        continue;
      }
      let g = goldens.get(scenario.id);
      if (!g) {
        g = { golden: await computeGolden(scenario), session: await openGolden(scenario.db) };
        goldens.set(scenario.id, g);
      }
      const review = readJson<Review>(join(dir, "review.json"), Review);
      const result = EvalResult.parse(
        await gradeRun({ scenario, runKey: key, meta: meta.value, ...eventsOf(dir, meta.value), review: review.value, golden: g.golden, session: g.session, attributions: attributions.value?.entries ?? [] }),
      );
      if (meta.problem) result.ungradable.push(`run.json ${meta.problem}`);
      if (review.problem) result.ungradable.push(`review.json ${review.problem}`);
      if (attributions.problem) result.ungradable.push(`${ATTRIBUTIONS} ${attributions.problem} (ignored)`);
      if (existsSync(dir)) {
        const runDir = join(target, key);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "result.json"), stableJson(result));
        if (!existsSync(join(dir, "review.json")) && scenario.rubrics.length > 0) writeFileSync(join(runDir, "review.json"), stableJson(reviewTemplate(key, scenario)));
      }
      results.push(result);
    }
  } finally {
    for (const g of goldens.values()) await g.session.close();
  }
  const scorecard = buildScorecard(results);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "scorecard.json"), stableJson({ ...scorecard, unknownScenarios, attributionFileProblem: attributions.problem }));
  writeFileSync(join(target, "scorecard.md"), renderScorecard(scorecard) + (unknownScenarios.length ? `\nUnknown scenarios (not graded): ${unknownScenarios.join(", ")}\n` : ""));
  return { results, scorecard, unknownScenarios };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, flag, outputDir] = process.argv.slice(2);
  if (!out || (flag !== undefined && (flag !== "--output" || !outputDir))) {
    console.error("usage: npx tsx test-agent/eval/evaluate.ts <outDir> [--output <newDir>]");
    process.exit(2);
  }
  try {
    const { scorecard } = await evaluateDir(resolve(out), outputDir ? { outputDir: resolve(outputDir) } : {});
    console.log(renderScorecard(scorecard));
  } catch (e) {
    if (!(e instanceof HistoricalArtifactsError)) throw e;
    console.error(e.message);
    process.exit(3);
  }
}
