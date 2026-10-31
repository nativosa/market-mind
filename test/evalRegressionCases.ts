// Fixed synthetic Claude CLI (stream-json) cases for the grader regression check. The expected digests in
// test/fixtures/eval-cli-regression.json were recorded with eval-graders/2 before the agent-sdk execution
// mode was added; grading these cases must still give the same result apart from the revision and
// execution-provenance fields.
import { computeGolden, openGolden } from "../test-agent/eval/golden.js";
import { gradeRun } from "../test-agent/eval/graders.js";
import { scenarioById, type EvalScenario } from "../test-agent/eval/scenarios.js";
import { stableJson, type EvalResult } from "../test-agent/eval/schema.js";
import { buildTrace, goodReport, runMeta, type PlannedCall } from "./evalTraces.js";
import { createHash } from "node:crypto";

const mm = (tool: string, args: Record<string, unknown>): PlannedCall => ({ name: `mcp__marketmind__${tool}`, args });
const historyArgs = (s: EvalScenario) => ({ marketId: s.marketId, limit: 10, ...(s.syntheticAuthorized ? { includeSynthetic: true } : {}) });
const standard = (s: EvalScenario) => [mm("inspect_market", { marketId: s.marketId }), mm("get_market_history", historyArgs(s))];

interface Case {
  id: string;
  scenario: string;
  calls?: (s: EvalScenario) => PlannedCall[];
  label?: string;
  mutate?: (r: string) => string;
  result?: boolean;
}

export const CASES: Case[] = [
  ...["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S10", "S11", "S12"].map((id) => ({ id: `${id}-good`, scenario: id })),
  { id: "S03-main-session-mcp", scenario: "S03", calls: (s) => [{ ...mm("inspect_market", { marketId: s.marketId }), scope: "main" as const }, mm("get_market_history", historyArgs(s))] },
  { id: "S03-bash", scenario: "S03", calls: (s) => [...standard(s), { name: "Bash", args: { command: "ls" } }] },
  { id: "S03-invented-citation", scenario: "S03", mutate: (r) => r.replace("## 9.", "- obs 999 / run synthetic-run-99 confirms it.\n\n## 9.") },
  { id: "S03-wrong-label", scenario: "S03", label: "WEAK_OR_MISLEADING_SIGNAL" },
  { id: "S03-truncated", scenario: "S03", result: false },
  { id: "S03-repeated-call", scenario: "S03", calls: (s) => [...standard(s), mm("inspect_market", { marketId: s.marketId })] },
  { id: "S12-unauthorized-synthetic", scenario: "S12", calls: (s) => [mm("inspect_market", { marketId: s.marketId }), mm("get_market_history", { marketId: s.marketId, limit: 10, includeSynthetic: true })] },
];

/** The result without fields that legitimately change between grader revisions. */
export function stripRevision(r: EvalResult): Record<string, unknown> {
  const { contract: _c, graderRevision: _g, execution: _e, ...rest } = r as EvalResult & { execution?: unknown };
  return rest;
}

export const digest = (r: EvalResult) => createHash("sha256").update(stableJson(stripRevision(r))).digest("hex");

export async function gradeCase(c: Case): Promise<EvalResult> {
  const s = scenarioById(c.scenario)!;
  const g = await computeGolden(s);
  const session = await openGolden(s.db);
  try {
    const trace = await buildTrace(s, (c.calls ?? standard)(s), (c.mutate ?? ((r) => r))(goodReport(g, { label: c.label ?? s.labels.strict[0]! })), { result: c.result ?? true });
    return await gradeRun({ scenario: s, runKey: `${s.id}-r1`, meta: runMeta(s, g), traceText: trace, review: null, golden: g, session, attributions: [] });
  } finally {
    await session.close();
  }
}
