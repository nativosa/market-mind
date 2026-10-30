// Offline grading of a recorded evaluation directory (no Claude invocation):
//
//   npx tsx test-agent/eval/evaluate.ts <outDir>
//
// For every launched run it writes <run>/result.json (deterministic: identical inputs give identical
// bytes) and, if absent, an UNREVIEWED <run>/review.json template; then scorecard.json and scorecard.md.
// An optional <outDir>/attributions.json (marketmind.eval.attribution/1) records documented causes of
// repository drift; it is written by the person running the evaluation, never by the grader.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeGolden, openGolden, type Golden, type GoldenSession } from "./golden.js";
import { gradeRun, reviewTemplate } from "./graders.js";
import { scenarioById, type EvalScenario } from "./scenarios.js";
import { Attributions, EvalResult, Review, RunMeta, stableJson } from "./schema.js";
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

export async function evaluateDir(out: string): Promise<Graded> {
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
        await gradeRun({ scenario, runKey: key, meta: meta.value, traceText: readText(join(dir, "trace.jsonl")), review: review.value, golden: g.golden, session: g.session, attributions: attributions.value?.entries ?? [] }),
      );
      if (meta.problem) result.ungradable.push(`run.json ${meta.problem}`);
      if (review.problem) result.ungradable.push(`review.json ${review.problem}`);
      if (attributions.problem) result.ungradable.push(`${ATTRIBUTIONS} ${attributions.problem} (ignored)`);
      if (existsSync(dir)) {
        writeFileSync(join(dir, "result.json"), stableJson(result));
        if (!existsSync(join(dir, "review.json")) && scenario.rubrics.length > 0) writeFileSync(join(dir, "review.json"), stableJson(reviewTemplate(key, scenario)));
      }
      results.push(result);
    }
  } finally {
    for (const g of goldens.values()) await g.session.close();
  }
  const scorecard = buildScorecard(results);
  writeFileSync(join(out, "scorecard.json"), stableJson({ ...scorecard, unknownScenarios, attributionFileProblem: attributions.problem }));
  writeFileSync(join(out, "scorecard.md"), renderScorecard(scorecard) + (unknownScenarios.length ? `\nUnknown scenarios (not graded): ${unknownScenarios.join(", ")}\n` : ""));
  return { results, scorecard, unknownScenarios };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: npx tsx test-agent/eval/evaluate.ts <outDir>");
    process.exit(2);
  }
  const { scorecard } = await evaluateDir(resolve(out));
  console.log(renderScorecard(scorecard));
}
