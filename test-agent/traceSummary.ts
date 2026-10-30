// Human-readable summary of a `claude -p --output-format stream-json --verbose` trace: who called which
// tool (main session vs subagent, by parent_tool_use_id), errors, denials and cost. Counts only; grading
// lives in eval/. Built on the strict parser in eval/trace.ts.
// Usage: npx tsx test-agent/traceSummary.ts <trace.jsonl>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_TOOLS } from "./eval/graders.js";
import { parseTrace } from "./eval/trace.js";

export const ALLOWED_SUBAGENT_TOOLS = new Set(ALLOWED_TOOLS);

export interface ToolCall {
  scope: "main" | "subagent";
  parent: string | null;
  name: string;
  input: unknown;
  isError: boolean | null;
  resultText: string;
}

export interface TraceSummary {
  problems: string[];
  init: { model: unknown; permissionMode: unknown; marketmindTools: string[] } | null;
  calls: ToolCall[];
  counts: Record<string, { main: number; subagent: number }>;
  subagentParents: string[];
  unauthorizedSubagentCalls: ToolCall[];
  mainMarketmindCalls: ToolCall[];
  subagentFinalText: string;
  result: { subtype: unknown; isError: unknown; numTurns: unknown; costUsd: number | null; permissionDenials: unknown; text: string } | null;
}

export function summarizeTrace(jsonl: string): TraceSummary {
  const t = parseTrace(jsonl);
  const calls: ToolCall[] = t.calls.map((c) => ({
    scope: c.scope,
    parent: c.parent,
    name: c.name,
    input: c.input,
    isError: c.result.status === "missing" ? null : c.result.status === "error",
    resultText: c.result.text.slice(0, 400),
  }));
  const counts: TraceSummary["counts"] = {};
  for (const c of calls) {
    counts[c.name] ??= { main: 0, subagent: 0 };
    counts[c.name]![c.scope]++;
  }
  return {
    problems: t.problems,
    init: t.init && { model: t.init.mainModel, permissionMode: t.init.permissionMode, marketmindTools: t.init.tools.filter((x) => x.startsWith("mcp__marketmind__")) },
    calls,
    counts,
    subagentParents: [...new Set(calls.filter((c) => c.parent).map((c) => c.parent!))],
    unauthorizedSubagentCalls: calls.filter((c) => c.scope === "subagent" && !ALLOWED_SUBAGENT_TOOLS.has(c.name)),
    mainMarketmindCalls: calls.filter((c) => c.scope === "main" && c.name.startsWith("mcp__marketmind__")),
    subagentFinalText: t.subagent.finalText,
    result: t.result && { subtype: t.result.subtype, isError: t.result.isError, numTurns: t.result.numTurns, costUsd: t.result.costUsd, permissionDenials: t.result.permissionDenials, text: t.result.text },
  };
}

export function printSummary(s: TraceSummary): string {
  const lines: string[] = [];
  if (s.problems.length) lines.push(`TRACE PROBLEMS: ${s.problems.join("; ")}`);
  lines.push(`init: model=${String(s.init?.model)} permissionMode=${String(s.init?.permissionMode)} marketmindTools=${s.init?.marketmindTools.length ?? 0}`);
  lines.push(`subagent parent ids: ${s.subagentParents.join(", ") || "(none)"}`);
  lines.push("tool calls (in order):");
  for (const c of s.calls) lines.push(`  [${c.scope}] ${c.name} ${JSON.stringify(c.input)} -> ${c.isError === null ? "no result" : c.isError ? "ERROR" : "ok"}`);
  lines.push(`counts: ${JSON.stringify(s.counts)}`);
  lines.push(`unauthorized subagent calls: ${s.unauthorizedSubagentCalls.length}`);
  lines.push(`marketmind calls by main session: ${s.mainMarketmindCalls.length}`);
  lines.push(`result: ${String(s.result?.subtype)} isError=${String(s.result?.isError)} turns=${String(s.result?.numTurns)} cost=$${s.result?.costUsd ?? "?"}`);
  lines.push(`permission denials: ${JSON.stringify(s.result?.permissionDenials ?? null)}`);
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(printSummary(summarizeTrace(readFileSync(process.argv[2]!, "utf8"))));
}
