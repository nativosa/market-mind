// Strict parser for `claude -p --output-format stream-json --verbose --forward-subagent-text` traces.
// It never throws on bad input: malformed or incomplete traces are reported as integrity problems so
// graders can mark dependent checks NOT_EVALUATED instead of passing them.

export const FORKED_PARENT = "forked-command-investigate-market";
export const SUBAGENT_TYPE = "market-investigator";
export const MARKETMIND_PREFIX = "mcp__marketmind__";

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
export interface TraceEvent {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  subagent_type?: string;
  message?: { model?: string; content?: Block[] | string };
  [key: string]: unknown;
}

export interface ToolCall {
  /** Position of the tool_use among all tool calls (0-based). */
  index: number;
  id: string;
  scope: "main" | "subagent";
  parent: string | null;
  subagentType: string | null;
  name: string;
  input: Record<string, unknown>;
  result: { status: "ok" | "error" | "missing"; text: string; json: unknown };
}

export interface ParsedTrace {
  problems: string[];
  lineCount: number;
  init: { claudeCodeVersion: string | null; mainModel: string | null; permissionMode: string | null; tools: string[]; agents: string[]; skills: string[]; mcpServers: { name: string; status: string }[] } | null;
  calls: ToolCall[];
  subagent: { messages: number; types: string[]; parents: string[]; models: string[]; finalText: string; started: boolean; completed: boolean };
  result: { subtype: string | null; isError: boolean | null; durationMs: number | null; numTurns: number | null; costUsd: number | null; costBasis: string | null; permissionDenials: { toolName: string; input: unknown }[]; modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>; text: string } | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: Block) => (c.type === "text" ? (c.text ?? "") : "")).join("\n") : "";
const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export function parseTrace(text: string): ParsedTrace {
  const problems: string[] = [];
  const events: TraceEvent[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) problems.push("empty trace");
  lines.forEach((line, i) => {
    const parsed = tryJson(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as TraceEvent).type !== "string") {
      problems.push(`malformed line ${i + 1}`);
      return;
    }
    events.push(parsed as TraceEvent);
  });

  const trace: ParsedTrace = {
    problems,
    lineCount: lines.length,
    init: null,
    calls: [],
    subagent: { messages: 0, types: [], parents: [], models: [], finalText: "", started: false, completed: false },
    result: null,
  };
  const byId = new Map<string, ToolCall>();
  const types = new Set<string>();
  const parents = new Set<string>();
  const models = new Set<string>();
  let inits = 0;
  let results = 0;
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      inits++;
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      trace.init = {
        claudeCodeVersion: str(e.claude_code_version),
        mainModel: str(e.model),
        permissionMode: str(e.permissionMode),
        tools: list(e.tools),
        agents: list(e.agents),
        skills: list(e.skills),
        mcpServers: Array.isArray(e.mcp_servers) ? (e.mcp_servers as { name?: unknown; status?: unknown }[]).map((s) => ({ name: String(s.name), status: String(s.status) })) : [],
      };
    }
    if (e.type === "system" && e.subtype === "task_started" && e.subagent_type === SUBAGENT_TYPE) trace.subagent.started = true;
    if (e.type === "system" && e.subtype === "task_notification" && e.status === "completed") trace.subagent.completed = true;
    const parent = e.parent_tool_use_id ?? null;
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === "assistant" && parent) {
      trace.subagent.messages++;
      if (e.subagent_type) types.add(e.subagent_type);
      parents.add(parent);
      if (e.message?.model) models.add(e.message.model);
    }
    for (const b of content) {
      if (e.type === "assistant" && b.type === "tool_use" && b.id) {
        const call: ToolCall = {
          index: byId.size,
          id: b.id,
          scope: parent ? "subagent" : "main",
          parent,
          subagentType: parent ? (e.subagent_type ?? null) : null,
          name: b.name ?? "?",
          input: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
          result: { status: "missing", text: "", json: null },
        };
        byId.set(b.id, call);
      }
      if (e.type === "assistant" && b.type === "text" && parent && (b.text ?? "").trim() !== "") trace.subagent.finalText = b.text ?? "";
      if (e.type === "user" && b.type === "tool_result" && b.tool_use_id) {
        const call = byId.get(b.tool_use_id);
        if (!call) {
          problems.push(`tool_result without tool_use ${b.tool_use_id}`);
          continue;
        }
        const t = textOf(b.content);
        call.result = { status: b.is_error === true ? "error" : "ok", text: t, json: tryJson(t) };
      }
    }
    if (e.type === "result") {
      results++;
      const usage: NonNullable<ParsedTrace["result"]>["modelUsage"] = {};
      let costBasis: string | null = null;
      if (e.modelUsage && typeof e.modelUsage === "object") {
        for (const [model, u] of Object.entries(e.modelUsage as Record<string, Record<string, unknown>>)) {
          usage[model] = {
            inputTokens: num(u.inputTokens) ?? 0,
            outputTokens: num(u.outputTokens) ?? 0,
            cacheReadInputTokens: num(u.cacheReadInputTokens) ?? 0,
            cacheCreationInputTokens: num(u.cacheCreationInputTokens) ?? 0,
            costUSD: num(u.costUSD) ?? 0,
          };
          costBasis ??= str(u.costBasis);
        }
      }
      trace.result = {
        subtype: str(e.subtype),
        isError: typeof e.is_error === "boolean" ? e.is_error : null,
        durationMs: num(e.duration_ms),
        numTurns: num(e.num_turns),
        costUsd: num(e.total_cost_usd),
        costBasis,
        permissionDenials: Array.isArray(e.permission_denials)
          ? (e.permission_denials as { tool_name?: unknown; tool_input?: unknown }[]).map((d) => ({ toolName: String(d.tool_name), input: d.tool_input ?? null }))
          : [],
        modelUsage: usage,
        text: str(e.result) ?? "",
      };
    }
  }
  if (lines.length > 0 && inits === 0) problems.push("no init event");
  if (inits > 1) problems.push("more than one init event");
  if (lines.length > 0 && results === 0) problems.push("no result event (truncated or killed run)");
  if (results > 1) problems.push("more than one result event");
  trace.calls = [...byId.values()];
  trace.subagent.types = [...types].sort();
  trace.subagent.parents = [...parents].sort();
  trace.subagent.models = [...models].sort();
  return trace;
}

export const isMarketMind = (c: ToolCall) => c.name.startsWith(MARKETMIND_PREFIX);
export const shortName = (name: string) => name.replace(MARKETMIND_PREFIX, "");
