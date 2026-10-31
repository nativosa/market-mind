// SDK message stream → normalized execution state and human-readable progress. Pure: it only reads
// messages, so it is exercised offline with synthetic SDK messages. Tool calls come from the message
// stream (tool_use / tool_result blocks); guard hook observations are cross-checked against them.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { InitSnapshot, ResultSnapshot, ToolCallRecord } from "./contract.js";
import { classifyResponse, type Guard } from "./guard.js";

export type Progress =
  | { kind: "init"; text: string }
  | { kind: "tool_use"; text: string }
  | { kind: "tool_result"; text: string }
  | { kind: "text"; text: string }
  | { kind: "result"; text: string }
  | { kind: "warning"; text: string };

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? (content as Block[]).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n") : "";
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "name" in x ? String((x as { name: unknown }).name) : String(x))) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Short, single-line argument summary for progress output (market text never appears in arguments). */
const brief = (input: unknown) => {
  const s = JSON.stringify(input ?? {});
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
};

export class Recorder {
  init: InitSnapshot | null = null;
  initCount = 0;
  result: ResultSnapshot | null = null;
  resultCount = 0;
  messageCount = 0;
  nestedAgentMessages = 0;
  readonly calls = new Map<string, ToolCallRecord>();
  readonly assistantText: string[] = [];
  readonly models = new Set<string>();
  readonly problems: string[] = [];

  push(m: SDKMessage): Progress[] {
    this.messageCount++;
    const out: Progress[] = [];
    if (m.type === "system" && m.subtype === "init") {
      this.initCount++;
      this.init = {
        claudeCodeVersion: m.claude_code_version ?? null,
        model: m.model ?? null,
        permissionMode: m.permissionMode ?? null,
        apiKeySource: m.apiKeySource ?? null,
        tools: strs(m.tools),
        agents: strs(m.agents),
        skills: strs(m.skills),
        plugins: strs(m.plugins),
        mcpServers: (m.mcp_servers ?? []).map((s) => ({ name: String(s.name), status: String(s.status) })),
      };
      out.push({ kind: "init", text: `session started: Claude Code ${this.init.claudeCodeVersion ?? "?"}, model ${this.init.model ?? "?"}, ${this.init.tools.length} tools, permission mode ${this.init.permissionMode ?? "?"}` });
      return out;
    }
    if (m.type === "assistant") {
      const parent = m.parent_tool_use_id ?? null;
      if (parent !== null) this.nestedAgentMessages++;
      const model = (m.message as { model?: unknown }).model;
      if (typeof model === "string" && parent === null) this.models.add(model);
      for (const b of (Array.isArray(m.message.content) ? m.message.content : []) as Block[]) {
        if (b.type === "tool_use" && b.id) {
          const rec: ToolCallRecord = {
            seq: this.calls.size,
            id: b.id,
            name: b.name ?? "?",
            input: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
            parentToolUseId: parent,
            outcome: "missing",
            errorCategory: null,
            retryable: null,
            resultText: "",
            deniedBy: null,
          };
          this.calls.set(b.id, rec);
          out.push({ kind: "tool_use", text: `→ ${rec.name.replace(/^mcp__marketmind__/, "")} ${brief(rec.input)}` });
        }
        if (b.type === "text" && parent === null && (b.text ?? "").trim() !== "") this.assistantText.push(b.text ?? "");
      }
      return out;
    }
    if (m.type === "user") {
      const content = (m.message as { content?: unknown }).content;
      for (const b of (Array.isArray(content) ? content : []) as Block[]) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const rec = this.calls.get(b.tool_use_id);
        if (!rec) {
          this.problems.push(`tool_result without tool_use ${b.tool_use_id}`);
          continue;
        }
        rec.resultText = textOf(b.content);
        if (b.is_error === true) {
          const c = classifyResponse(rec.resultText);
          rec.outcome = "error";
          rec.errorCategory = c.category;
          rec.retryable = c.retryable;
        } else rec.outcome = "ok";
        out.push({ kind: "tool_result", text: `← ${rec.name.replace(/^mcp__marketmind__/, "")} ${rec.outcome}${rec.errorCategory ? ` (${rec.errorCategory})` : ""}` });
      }
      return out;
    }
    if (m.type === "result") {
      this.resultCount++;
      const usage: ResultSnapshot["modelUsage"] = {};
      for (const [model, u] of Object.entries((m.modelUsage ?? {}) as Record<string, Record<string, unknown>>)) {
        usage[model] = {
          inputTokens: num(u.inputTokens) ?? 0,
          outputTokens: num(u.outputTokens) ?? 0,
          cacheReadInputTokens: num(u.cacheReadInputTokens) ?? 0,
          cacheCreationInputTokens: num(u.cacheCreationInputTokens) ?? 0,
          costUSD: num(u.costUSD) ?? 0,
          costBasis: typeof u.costBasis === "string" ? u.costBasis : null,
        };
      }
      this.result = {
        subtype: m.subtype,
        isError: m.is_error,
        terminalReason: typeof m.terminal_reason === "string" ? m.terminal_reason : null,
        durationMs: num(m.duration_ms),
        numTurns: num(m.num_turns),
        totalCostUsd: num(m.total_cost_usd),
        modelUsage: usage,
        permissionDenials: (m.permission_denials ?? []).map((d) => ({ toolName: String(d.tool_name), toolUseId: typeof d.tool_use_id === "string" ? d.tool_use_id : null })),
        errors: m.subtype === "success" ? [] : (m.errors ?? []).map(String),
        resultText: m.subtype === "success" ? (m.result ?? "") : "",
      };
      // is_error can accompany subtype "success" (an API failure), so the subtype alone is not the outcome.
      const outcome = this.result.isError ? `FAILED: ${this.result.terminalReason ?? m.subtype}` : m.subtype;
      out.push({ kind: "result", text: `finished: ${outcome}, ${this.result.numTurns ?? "?"} turns, ~$${(this.result.totalCostUsd ?? 0).toFixed(4)} estimated` });
    }
    return out;
  }

  /** Apply guard and permission evidence: denied calls, and hook/message disagreements as problems. */
  reconcile(guard: Guard): void {
    const deniedByGuard = new Set(guard.decisions.filter((d) => d.decision === "deny" && d.toolUseId).map((d) => d.toolUseId!));
    const deniedByPermission = new Set((this.result?.permissionDenials ?? []).map((d) => d.toolUseId).filter((x): x is string => x !== null));
    for (const rec of this.calls.values()) {
      if (deniedByGuard.has(rec.id)) {
        rec.outcome = "denied";
        rec.deniedBy = "guard";
      } else if (deniedByPermission.has(rec.id)) {
        rec.outcome = "denied";
        rec.deniedBy = "permission";
      }
      const hook = guard.outcomes.get(rec.id);
      if (hook && rec.outcome !== "denied" && hook.outcome !== rec.outcome) this.problems.push(`hook and message stream disagree on ${rec.id}: hook ${hook.outcome}, stream ${rec.outcome}`);
      if (!hook && (rec.outcome === "ok" || rec.outcome === "error") && rec.name.startsWith("mcp__marketmind__")) this.problems.push(`no PostToolUse observation for executed call ${rec.id}`);
    }
    for (const id of guard.outcomes.keys()) if (!this.calls.has(id)) this.problems.push(`hook observed call ${id} absent from the message stream`);
  }

  /** The investigator's report: the final main-thread text (the success result text when present). An API failure has none. */
  reportText(): string {
    if (this.result?.isError && this.result.terminalReason === "api_error") return "";
    if (this.result?.subtype === "success" && this.result.resultText.trim() !== "") return this.result.resultText;
    return this.assistantText[this.assistantText.length - 1] ?? "";
  }
}
