// Deterministic summary of a `claude -p --output-format stream-json --verbose` trace: who called which
// tool (main session vs subagent, by parent_tool_use_id), errors, denials and cost. Counts only; it
// does not grade the report. Usage: npx tsx test-agent/traceSummary.ts <trace.jsonl>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_SUBAGENT_TOOLS = new Set(
  ["scan_markets", "inspect_market", "list_collection_runs", "get_market_history", "get_observation_details"].map((t) => `mcp__marketmind__${t}`),
);

interface Block {
  type: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
}
interface Event {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: Block[] | string };
  [key: string]: unknown;
}

export interface ToolCall {
  scope: "main" | "subagent";
  parent: string | null;
  name: string;
  input: unknown;
  isError: boolean | null;
  resultText: string;
}

export interface TraceSummary {
  init: { model: unknown; permissionMode: unknown; marketmindTools: string[]; mcpServers: unknown; agents: unknown; skills: unknown; slashCommands: unknown } | null;
  calls: ToolCall[];
  counts: Record<string, { main: number; subagent: number }>;
  subagentParents: string[];
  unauthorizedSubagentCalls: ToolCall[];
  mainMarketmindCalls: ToolCall[];
  subagentFinalText: string;
  result: { subtype: unknown; isError: unknown; numTurns: unknown; costUsd: number | null; permissionDenials: unknown; text: string } | null;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: Block) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n") : "";

export function summarizeTrace(jsonl: string): TraceSummary {
  const events = jsonl
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as Event);
  const calls = new Map<string, ToolCall>();
  const subagentText: string[] = [];
  let init: TraceSummary["init"] = null;
  let result: TraceSummary["result"] = null;
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      const tools = (e.tools as string[] | undefined) ?? [];
      init = {
        model: e.model,
        permissionMode: e.permissionMode,
        marketmindTools: tools.filter((t) => t.startsWith("mcp__marketmind__")),
        mcpServers: e.mcp_servers,
        agents: e.agents,
        skills: e.skills,
        slashCommands: e.slash_commands,
      };
    }
    const parent = e.parent_tool_use_id ?? null;
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const b of content) {
      if (e.type === "assistant" && b.type === "tool_use" && b.id) {
        calls.set(b.id, { scope: parent ? "subagent" : "main", parent, name: b.name ?? "?", input: b.input, isError: null, resultText: "" });
      }
      if (e.type === "assistant" && b.type === "text" && parent) subagentText.push(b.text ?? "");
      if (e.type === "user" && b.type === "tool_result" && b.tool_use_id) {
        const c = calls.get(b.tool_use_id);
        if (c) {
          c.isError = b.is_error === true;
          c.resultText = textOf(b.content).slice(0, 400);
        }
      }
    }
    if (e.type === "result") {
      result = {
        subtype: e.subtype,
        isError: e.is_error,
        numTurns: e.num_turns,
        costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
        permissionDenials: e.permission_denials,
        text: typeof e.result === "string" ? e.result : "",
      };
    }
  }
  const all = [...calls.values()];
  const counts: TraceSummary["counts"] = {};
  for (const c of all) {
    counts[c.name] ??= { main: 0, subagent: 0 };
    counts[c.name]![c.scope]++;
  }
  return {
    init,
    calls: all,
    counts,
    subagentParents: [...new Set(all.filter((c) => c.parent).map((c) => c.parent!))],
    unauthorizedSubagentCalls: all.filter((c) => c.scope === "subagent" && !ALLOWED_SUBAGENT_TOOLS.has(c.name)),
    mainMarketmindCalls: all.filter((c) => c.scope === "main" && c.name.startsWith("mcp__marketmind__")),
    subagentFinalText: subagentText.at(-1) ?? "",
    result,
  };
}

export function printSummary(s: TraceSummary): string {
  const lines: string[] = [];
  lines.push(`init: model=${String(s.init?.model)} permissionMode=${String(s.init?.permissionMode)} marketmindTools=${s.init?.marketmindTools.length ?? 0}`);
  lines.push(`subagent parent ids: ${s.subagentParents.join(", ") || "(none)"}`);
  lines.push("tool calls (in order):");
  for (const c of s.calls) lines.push(`  [${c.scope}] ${c.name} ${JSON.stringify(c.input)} -> ${c.isError === null ? "no result" : c.isError ? "ERROR" : "ok"}`);
  lines.push(`counts: ${JSON.stringify(s.counts)}`);
  lines.push(`unauthorized subagent calls: ${s.unauthorizedSubagentCalls.length}`);
  lines.push(`marketmind calls by main session: ${s.mainMarketmindCalls.length}`);
  lines.push(`result: ${s.result?.subtype as string} isError=${String(s.result?.isError)} turns=${String(s.result?.numTurns)} cost=$${s.result?.costUsd ?? "?"}`);
  lines.push(`permission denials: ${JSON.stringify(s.result?.permissionDenials ?? null)}`);
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(printSummary(summarizeTrace(readFileSync(process.argv[2]!, "utf8"))));
}
