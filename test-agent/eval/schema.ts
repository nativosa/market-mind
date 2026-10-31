// Versioned evaluation contracts: per-run metadata (written by the runner), per-run deterministic result
// (written by the grader), human review (filled in by a person) and the scorecard.
import { z } from "zod";

/** run/2 adds the execution mode; run/1 files (the frozen CLI baseline) still parse and mean claude-cli. */
export const RUN_CONTRACT = "marketmind.eval.run/2";
export const RUN_CONTRACT_V1 = "marketmind.eval.run/1";
export const RESULT_CONTRACT = "marketmind.eval.result/3";
export const REVIEW_CONTRACT = "marketmind.eval.review/1";
export const SCORECARD_CONTRACT = "marketmind.eval.scorecard/4";
export const ATTRIBUTION_CONTRACT = "marketmind.eval.attribution/1";

export const Verdict = z.enum(["PASS", "FAIL", "NEEDS_REVIEW", "NOT_EVALUATED"]);
export type Verdict = z.infer<typeof Verdict>;
export const CheckClass = z.enum(["framework", "fixture", "environment", "gate", "execution", "safety", "integrity", "quality", "review"]);
export type CheckClass = z.infer<typeof CheckClass>;
export const RunStatus = z.enum(["completed", "timeout", "budget_stopped", "error", "crashed", "unparseable", "launch_failed", "missing_artifacts"]);
export type RunStatus = z.infer<typeof RunStatus>;

const sha = z.string().regex(/^[0-9a-f]{64}$/);

export const Investigator = z
  .object({
    agentSha256: sha,
    skillSha256: sha,
    settingsSha256: sha,
    baselineTag: z.string(),
    matchesBaseline: z.boolean().nullable(),
    gitCommit: z.string().nullable(),
    gitDirty: z.boolean().nullable(),
  })
  .strict();

/** How a run was executed and which artifact holds its events. */
export const ExecutionMode = z.enum(["claude-cli", "agent-sdk"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;
export const RunExecution = z
  .object({
    mode: ExecutionMode,
    /** trace.jsonl (Claude Code stream-json) or execution.json (marketmind.agent.execution/1). */
    artifact: z.enum(["trace.jsonl", "execution.json"]),
  })
  .strict();

export const RunMeta = z
  .object({
    contract: z.enum([RUN_CONTRACT, RUN_CONTRACT_V1]),
    execution: RunExecution.optional(),
    runKey: z.string(),
    scenarioId: z.string(),
    scenarioSet: z.string(),
    repetition: z.number().int().min(1),
    fixtureRevision: z.string(),
    fixtureDigest: sha,
    investigator: Investigator,
    prompt: z.string(),
    flags: z.array(z.string()),
    maxBudgetUsd: z.number(),
    timeoutMs: z.number().int(),
    executedAt: z.string(),
    durationMs: z.number().int(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    launchError: z.string().nullable(),
    processCleanup: z.object({ treeKilled: z.boolean(), orphansFound: z.number().int(), orphansKilled: z.number().int() }).strict(),
    integrity: z
      .object({
        dbBefore: sha.nullable(),
        dbAfter: sha.nullable(),
        repoBefore: sha,
        repoAfter: sha,
        projectBefore: sha,
        projectAfter: sha,
      })
      .strict(),
  })
  .strict()
  .refine((m) => m.contract === RUN_CONTRACT_V1 || m.execution !== undefined, { message: "run/2 records its execution mode" })
  .refine((m) => m.execution === undefined || (m.execution.mode === "claude-cli") === (m.execution.artifact === "trace.jsonl"), { message: "execution artifact does not match its mode" });
export type RunMeta = z.infer<typeof RunMeta>;
/** The execution mode of a run (run/1 files predate the field and are Claude CLI runs). */
export const executionOf = (m: RunMeta | null): ExecutionMode => m?.execution?.mode ?? "claude-cli";

/**
 * A documented basis for attributing repository drift (D5c) to something other than the agent. Recorded by
 * whoever ran the evaluation, outside the grader. It applies only to the exact hashes it names and is
 * rejected when the trace shows any non-allowlisted tool call.
 */
export const Attribution = z
  .object({
    runKey: z.string(),
    check: z.literal("D5c"),
    category: z.literal("environment_interference"),
    repoBefore: sha,
    repoAfter: sha,
    basis: z.string().min(20),
    evidence: z.array(z.string().min(1)).min(1),
    recordedBy: z.string().min(1),
    recordedAt: z.string(),
    /** False unless a person has confirmed the attribution. */
    humanConfirmed: z.boolean(),
  })
  .strict();
export type Attribution = z.infer<typeof Attribution>;
export const Attributions = z.object({ contract: z.literal(ATTRIBUTION_CONTRACT), entries: z.array(Attribution) }).strict();
export type Attributions = z.infer<typeof Attributions>;

export const Check = z
  .object({
    id: z.string(),
    name: z.string(),
    class: CheckClass,
    verdict: Verdict,
    detail: z.string(),
    evidence: z.array(z.string()),
  })
  .strict();
export type Check = z.infer<typeof Check>;

export const RubricVerdict = z.enum(["UNREVIEWED", "PASS", "FAIL", "N/A"]);
export const Review = z
  .object({
    contract: z.literal(REVIEW_CONTRACT),
    runKey: z.string(),
    /** Must be set by a person; drafts produced by a model never count as a completed review. */
    independentHumanReview: z.boolean(),
    reviewer: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    items: z.record(z.string(), z.object({ rubric: z.string(), verdict: RubricVerdict, note: z.string() }).strict()),
  })
  .strict();
export type Review = z.infer<typeof Review>;

export const MentionKind = z.enum(["affirmative", "ambiguous", "quoted_or_described"]);
const IntegrityState = z.enum(["unchanged", "changed", "unknown"]);
/** clean: no drift; environment_interference: drift with an accepted attribution; unattributed_drift: drift, cause undetermined. */
export const Contamination = z.enum(["clean", "environment_interference", "unattributed_drift", "unknown"]);
export type Contamination = z.infer<typeof Contamination>;
export const FailureCategory = z.enum([
  "framework",
  "fixture",
  "environment",
  "environment_interference",
  "integrity_unattributed",
  "execution",
  "agent_safety",
  "agent_quality",
  "permission_control",
  "review",
]);
export type FailureCategory = z.infer<typeof FailureCategory>;

export const EvalResult = z
  .object({
    contract: z.literal(RESULT_CONTRACT),
    runKey: z.string(),
    scenarioId: z.string(),
    scenarioKind: z.enum(["golden", "probe"]),
    scenarioSet: z.string(),
    repetition: z.number().int().nullable(),
    fixture: z.object({ revision: z.string().nullable(), recordedDigest: z.string().nullable(), currentDigest: sha, match: z.boolean() }).strict(),
    investigator: Investigator.nullable(),
    claudeCodeVersion: z.string().nullable(),
    /** Execution provenance: never mixed; agent-sdk events are normalized, not presented as stream-json. */
    execution: z
      .object({ mode: ExecutionMode, source: z.enum(["claude-cli-stream-json", "agent-sdk"]).nullable(), sdkVersion: z.string().nullable(), optionsDigest: z.string().nullable() })
      .strict(),
    models: z.object({ main: z.string().nullable(), subagent: z.array(z.string()) }).strict(),
    executedAt: z.string().nullable(),
    graderRevision: z.string(),
    seed: z.null(),
    runStatus: RunStatus,
    toolCalls: z.array(
      z.object({ index: z.number().int(), scope: z.enum(["main", "subagent"]), name: z.string(), args: z.record(z.string(), z.unknown()), status: z.enum(["ok", "error", "missing"]), errorCategory: z.string().nullable() }).strict(),
    ),
    permissionDenials: z.array(z.string()),
    classification: z.object({ stated: z.array(z.string()), strict: z.array(z.string()), reviewable: z.array(z.string()), verdict: Verdict }).strict(),
    evidence: z
      .object({
        citations: z.array(
          z.object({ observationId: z.number().int(), runId: z.string(), context: z.string(), kind: MentionKind, evidenceClaim: z.boolean(), valid: z.boolean() }).strict(),
        ),
        /** Affirmative citations: the only ones in the validity denominator. */
        affirmative: z.number().int(),
        affirmativeValid: z.number().int(),
        ambiguous: z.number().int(),
        ambiguousInvalid: z.number().int(),
        quotedOrDescribed: z.number().int(),
        unpairedMentions: z.number().int(),
        unknownIds: z.number().int(),
      })
      .strict(),
    claims: z
      .object({ prohibitedAffirmative: z.number().int(), prohibitedAmbiguous: z.number().int(), prohibitedMentioned: z.number().int(), ungroundedValues: z.number().int() })
      .strict(),
    integrity: z
      .object({
        database: IntegrityState,
        project: IntegrityState,
        repository: z.enum(["unchanged", "drift_attributed", "drift_unattributed", "unknown"]),
        attribution: Attribution.nullable(),
        attributionRejected: z.string().nullable(),
      })
      .strict(),
    contamination: Contamination,
    /** Qualitative findings that carry no verdict (e.g. restated injected text). */
    observations: z.array(z.object({ id: z.string(), count: z.number().int(), detail: z.string(), evidence: z.array(z.string()) }).strict()),
    facts: z
      .object({
        coverage: z.array(z.object({ id: z.string(), description: z.string(), present: z.boolean() }).strict()),
        assertions: z.array(z.object({ id: z.string(), expected: z.string().nullable(), found: z.string().nullable(), verdict: Verdict }).strict()),
      })
      .strict(),
    checks: z.array(Check),
    review: z.object({ rubrics: z.array(z.string()), status: z.enum(["NOT_REQUIRED", "UNREVIEWED", "INCOMPLETE", "REVIEWED"]), outcome: Verdict.nullable() }).strict(),
    ungradable: z.array(z.string()),
    usage: z
      .object({
        estimatedCostUsd: z.number().nullable(),
        costBasis: z.string().nullable(),
        durationMs: z.number().nullable(),
        numTurns: z.number().nullable(),
        tokens: z.record(z.string(), z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheCreation: z.number() }).strict()),
      })
      .strict(),
    failureCategories: z.array(FailureCategory),
    deterministicVerdict: Verdict,
    overallVerdict: Verdict,
  })
  .strict();
export type EvalResult = z.infer<typeof EvalResult>;

/** JSON with sorted object keys and a trailing newline: byte-identical for identical content. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
