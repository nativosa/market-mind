// Normalizes an agent-sdk execution record (agent-sdk/contract.ts, marketmind.agent.execution/1) into the
// ParsedTrace shape the graders read. The result is labelled source "agent-sdk" and keeps the SDK-only facts
// (configuration, pre-flight, guard decisions, cleanup) separately; it is never turned into stream-json.
// Like parseTrace it never throws: a malformed or incomplete record becomes integrity problems.
import { ExecutionRecord } from "../../agent-sdk/contract.js";
import { statusOfResult } from "../../agent-sdk/session.js";
import type { ParsedTrace, ToolCall } from "./trace.js";

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export function parseExecution(text: string): ParsedTrace {
  const empty: ParsedTrace = {
    source: "agent-sdk",
    investigator: { scope: "main", finalText: "", models: [], completed: false },
    sdk: null,
    problems: [],
    lineCount: 0,
    init: null,
    calls: [],
    subagent: { messages: 0, types: [], parents: [], models: [], finalText: "", started: false, completed: false },
    result: null,
  };
  const raw = text.trim() === "" ? null : tryJson(text);
  if (raw === null) return { ...empty, problems: [text.trim() === "" ? "empty execution record" : "malformed execution record"] };
  const parsed = ExecutionRecord.safeParse(raw);
  if (!parsed.success) return { ...empty, lineCount: 1, problems: ["execution record does not match marketmind.agent.execution/1"] };
  const r = parsed.data;

  const problems = [...r.problems];
  if (r.initCount === 0) problems.push("no init event");
  if (r.initCount > 1) problems.push("more than one init event");
  if (r.resultCount === 0) problems.push("no result event (truncated or killed run)");
  if (r.resultCount > 1) problems.push("more than one result event");

  const calls: ToolCall[] = r.toolCalls.map((c) => ({
    index: c.seq,
    id: c.id,
    scope: c.parentToolUseId === null ? "main" : "subagent",
    parent: c.parentToolUseId,
    subagentType: null,
    name: c.name,
    input: c.input,
    result: { status: c.outcome === "ok" ? "ok" : c.outcome === "missing" ? "missing" : "error", text: c.resultText, json: tryJson(c.resultText) },
    deniedBy: c.deniedBy,
  }));
  const res = r.result;
  // Records written before the api_error status say "completed" for an is_error result; the result decides.
  const [status, statusDetail] = r.status === "completed" && res?.isError === true ? statusOfResult(res.subtype, res.errors, res) : [r.status, r.statusDetail];
  const finalText = status === "api_error" ? "" : res?.subtype === "success" && res.resultText.trim() !== "" ? res.resultText : (r.assistantText[r.assistantText.length - 1] ?? "");
  const mm = new Set(calls.filter((c) => c.name.startsWith("mcp__marketmind__")).map((c) => c.id));
  return {
    source: "agent-sdk",
    investigator: { scope: "main", finalText, models: r.models, completed: res?.subtype === "success" && !res.isError },
    sdk: {
      status,
      statusDetail,
      sdkVersion: r.harness.sdkVersion,
      mainThreadAgent: r.harness.mainThreadAgent,
      agentDefinitionSha256: r.harness.agentDefinitionSha256,
      agentSha256: r.investigator.agentSha256,
      permissionMode: r.harness.permissionMode,
      allowedTools: r.harness.allowedTools,
      builtinTools: r.harness.builtinTools,
      settingSources: r.harness.settingSources,
      strictMcpConfig: r.harness.strictMcpConfig,
      optionsDigest: r.harness.optionsDigest,
      preflightPassed: r.preflight?.passed ?? null,
      effectiveSessionPassed: r.effectiveSession?.passed ?? null,
      agentsAvailable: r.preflight?.agentsAvailable ?? [],
      guardAgentTypes: [...new Set(r.guard.filter((d) => d.toolUseId !== null && mm.has(d.toolUseId)).map((d) => d.agentType ?? "<none>"))].sort(),
      guardDenials: r.guard.filter((d) => d.decision === "deny").length,
      canUseToolCalls: r.canUseToolCalls.length,
      nestedAgentMessages: r.nestedAgentMessages,
      cleanupProblems: r.cleanup.problems,
    },
    problems,
    lineCount: r.messageCount,
    init: r.init
      ? { claudeCodeVersion: r.init.claudeCodeVersion, mainModel: r.init.model, permissionMode: r.init.permissionMode, tools: r.init.tools, agents: r.init.agents, skills: r.init.skills, mcpServers: r.init.mcpServers }
      : null,
    calls,
    // No subagent exists in this harness; the investigator is the main thread.
    subagent: { messages: r.nestedAgentMessages, types: [], parents: [], models: [], finalText: "", started: false, completed: false },
    result: res
      ? {
          subtype: res.subtype,
          isError: res.isError,
          durationMs: res.durationMs,
          numTurns: res.numTurns,
          costUsd: res.totalCostUsd,
          costBasis: Object.values(res.modelUsage)[0]?.costBasis ?? null,
          permissionDenials: res.permissionDenials.map((d) => ({ toolName: d.toolName, input: null })),
          modelUsage: Object.fromEntries(Object.entries(res.modelUsage).map(([m, u]) => [m, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadInputTokens: u.cacheReadInputTokens, cacheCreationInputTokens: u.cacheCreationInputTokens, costUSD: u.costUSD }])),
          text: res.resultText,
        }
      : null,
  };
}
