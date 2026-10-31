// Deterministic comparison of two graded evaluation directories (offline; no Claude invocation):
//
//   npx tsx test-agent/eval/compare.ts <baselineDir> <candidateDir> [--json]
//
// It reads result.json/run.json (result/2 and result/3, run/1 and run/2) and execution.json for agent-sdk
// runs, never re-grades and never writes into either directory. Confounders come first: any difference in
// execution mode, SDK or Claude Code version, models, investigator or prompt, permissions, fixture or
// grader revision is listed before per-scenario deltas. With few runs per scenario, deltas are descriptive.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const Result = z.object({
  runKey: z.string(),
  scenarioId: z.string(),
  graderRevision: z.string().optional(),
  claudeCodeVersion: z.string().nullable(),
  execution: z.object({ mode: z.string(), sdkVersion: z.string().nullable(), optionsDigest: z.string().nullable() }).passthrough().optional(),
  models: z.object({ main: z.string().nullable(), subagent: z.array(z.string()) }),
  investigator: z.object({ agentSha256: z.string(), skillSha256: z.string(), settingsSha256: z.string() }).passthrough().nullable(),
  fixture: z.object({ recordedDigest: z.string().nullable() }).passthrough(),
  runStatus: z.string(),
  contamination: z.string().optional(),
  toolCalls: z.array(z.object({ scope: z.string(), name: z.string() }).passthrough()),
  classification: z.object({ stated: z.array(z.string()) }).passthrough(),
  evidence: z.object({ affirmative: z.number().optional(), affirmativeValid: z.number().optional(), ambiguous: z.number().optional(), quotedOrDescribed: z.number().optional() }).passthrough(),
  usage: z.object({ estimatedCostUsd: z.number().nullable(), durationMs: z.number().nullable(), numTurns: z.number().nullable() }).passthrough(),
  checks: z.array(z.object({ id: z.string(), verdict: z.string() }).passthrough()),
  deterministicVerdict: z.string(),
  overallVerdict: z.string(),
});
const Run = z.object({ prompt: z.string(), flags: z.array(z.string()), execution: z.object({ mode: z.string() }).passthrough().optional() }).passthrough();
const Execution = z.object({
  harness: z.object({ permissionMode: z.string(), allowedTools: z.array(z.string()), builtinTools: z.array(z.string()), settingSources: z.array(z.string()), strictMcpConfig: z.boolean(), sdkVersion: z.string(), optionsDigest: z.string(), guardSha256: z.string().nullable().optional() }).passthrough(),
  investigator: z.object({ promptSha256: z.string() }).passthrough(),
});

export interface RunSummary {
  runKey: string;
  scenarioId: string;
  mode: string;
  graderRevision: string;
  claudeCodeVersion: string | null;
  sdkVersion: string | null;
  investigatorModel: string | null;
  otherModels: string[];
  investigator: string | null;
  task: string;
  promptRendering: string;
  permissions: string;
  fixtureDigest: string | null;
  toolSequence: string[];
  classification: string[];
  citations: { affirmative: number; valid: number; ambiguous: number; quotedOrDescribed: number };
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  runStatus: string;
  contamination: string;
  deterministicVerdict: string;
  failedChecks: string[];
}

function readJson(path: string): unknown {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null;
}

/** CLI flags reduced to what decides permissions (no paths). */
function cliPermissions(flags: string[]): string {
  const val = (f: string) => (flags.includes(f) ? flags[flags.indexOf(f) + 1] : undefined);
  return `claude-cli: --permission-mode ${val("--permission-mode") ?? "?"}; --setting-sources ${val("--setting-sources") ?? "?"}; allow rules ${flags.includes("--settings") ? "from the investigator settings file" : "none"}; strict MCP ${flags.includes("--strict-mcp-config")}`;
}

export function summarizeDir(dir: string): RunSummary[] {
  const out: RunSummary[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const result = Result.safeParse(readJson(join(dir, d, "result.json")));
    if (!result.success) continue;
    const r = result.data;
    const run = Run.safeParse(readJson(join(dir, d, "run.json")));
    const mode = r.execution?.mode ?? "claude-cli";
    const exec = mode === "agent-sdk" ? Execution.safeParse(readJson(join(dir, d, "execution.json"))) : null;
    const investigatorScope = mode === "agent-sdk" ? "main" : "subagent";
    const h = exec?.success ? exec.data.harness : null;
    out.push({
      runKey: r.runKey,
      scenarioId: r.scenarioId,
      mode,
      graderRevision: r.graderRevision ?? "eval-graders/1",
      claudeCodeVersion: r.claudeCodeVersion,
      sdkVersion: r.execution?.sdkVersion ?? null,
      investigatorModel: mode === "agent-sdk" ? r.models.main : (r.models.subagent.join("+") || null),
      otherModels: mode === "agent-sdk" ? r.models.subagent : r.models.main ? [r.models.main] : [],
      investigator: r.investigator ? `${r.investigator.agentSha256.slice(0, 12)}/${r.investigator.skillSha256.slice(0, 12)}/${r.investigator.settingsSha256.slice(0, 12)}` : null,
      task: run.success ? sha(run.data.prompt).slice(0, 12) : "unknown",
      promptRendering: mode === "agent-sdk" ? `agent-sdk: skill body rendered by MarketMind (${exec?.success ? exec.data.investigator.promptSha256.slice(0, 12) : "?"})` : "claude-cli: /investigate-market expanded by Claude Code (forked skill)",
      permissions: h
        ? `agent-sdk: ${h.permissionMode}; allow [${h.allowedTools.length} MarketMind tools]; built-in tools ${h.builtinTools.length}; setting sources [${h.settingSources.join(",")}]; strict MCP ${h.strictMcpConfig}; PreToolUse guard ${h.guardSha256?.slice(0, 12) ?? "(hash not recorded)"}`
        : run.success
          ? cliPermissions(run.data.flags)
          : "unknown",
      fixtureDigest: r.fixture.recordedDigest,
      toolSequence: r.toolCalls.filter((c) => c.scope === investigatorScope).map((c) => c.name.replace(/^mcp__marketmind__/, "")),
      classification: r.classification.stated,
      citations: { affirmative: r.evidence.affirmative ?? 0, valid: r.evidence.affirmativeValid ?? 0, ambiguous: r.evidence.ambiguous ?? 0, quotedOrDescribed: r.evidence.quotedOrDescribed ?? 0 },
      costUsd: r.usage.estimatedCostUsd,
      durationMs: r.usage.durationMs,
      numTurns: r.usage.numTurns,
      runStatus: r.runStatus,
      contamination: r.contamination ?? "unknown",
      deterministicVerdict: r.deterministicVerdict,
      failedChecks: r.checks.filter((c) => c.verdict === "FAIL" || c.verdict === "NEEDS_REVIEW").map((c) => `${c.id}:${c.verdict}`),
    });
  }
  return out;
}

const distinct = <T>(xs: T[]) => [...new Set(xs.map((x) => JSON.stringify(x)))].sort().map((x) => JSON.parse(x) as T);
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(6)) : null;
};

const CONFOUNDERS: [string, (r: RunSummary) => unknown][] = [
  ["execution mode", (r) => r.mode],
  ["SDK version", (r) => r.sdkVersion],
  ["Claude Code version", (r) => r.claudeCodeVersion],
  ["investigator model", (r) => r.investigatorModel],
  ["other models", (r) => r.otherModels],
  ["investigator policy (agent/skill/settings)", (r) => r.investigator],
  ["prompt rendering", (r) => r.promptRendering.replace(/ \([0-9a-f?]+\)$/, "")],
  ["effective permissions", (r) => r.permissions],
  ["fixture digest", (r) => r.fixtureDigest],
  ["grader revision", (r) => r.graderRevision],
];

export function compare(baseline: RunSummary[], candidate: RunSummary[]) {
  const scenarios = [...new Set(candidate.map((r) => r.scenarioId))].sort();
  const base = baseline.filter((r) => scenarios.includes(r.scenarioId));
  const confounders = CONFOUNDERS.map(([name, f]) => {
    const b = distinct(base.map(f));
    const c = distinct(candidate.map(f));
    return { name, baseline: b, candidate: c, same: JSON.stringify(b) === JSON.stringify(c) };
  });
  const group = (rs: RunSummary[]) => ({
    runs: rs.length,
    runKeys: rs.map((r) => r.runKey),
    labels: distinct(rs.map((r) => r.classification)),
    toolSequences: distinct(rs.map((r) => r.toolSequence)),
    citations: rs.reduce((a, r) => ({ affirmative: a.affirmative + r.citations.affirmative, valid: a.valid + r.citations.valid, ambiguous: a.ambiguous + r.citations.ambiguous }), { affirmative: 0, valid: 0, ambiguous: 0 }),
    meanCostUsd: mean(rs.map((r) => r.costUsd)),
    meanDurationMs: mean(rs.map((r) => r.durationMs)),
    meanTurns: mean(rs.map((r) => r.numTurns)),
    deterministicVerdicts: distinct(rs.map((r) => r.deterministicVerdict)),
    contamination: distinct(rs.map((r) => r.contamination)),
    failedChecks: distinct(rs.flatMap((r) => r.failedChecks)),
  });
  const perScenario = scenarios.map((id) => {
    const b = base.filter((r) => r.scenarioId === id);
    const bClean = b.filter((r) => r.contamination === "clean" || r.contamination === "unknown");
    const c = candidate.filter((r) => r.scenarioId === id);
    const gb = group(b);
    const gc = group(c);
    return {
      scenarioId: id,
      baseline: gb,
      baselineCleanRuns: bClean.length,
      candidate: gc,
      changes: {
        labels: JSON.stringify(gb.labels) !== JSON.stringify(gc.labels),
        toolSequences: JSON.stringify(gb.toolSequences) !== JSON.stringify(gc.toolSequences),
        deterministicVerdicts: JSON.stringify(gb.deterministicVerdicts) !== JSON.stringify(gc.deterministicVerdicts),
      },
    };
  });
  const missingInBaseline = scenarios.filter((id) => !base.some((r) => r.scenarioId === id));
  return {
    contract: "marketmind.eval.comparison/1",
    note: "Descriptive only: few runs per scenario, no seed. Confounders are listed first; a difference there means results are not attributable to the investigator alone.",
    confounders,
    confounded: confounders.filter((c) => !c.same).map((c) => c.name),
    scenarios,
    missingInBaseline,
    perScenario,
  };
}
export type Comparison = ReturnType<typeof compare>;

export function renderComparison(c: Comparison): string {
  const L: string[] = ["# Evaluation comparison", "", c.note, "", "## Confounders", "", "| Factor | Baseline | Candidate | Same |", "|---|---|---|---|"];
  for (const k of c.confounders) L.push(`| ${k.name} | ${JSON.stringify(k.baseline)} | ${JSON.stringify(k.candidate)} | ${k.same ? "yes" : "**no**"} |`);
  L.push("", c.confounded.length ? `Confounded by: ${c.confounded.join(", ")}.` : "No confounders differ.", "", "## Per scenario", "");
  L.push("| Scenario | Runs (base/cand) | Labels base -> cand | Tool sequences | Affirmative citations valid | Mean cost (est.) | Mean latency ms | Deterministic verdicts |", "|---|---|---|---|---|---|---|---|");
  for (const s of c.perScenario) {
    L.push(
      `| ${s.scenarioId} | ${s.baseline.runs} (clean ${s.baselineCleanRuns}) / ${s.candidate.runs} | ${JSON.stringify(s.baseline.labels)} -> ${JSON.stringify(s.candidate.labels)}${s.changes.labels ? " **changed**" : ""} | ${s.changes.toolSequences ? "**changed**" : "same"} | ${s.baseline.citations.valid}/${s.baseline.citations.affirmative} -> ${s.candidate.citations.valid}/${s.candidate.citations.affirmative} | ${s.baseline.meanCostUsd ?? "?"} -> ${s.candidate.meanCostUsd ?? "?"} | ${s.baseline.meanDurationMs ?? "?"} -> ${s.candidate.meanDurationMs ?? "?"} | ${JSON.stringify(s.baseline.deterministicVerdicts)} -> ${JSON.stringify(s.candidate.deterministicVerdicts)} |`,
    );
  }
  if (c.missingInBaseline.length) L.push("", `Not in the baseline: ${c.missingInBaseline.join(", ")}.`);
  return L.join("\n") + "\n";
}

export const compareDirs = (baselineDir: string, candidateDir: string) => compare(summarizeDir(baselineDir), summarizeDir(candidateDir));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [b, c] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!b || !c) {
    console.error("usage: npx tsx test-agent/eval/compare.ts <baselineDir> <candidateDir> [--json]");
    process.exit(2);
  }
  const result = compareDirs(resolve(b), resolve(c));
  console.log(process.argv.includes("--json") ? JSON.stringify(result, null, 2) : renderComparison(result));
}
