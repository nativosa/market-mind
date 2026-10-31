// An offline stand-in for the Claude Agent SDK query(): no binary, no network, no model. It behaves like the
// documented control flow closely enough to exercise the application's state machine:
//   - query() returns at once; initializationResult()/mcpServerStatus() answer control requests;
//   - the stream waits for the gated prompt before emitting anything (as the CLI waits for input);
//   - each scripted tool call runs the application's PreToolUse hook first (a deny becomes an error
//     tool_result, as the CLI reports it), then PostToolUse;
//   - abort/close end the stream; an optional fake child process stands in for the CLI subprocess.
// What it cannot show is the real runtime's behaviour; those assumptions are listed in agent-sdk/README.md.
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChildHandle, QueryFn, QueryHandle } from "../agent-sdk/session.js";
import { MARKETMIND_TOOLS } from "../agent-sdk/guard.js";

export const FAKE_CLI_VERSION = "2.1.302";
export const FAKE_MODEL = "claude-sonnet-5-5";

export interface FakeCall {
  name: string;
  args: Record<string, unknown>;
  /** Result text and error flag; default: `{"ok":true}`. */
  result?: { isError: boolean; text: string } | ((name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>);
  /** Emit this call from a nested agent (non-null parent_tool_use_id). */
  nested?: boolean;
}

export interface FakeScript {
  apiKeySource?: string;
  apiProvider?: string;
  agents?: string[];
  mcp?: { name: string; status: string; tools?: string[] }[];
  /** Overrides of the system/init message. */
  init?: Partial<{ tools: string[]; permissionMode: string; apiKeySource: string; skills: string[]; plugins: { name: string; path: string }[]; slashCommands: string[] }>;
  calls?: FakeCall[];
  report?: string;
  /** Result message subtype; null = no result (truncated stream). */
  subtype?: "success" | "error_max_turns" | "error_max_budget_usd" | "error_during_execution" | null;
  /** Never finish (until aborted). */
  hang?: boolean;
  /** Wait this long after the tool calls, before the report. */
  pauseMs?: number;
  /** Throw from query() itself (the SDK rejecting options). */
  throwOnCreate?: string;
  /** Throw from the stream after N messages. */
  crashAfter?: number;
  /** Emit an assistant message with error authentication_failed before the result. */
  authFailure?: boolean;
  /** End the session the way a failed API request does; the text is the CLI's error message. */
  apiError?: string;
  /** Call options.spawnClaudeCodeProcess, as the real SDK does. */
  spawn?: boolean;
  /** Command the fake asks the application to spawn (default: a placeholder "claude"). */
  spawnCommand?: { command: string; args: string[] };
  cost?: number;
  hookAgentType?: string | null;
  /** Whether the "runtime" starts the MCP launcher (default true): a launcher report line is written. */
  launcher?: false | { anthropicKeyReceived: boolean; serverEnvKeys?: string[] };
}

export interface FakeState {
  options: Options | null;
  promptReceived: string | null;
  closed: number;
  interrupted: number;
  preflightBeforePrompt: boolean;
  hookCalls: string[];
}

const assistant = (content: unknown[], parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, uuid: "u", session_id: "s", message: { model: FAKE_MODEL, content } }) as unknown as SDKMessage;
const toolResult = (id: string, r: { isError: boolean; text: string }, parent: string | null = null) =>
  ({ type: "user", parent_tool_use_id: parent, session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: r.isError, content: r.text }] } }) as unknown as SDKMessage;

async function runHooks(o: Options, event: "PreToolUse" | "PostToolUse", input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const m of o.hooks?.[event] ?? []) for (const h of m.hooks) out.push((await (h)(input as never, input.tool_use_id as string, { signal: new AbortController().signal })));
  return out;
}

export function fakeQuery(script: FakeScript, state: FakeState = newState()): { query: QueryFn; state: FakeState } {
  const query: QueryFn = ({ prompt, options }) => {
    if (script.throwOnCreate) throw new Error(script.throwOnCreate);
    state.options = options;
    const signal = options.abortController!.signal;
    let preflightAsked = false;
    if (script.spawn) options.spawnClaudeCodeProcess!({ command: script.spawnCommand?.command ?? "claude", args: script.spawnCommand?.args ?? [], cwd: options.cwd!, env: options.env!, signal });
    const aborted = () => signal.aborted || state.closed > 0;
    const permissionDenials: { tool_name: string; tool_use_id: string; tool_input: unknown }[] = [];
    const mcpEnv = (options.mcpServers?.marketmind as { env?: Record<string, string> } | undefined)?.env ?? {};
    if (script.launcher !== false && mcpEnv.MARKETMIND_LAUNCH_REPORT) {
      const l = script.launcher ?? { anthropicKeyReceived: true };
      appendFileSync(
        mcpEnv.MARKETMIND_LAUNCH_REPORT,
        JSON.stringify({ contract: "marketmind.mcp-launcher/1", launcherPid: 1001, serverPid: 1002, receivedEnvKeys: ["ANTHROPIC_API_KEY", "MARKETMIND_DB", "PATH"], serverEnvKeys: l.serverEnvKeys ?? ["MARKETMIND_DB", "PATH"], anthropicKeyReceived: l.anthropicKeyReceived, credentialKeysReceived: l.anthropicKeyReceived ? ["ANTHROPIC_API_KEY"] : [] }) + "\n",
      );
    }
    const until = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    async function* stream(): AsyncGenerator<SDKMessage> {
      const it = prompt[Symbol.asyncIterator]();
      const first = await Promise.race([it.next(), new Promise<IteratorResult<SDKUserMessage>>((r) => signal.addEventListener("abort", () => r({ done: true, value: undefined })))]);
      if (first.done || aborted()) return;
      state.preflightBeforePrompt = preflightAsked;
      state.promptReceived = String((first.value.message as { content: unknown }).content);
      let n = 0;
      const emit = (m: SDKMessage) => {
        if (script.crashAfter !== undefined && n >= script.crashAfter) throw new Error("CLI process exited unexpectedly");
        n++;
        return m;
      };
      yield emit({
        type: "system",
        subtype: "init",
        apiKeySource: script.init?.apiKeySource ?? script.apiKeySource ?? "ANTHROPIC_API_KEY",
        claude_code_version: FAKE_CLI_VERSION,
        cwd: options.cwd,
        tools: script.init?.tools ?? [...MARKETMIND_TOOLS],
        mcp_servers: [{ name: "marketmind", status: "connected" }],
        model: FAKE_MODEL,
        permissionMode: script.init?.permissionMode ?? options.permissionMode,
        slash_commands: script.init?.slashCommands ?? [],
        output_style: "default",
        skills: script.init?.skills ?? [],
        plugins: script.init?.plugins ?? [],
        agents: Object.keys(options.agents ?? {}),
        uuid: "u",
        session_id: "s",
      } as unknown as SDKMessage);
      let k = 0;
      for (const c of script.calls ?? []) {
        if (aborted()) return;
        const id = `toolu_${++k}`;
        const parent = c.nested ? "toolu_agent" : null;
        yield emit(assistant([{ type: "tool_use", id, name: c.name, input: c.args }], parent));
        const base = { session_id: "s", transcript_path: "", cwd: options.cwd, tool_name: c.name, tool_input: c.args, tool_use_id: id, ...(c.nested ? { agent_id: "a1", agent_type: "general-purpose" } : script.hookAgentType === null ? {} : { agent_type: script.hookAgentType ?? options.agent }) };
        state.hookCalls.push(c.name);
        const pre = await runHooks(options, "PreToolUse", { ...base, hook_event_name: "PreToolUse" });
        const decisions = pre.map((h) => (h.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined));
        const denial = decisions.find((h) => h?.permissionDecision === "deny");
        let r: { isError: boolean; text: string };
        // Measured with the real CLI 2.1.302: hooks run first and a hook "allow" overrides dontAsk. Without one,
        // a tool that has no allow rule is denied under dontAsk.
        const hookAllowed = decisions.some((h) => h?.permissionDecision === "allow");
        const notAllowed = !c.nested && !hookAllowed && options.permissionMode === "dontAsk" && !(options.allowedTools ?? []).includes(c.name);
        if (denial) r = { isError: true, text: denial.permissionDecisionReason ?? "denied" };
        else if (notAllowed) {
          permissionDenials.push({ tool_name: c.name, tool_use_id: id, tool_input: c.args });
          yield emit({ type: "system", subtype: "permission_denied", tool_name: c.name, tool_use_id: id, decision_reason_type: "mode", uuid: "u", session_id: "s" } as unknown as SDKMessage);
          r = { isError: true, text: `Permission to use ${c.name} has been denied because Claude Code is running in don't ask mode.` };
        } else {
          r = typeof c.result === "function" ? await c.result(c.name, c.args) : (c.result ?? { isError: false, text: '{"ok":true}' });
          await runHooks(options, "PostToolUse", { ...base, hook_event_name: "PostToolUse", tool_response: [{ type: "text", text: r.text }] });
        }
        yield emit(toolResult(id, r, parent));
      }
      if (script.pauseMs) await until(script.pauseMs);
      if (script.hang) {
        while (!aborted()) await until(5);
        return;
      }
      if (script.authFailure) yield emit({ ...(assistant([{ type: "text", text: "Invalid API key" }]) as object), error: "authentication_failed" } as unknown as SDKMessage);
      if (script.apiError) {
        // The shape recorded from the real CLI 2.1.302: a synthetic assistant message, then "success" with is_error.
        yield emit({ type: "assistant", parent_tool_use_id: null, uuid: "u", session_id: "s", error: "unknown", is_api_error_message: true, api_error_status: 400, message: { model: "<synthetic>", content: [{ type: "text", text: script.apiError }] } } as unknown as SDKMessage);
        yield emit({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 400, duration_ms: 104, duration_api_ms: 0, num_turns: 1, stop_reason: "stop_sequence", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], result: script.apiError, uuid: "u", session_id: "s" } as unknown as SDKMessage);
        return;
      }
      if (script.report !== undefined) yield emit(assistant([{ type: "text", text: script.report }]));
      if (script.subtype === null) return;
      const subtype = script.subtype ?? "success";
      yield emit({
        type: "result",
        subtype,
        is_error: subtype !== "success",
        duration_ms: 1234,
        duration_api_ms: 1000,
        num_turns: 3,
        stop_reason: null,
        total_cost_usd: script.cost ?? 0.0123,
        usage: {},
        modelUsage: { [FAKE_MODEL]: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: script.cost ?? 0.0123, costBasis: "list" } },
        permission_denials: permissionDenials,
        ...(subtype === "success" ? { result: script.report ?? "" } : { errors: [subtype] }),
        uuid: "u",
        session_id: "s",
      } as unknown as SDKMessage);
    }
    const gen = stream();
    const handle: QueryHandle = {
      [Symbol.asyncIterator]: () => gen,
      initializationResult: () => {
        preflightAsked = true;
        return Promise.resolve({
          commands: [],
          agents: (script.agents ?? Object.keys(options.agents ?? {})).map((name) => ({ name, description: "" })),
          output_style: "default",
          available_output_styles: [],
          models: [],
          account: { apiKeySource: script.apiKeySource ?? "ANTHROPIC_API_KEY", ...(script.apiProvider ? { apiProvider: script.apiProvider } : {}) },
        } as never);
      },
      mcpServerStatus: () =>
        Promise.resolve(
          (script.mcp ?? [{ name: "marketmind", status: "connected", tools: MARKETMIND_TOOLS.map((t) => t.replace("mcp__marketmind__", "")) }]).map((s) => ({ name: s.name, status: s.status, source: "dynamic", tools: (s.tools ?? []).map((name) => ({ name })) })) as never,
        ),
      interrupt: () => {
        state.interrupted++;
        return Promise.resolve(undefined);
      },
      close: () => {
        state.closed++;
        void gen.return(undefined);
      },
    };
    return handle;
  };
  return { query, state };
}

export const newState = (): FakeState => ({ options: null, promptReceived: null, closed: 0, interrupted: 0, preflightBeforePrompt: false, hookCalls: [] });

/** A fake CLI child process: exits on close() unless stubborn; records kills. */
export class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly pid = 424242;
  constructor(readonly stubborn = false) {
    super();
  }
  kill(): boolean {
    this.killed = true;
    this.exit(null, "SIGKILL");
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}
export const asChild = (c: FakeChild) => c as unknown as ChildHandle;
