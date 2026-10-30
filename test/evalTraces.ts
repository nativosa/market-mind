// Synthetic stream-json traces and run metadata for offline grader tests. Tool results are produced by the
// real in-process MarketMind server over the evaluation fixtures, exactly as the subagent would see them.
import { openGolden, type Golden } from "../test-agent/eval/golden.js";
import { RUN_CONTRACT, type RunMeta } from "../test-agent/eval/schema.js";
import { SCENARIO_SET, promptFor, type EvalScenario } from "../test-agent/eval/scenarios.js";
import { FORKED_PARENT, SUBAGENT_TYPE } from "../test-agent/eval/trace.js";
import { FIXTURE_REVISION } from "../test-agent/fixtures.js";

export interface PlannedCall {
  name: string;
  args: Record<string, unknown>;
  scope?: "main" | "subagent";
  /** Replace the replayed result (e.g. a tampered or denied result). */
  result?: { isError: boolean; text: string };
}

const H = "0".repeat(64);
const line = (o: object) => JSON.stringify(o);

export async function buildTrace(s: EvalScenario, calls: PlannedCall[], report: string, opts: { result?: boolean; cost?: number } = {}): Promise<string> {
  const g = await openGolden(s.db);
  const lines: string[] = [];
  try {
    lines.push(line({ type: "system", subtype: "task_started", subagent_type: SUBAGENT_TYPE, task_id: "t1" }));
    lines.push(
      line({
        type: "system",
        subtype: "init",
        claude_code_version: "2.1.302",
        model: "claude-opus-5-5",
        permissionMode: "default",
        tools: ["Bash", "Read", "mcp__marketmind__inspect_market"],
        agents: ["market-investigator"],
        skills: ["investigate-market"],
        mcp_servers: [{ name: "marketmind", status: "connected" }],
      }),
    );
    lines.push(line({ type: "user", parent_tool_use_id: FORKED_PARENT, message: { content: [{ type: "text", text: promptFor(s) }] } }));
    let n = 0;
    for (const c of calls) {
      const id = `toolu_${++n}`;
      const parent = c.scope === "main" ? null : FORKED_PARENT;
      lines.push(line({ type: "assistant", parent_tool_use_id: parent, ...(parent ? { subagent_type: SUBAGENT_TYPE } : {}), message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", id, name: c.name, input: c.args }] } }));
      let result = c.result;
      if (!result) {
        if (c.name.startsWith("mcp__marketmind__")) {
          const r = await g.replay(c.name.replace("mcp__marketmind__", ""), c.args);
          result = { isError: r.status === "error", text: JSON.stringify(r.json) };
        } else result = { isError: true, text: `Error: No such tool available: ${c.name}` };
      }
      lines.push(line({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: result.isError, content: result.text }] } }));
    }
    lines.push(line({ type: "assistant", parent_tool_use_id: FORKED_PARENT, subagent_type: SUBAGENT_TYPE, message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: report }] } }));
    lines.push(line({ type: "system", subtype: "task_notification", status: "completed", task_id: "t1" }));
    if (opts.result !== false) {
      lines.push(
        line({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 30_000,
          num_turns: 0,
          total_cost_usd: opts.cost ?? 0.05,
          permission_denials: [],
          modelUsage: { "claude-sonnet-5-5": { inputTokens: 10, outputTokens: 3000, cacheReadInputTokens: 9000, cacheCreationInputTokens: 12000, costUSD: opts.cost ?? 0.05, costBasis: "list" } },
          result: report,
        }),
      );
    }
  } finally {
    await g.close();
  }
  return lines.join("\n");
}

export function runMeta(s: EvalScenario, golden: Golden, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    contract: RUN_CONTRACT,
    runKey: `${s.id}-r1`,
    scenarioId: s.id,
    scenarioSet: SCENARIO_SET,
    repetition: 1,
    fixtureRevision: FIXTURE_REVISION,
    fixtureDigest: golden.fixtureDigest,
    investigator: { agentSha256: H, skillSha256: H, settingsSha256: H, baselineTag: "v0.5.0", matchesBaseline: true, gitCommit: "e1f5c63", gitDirty: false },
    prompt: promptFor(s),
    flags: [],
    maxBudgetUsd: 0.4,
    timeoutMs: 300_000,
    executedAt: "2026-10-30T10:00:00.000Z",
    durationMs: 31_000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    launchError: null,
    processCleanup: { treeKilled: false, orphansFound: 0, orphansKilled: 0 },
    integrity: { dbBefore: H, dbAfter: H, repoBefore: H, repoAfter: H, projectBefore: H, projectAfter: H },
    ...overrides,
  };
}

/** A report that satisfies the contract for a Mode A scenario, built from golden values. */
export function goodReport(g: Golden, opts: { label: string; citations?: number; extra?: Partial<Record<number, string>> } ): string {
  const i = g.inspect!;
  const [a, b] = i.outcomes;
  const m = (o: typeof a) => o!.metrics!;
  const cell = (p: string | null, size: string | null) => (p === null ? "null" : `${p} (${size})`);
  const st = g.history?.stats;
  const rows = g.history?.rows.items ?? [];
  const cites = rows.slice(0, opts.citations ?? 2).map((r) => `obs ${r.observationId} / run ${r.runId} (local DB only)`);
  const sec = (n: number, title: string, body: string) => `## ${n}. ${title}\n${body}${opts.extra?.[n] ? `\n${opts.extra[n]}` : ""}\n`;
  return [
    `# Market investigation: ${i.market.gammaId}\n`,
    sec(1, "Market identification", `- Gamma id \`${i.market.gammaId}\`, protocol ${i.market.protocolVersion}. [FACT E1]\n- Live data come from simulated hosts.`),
    sec(2, "Investigation objective", "- Mode A. Synthetic history authorized."),
    sec(
      3,
      "Current book observations",
      `| Item | ${a!.label} (index 0, reference) | ${b!.label} (index 1) |\n|---|---|---|\n| Best bid (size) | ${cell(m(a).bestBid, m(a).bestBidSize)} | ${cell(m(b).bestBid, m(b).bestBidSize)} |\n| Best ask (size) | ${cell(m(a).bestAsk, m(a).bestAskSize)} | ${cell(m(b).bestAsk, m(b).bestAskSize)} |\n| Spread | ${m(a).spread ?? "null"} | ${m(b).spread ?? "null"} |
| Midpoint | ${m(a).midpoint ?? "null"} | ${m(b).midpoint ?? "null"} |\n| State | ${m(a).state} | ${m(b).state} |`,
    ),
    sec(
      4,
      "Historical evidence",
      st
        ? `- Usable observations: ${st.usable} of ${st.eligible} eligible. [FACT E2]\n- Spread min ${st.spread.min}, median ${st.spread.median}, max ${st.spread.max}. [FACT E2]\n- Gaps: ${st.gaps.irregular} irregular.\n- Examples: ${cites.join("; ")}.\n- Persistence between observations is unknown.`
        : `- get_market_history returned ${g.historyError ? `error ${g.historyError}: database missing` : "no_history"}. [FACT E2]\n- Persistence is unknown.`,
    ),
    sec(5, "Data quality and limitations", "- Books are separate requests. Thresholds are provisional heuristics. A spread is not a profit."),
    sec(6, "Key findings", "- [FACT E1] Current book as tabulated.\n- [INTERPRETATION] Limited evidence."),
    sec(7, "Research classification", `- Label: ${opts.label}.\n- Evidence strength: limited.\n- Research classification only; not a trading recommendation.`),
    sec(8, "Evidence references", `| E# | Tool | Status |\n|---|---|---|\n| E1 | inspect_market | ok |\n| E2 | get_market_history | ${g.history?.status ?? "error"} |${cites.length ? `\n\n${cites.join("; ")}` : ""}`),
    sec(9, "Unanswered questions", "- What happened between samples?"),
    sec(10, "Tool usage", "- inspect_market 1, get_market_history 1."),
  ].join("\n");
}
