// In-process permission guard. PreToolUse hooks run first in the SDK's permission order and a hook deny
// wins over every allow rule and mode, so this is where MarketMind's own limits are enforced. The guard only
// narrows: a call within policy gets no decision, because a hook "allow" overrides dontAsk and would run a
// tool that has no allow rule (measured with the real CLI 2.1.302). Authorization stays with allowedTools.
//   - only the five MarketMind tools, from the configured "marketmind" server, on the main thread;
//   - includeSynthetic only when the task authorizes it;
//   - no identical repeat of a successful (or still pending) call; one retry of a failed, retryable call;
//   - an overall call budget (7 in Mode A, 8 in Mode B, as in the investigator policy).
// canUseTool is a canary: under dontAsk it should never be reached, and it always denies.
import type { CanUseTool, HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { GuardDecision } from "./contract.js";

export const MCP_SERVER = "marketmind";
export const MARKETMIND_TOOLS = ["scan_markets", "inspect_market", "list_collection_runs", "get_market_history", "get_observation_details"].map((t) => `mcp__${MCP_SERVER}__${t}`);
export const CALL_BUDGET = { A: 7, B: 8 } as const;

export interface GuardConfig {
  mode: "A" | "B";
  syntheticAuthorized: boolean;
  agentName: string;
}

interface Admitted {
  key: string;
  toolUseId: string;
  outcome: "pending" | "ok" | "error";
  retryable: boolean | null;
  retry: boolean;
}

/** Canonical JSON (sorted keys) so argument order does not make a repeat look new. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Classify an MCP tool response: MarketMind failures carry a marketmind.error/1 body. */
export function classifyResponse(response: unknown): { outcome: "ok" | "error"; category: string | null; retryable: boolean | null } {
  const texts: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === "string") texts.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.contract === "marketmind.error/1") texts.push(JSON.stringify(o));
      else if (typeof o.text === "string") texts.push(o.text);
      else if (o.content !== undefined) collect(o.content);
      else if (o.structuredContent !== undefined) collect(JSON.stringify(o.structuredContent));
    }
  };
  collect(response);
  for (const t of texts) {
    try {
      const j = JSON.parse(t) as { contract?: unknown; error?: { category?: unknown; retryable?: unknown } };
      if (j.contract === "marketmind.error/1") {
        return { outcome: "error", category: typeof j.error?.category === "string" ? j.error.category : null, retryable: typeof j.error?.retryable === "boolean" ? j.error.retryable : null };
      }
    } catch {
      /* not JSON */
    }
  }
  return { outcome: "ok", category: null, retryable: null };
}

export interface Guard {
  preToolUse: HookCallback;
  postToolUse: HookCallback;
  postToolUseFailure: HookCallback;
  /** The permission layer refused a call that passed the guard (system/permission_denied; no hook fires under dontAsk). */
  permissionDenied(toolUseId: string): void;
  canUseTool: CanUseTool;
  decisions: GuardDecision[];
  canUseToolCalls: string[];
  /** Hook-observed outcome per tool_use id (cross-checked against the message stream). */
  outcomes: Map<string, { outcome: "ok" | "error"; category: string | null; retryable: boolean | null; agentType: string | null }>;
}

const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `MarketMind guard: ${reason}` } });
/** No opinion: the call continues to the allow rules and permission mode. Never a hook "allow". */
const NO_DECISION: HookJSONOutput = {};

export function createGuard(config: GuardConfig): Guard {
  const decisions: GuardDecision[] = [];
  const canUseToolCalls: string[] = [];
  const admitted: Admitted[] = [];
  const outcomes: Guard["outcomes"] = new Map();
  const record = (toolUseId: string | null, name: string, decision: "allow" | "deny", reason: string, agentType: string | null) => decisions.push({ toolUseId, name, decision, reason, agentType });

  const preToolUse: HookCallback = (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
    const name = input.tool_name;
    const id = input.tool_use_id ?? toolUseID ?? null;
    const args = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    const agentType = input.agent_type ?? null;
    const refuse = (reason: string) => {
      record(id, name, "deny", reason, agentType);
      return Promise.resolve(deny(reason));
    };
    if (!MARKETMIND_TOOLS.includes(name)) return refuse(`${name} is not one of the five MarketMind tools`);
    if (input.mcp_server && input.mcp_server.name !== MCP_SERVER) return refuse(`tool served by unexpected MCP server ${JSON.stringify(input.mcp_server.name)}`);
    if (input.agent_id !== undefined) return refuse("tool calls from nested agents are not allowed");
    if (input.agent_type !== undefined && input.agent_type !== config.agentName) return refuse(`unexpected agent ${JSON.stringify(input.agent_type)}`);
    if (args.includeSynthetic === true && !config.syntheticAuthorized) return refuse("includeSynthetic requires an authorized synthetic scenario");
    const key = `${name} ${canonical(args)}`;
    const earlier = admitted.filter((a) => a.key === key);
    let retry = false;
    if (earlier.length > 0) {
      const last = earlier[earlier.length - 1]!;
      if (last.outcome === "pending") return refuse("an identical call is still pending");
      if (last.outcome === "ok") return refuse("repeats an identical successful call");
      if (last.retryable !== true) return refuse("repeats an identical call that failed with a non-retryable error");
      if (earlier.some((a) => a.retry)) return refuse("the one permitted retry of this call was already used");
      retry = true;
    }
    if (admitted.length >= CALL_BUDGET[config.mode]) return refuse(`call budget of ${CALL_BUDGET[config.mode]} MarketMind calls reached`);
    admitted.push({ key, toolUseId: id ?? `#${admitted.length}`, outcome: "pending", retryable: null, retry });
    record(id, name, "allow", retry ? "retry of a failed, retryable call" : "within policy", agentType);
    return Promise.resolve(NO_DECISION);
  };

  const settle = (id: string, outcome: "ok" | "error", category: string | null, retryable: boolean | null, agentType: string | null) => {
    outcomes.set(id, { outcome, category, retryable, agentType });
    const a = admitted.find((x) => x.toolUseId === id);
    if (a) {
      a.outcome = outcome;
      a.retryable = retryable;
    }
  };
  const postToolUse: HookCallback = (input) => {
    if (input.hook_event_name === "PostToolUse") {
      const c = classifyResponse(input.tool_response);
      settle(input.tool_use_id, c.outcome, c.category, c.retryable, input.agent_type ?? null);
    }
    return Promise.resolve({});
  };
  const postToolUseFailure: HookCallback = (input) => {
    if (input.hook_event_name === "PostToolUseFailure") {
      const c = classifyResponse(input.error);
      settle(input.tool_use_id, "error", c.category, c.outcome === "error" ? c.retryable : null, input.agent_type ?? null);
    }
    return Promise.resolve({});
  };
  // A refused call never ran, so it is neither pending nor spent; a repeat goes back to the permission layer.
  const permissionDenied = (toolUseId: string) => {
    const i = admitted.findIndex((a) => a.toolUseId === toolUseId);
    if (i >= 0) admitted.splice(i, 1);
  };
  const canUseTool: CanUseTool = (toolName) => {
    canUseToolCalls.push(toolName);
    return Promise.resolve({ behavior: "deny", message: "MarketMind: no interactive approval surface; only pre-approved MarketMind tools may run." });
  };
  return { preToolUse, postToolUse, postToolUseFailure, permissionDenied, canUseTool, decisions, canUseToolCalls, outcomes };
}
