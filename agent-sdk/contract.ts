// Versioned contracts of the SDK investigation application. The investigation result is what the CLI
// prints with --json; the execution record is the normalized, provenance-tagged view of the SDK message
// stream that the evaluation framework grades. Neither pretends to be a Claude Code stream-json trace.
import { z } from "zod";

export const INVESTIGATION_CONTRACT = "marketmind.agent.investigation/1";
export const EXECUTION_CONTRACT = "marketmind.agent.execution/1";
export const EXECUTION_SOURCE = "agent-sdk" as const;

const sha = z.string().regex(/^[0-9a-f]{64}$/);

export const InvestigationRequest = z
  .object({
    mode: z.enum(["A", "B"]),
    marketId: z.string().regex(/^\d{1,20}$/).nullable(),
    version: z.enum(["v1", "v2"]).nullable(),
    objective: z.string().nullable(),
    /** The exact $ARGUMENTS string given to the skill body. */
    arguments: z.string(),
    server: z.enum(["live", "fixture"]),
    fixtureScenario: z.string().nullable(),
    syntheticAuthorized: z.boolean(),
    /** "none" only for the evaluation permission probe (P01): no allow rules, so dontAsk must deny. */
    allowRules: z.enum(["marketmind", "none"]),
  })
  .strict();
export type InvestigationRequest = z.infer<typeof InvestigationRequest>;

export const SessionStatus = z.enum([
  "completed",
  /** The API refused the request or failed mid-run; the run has no usable model output. */
  "api_error",
  "timeout",
  "cancelled",
  "budget_stopped",
  "max_turns",
  "preflight_failed",
  "auth_source_rejected",
  "auth_failed",
  "missing_credentials",
  "invalid_options",
  "mcp_failed",
  "truncated",
  "error",
  "cleanup_failed",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ToolOutcome = z.enum(["ok", "error", "denied", "missing"]);

export const ToolCallRecord = z
  .object({
    seq: z.number().int(),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    /** Main thread (null) or the tool_use id of a nested agent call. */
    parentToolUseId: z.string().nullable(),
    outcome: ToolOutcome,
    errorCategory: z.string().nullable(),
    retryable: z.boolean().nullable(),
    /** Raw tool_result text (JSON for MarketMind tools); kept for grading. */
    resultText: z.string(),
    /** Which layer denied it, when denied. */
    deniedBy: z.enum(["guard", "permission", "canUseTool"]).nullable(),
  })
  .strict();
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const GuardDecision = z
  .object({
    toolUseId: z.string().nullable(),
    name: z.string(),
    /** "allow" means the call passed the guard, not that it was authorized: the permission layer still decides. */
    decision: z.enum(["allow", "deny"]),
    reason: z.string(),
    /** agent_type from the hook input (the --agent name on the main thread; absent before Claude Code reports it). */
    agentType: z.string().nullable(),
  })
  .strict();
export type GuardDecision = z.infer<typeof GuardDecision>;

/**
 * First validation phase: the pre-prompt gate (initialize response and MCP status), before the prompt is
 * released. `passed: true` covers this phase only; see EffectiveSession for the next one.
 */
export const Preflight = z
  .object({
    apiKeySource: z.string().nullable(),
    apiProvider: z.string().nullable(),
    agentsAvailable: z.array(z.string()),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string(), source: z.string().nullable(), tools: z.array(z.string()) }).strict()),
    problems: z.array(z.string()),
    passed: z.boolean(),
  })
  .strict();
export type Preflight = z.infer<typeof Preflight>;

/**
 * Second validation phase: the first system/init after the prompt is released (effective tool pool, skills,
 * plugins, auth source, mode). A failure here is also status preflight_failed, with preflight.passed true.
 */
export const EffectiveSession = z
  .object({
    problems: z.array(z.string()),
    passed: z.boolean(),
  })
  .strict();
export type EffectiveSession = z.infer<typeof EffectiveSession>;

export const InitSnapshot = z
  .object({
    claudeCodeVersion: z.string().nullable(),
    model: z.string().nullable(),
    permissionMode: z.string().nullable(),
    apiKeySource: z.string().nullable(),
    tools: z.array(z.string()),
    agents: z.array(z.string()),
    skills: z.array(z.string()),
    plugins: z.array(z.string()),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() }).strict()),
  })
  .strict();
export type InitSnapshot = z.infer<typeof InitSnapshot>;

export const ResultSnapshot = z
  .object({
    subtype: z.string(),
    isError: z.boolean(),
    terminalReason: z.string().nullable(),
    durationMs: z.number().nullable(),
    numTurns: z.number().nullable(),
    totalCostUsd: z.number().nullable(),
    modelUsage: z.record(
      z.string(),
      z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadInputTokens: z.number(), cacheCreationInputTokens: z.number(), costUSD: z.number(), costBasis: z.string().nullable() }).strict(),
    ),
    permissionDenials: z.array(z.object({ toolName: z.string(), toolUseId: z.string().nullable() }).strict()),
    errors: z.array(z.string()),
    resultText: z.string(),
  })
  .strict();
export type ResultSnapshot = z.infer<typeof ResultSnapshot>;

export const Harness = z
  .object({
    mode: z.literal(EXECUTION_SOURCE),
    sdkPackage: z.literal("@anthropic-ai/claude-agent-sdk"),
    sdkVersion: z.string(),
    mainThreadAgent: z.string(),
    agentDefinitionSha256: sha,
    permissionMode: z.string(),
    allowedTools: z.array(z.string()),
    builtinTools: z.array(z.string()),
    disallowedTools: z.array(z.string()),
    settingSources: z.array(z.string()),
    strictMcpConfig: z.boolean(),
    maxTurns: z.number().int().nullable(),
    maxBudgetUsd: z.number().nullable(),
    timeoutMs: z.number().int(),
    optionsDigest: sha,
    /** SHA-256 of agent-sdk/guard.ts: the digest above records only that a guard is installed. Null in older records. */
    guardSha256: sha.nullable().default(null),
  })
  .strict();
export type Harness = z.infer<typeof Harness>;

export const Cleanup = z
  .object({
    closeCalled: z.boolean(),
    childExited: z.boolean().nullable(),
    forcedKill: z.boolean(),
    orphansFound: z.number().int(),
    orphansKilled: z.number().int(),
    tempRemoved: z.boolean(),
    problems: z.array(z.string()),
  })
  .strict();
export type Cleanup = z.infer<typeof Cleanup>;

/** One start of the MCP launcher, as it reported itself: variable names only, never values. */
export const LauncherReport = z
  .object({
    contract: z.literal("marketmind.mcp-launcher/1"),
    launcherPid: z.number().int(),
    serverPid: z.number().int().nullable(),
    receivedEnvKeys: z.array(z.string()),
    serverEnvKeys: z.array(z.string()),
    anthropicKeyReceived: z.boolean(),
    credentialKeysReceived: z.array(z.string()),
  })
  .strict();
export type LauncherReport = z.infer<typeof LauncherReport>;

/** Normalized SDK execution: every event keeps its source; graded by test-agent/eval. */
export const ExecutionRecord = z
  .object({
    contract: z.literal(EXECUTION_CONTRACT),
    source: z.literal(EXECUTION_SOURCE),
    harness: Harness,
    investigator: z.object({ agentSha256: sha, skillSha256: sha, settingsSha256: sha, promptSha256: sha }).strict(),
    status: SessionStatus,
    statusDetail: z.string(),
    preflight: Preflight.nullable(),
    /** Null when that phase was not reached (the pre-prompt gate failed, or no init arrived). */
    effectiveSession: EffectiveSession.nullable().default(null),
    init: InitSnapshot.nullable(),
    initCount: z.number().int(),
    toolCalls: z.array(ToolCallRecord),
    guard: z.array(GuardDecision),
    canUseToolCalls: z.array(z.string()),
    /** Main-thread assistant text blocks, in order; the last non-empty one is the report. */
    assistantText: z.array(z.string()),
    models: z.array(z.string()),
    nestedAgentMessages: z.number().int(),
    result: ResultSnapshot.nullable(),
    resultCount: z.number().int(),
    messageCount: z.number().int(),
    problems: z.array(z.string()),
    /** Launcher self-reports read before the temp directory is removed (runtime evidence that it ran). */
    mcpLauncher: z.array(LauncherReport),
    cleanup: Cleanup,
  })
  .strict();
export type ExecutionRecord = z.infer<typeof ExecutionRecord>;

export const InvestigationResult = z
  .object({
    contract: z.literal(INVESTIGATION_CONTRACT),
    request: InvestigationRequest,
    status: SessionStatus,
    statusDetail: z.string(),
    harness: Harness,
    investigator: ExecutionRecord.shape.investigator,
    toolCalls: z.array(
      z.object({ seq: z.number().int(), name: z.string(), input: z.record(z.string(), z.unknown()), outcome: ToolOutcome, errorCategory: z.string().nullable(), deniedBy: ToolCallRecord.shape.deniedBy }).strict(),
    ),
    denials: z.array(GuardDecision),
    report: z
      .object({ markdown: z.string(), classification: z.array(z.string()), sectionsPresent: z.array(z.number().int()) })
      .strict(),
    usage: z
      .object({ estimatedCostUsd: z.number().nullable(), costBasis: z.string().nullable(), durationMs: z.number().nullable(), numTurns: z.number().nullable(), models: z.array(z.string()) })
      .strict(),
    integrity: z.object({ database: z.enum(["unchanged", "changed", "absent", "unknown"]), repository: z.enum(["unchanged", "changed", "unknown"]) }).strict(),
    cleanup: Cleanup,
    warnings: z.array(z.string()),
  })
  .strict();
export type InvestigationResult = z.infer<typeof InvestigationResult>;
