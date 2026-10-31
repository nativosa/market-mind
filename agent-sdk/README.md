# MarketMind SDK investigator (Stage 2.6)

A small TypeScript CLI that runs the existing MarketMind investigator through the official Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`, pinned at **0.3.302**, which bundles Claude Code 2.1.302, the same version
as the v0.5.0 evaluation baseline). It owns the agent loop instead of shelling out to `claude -p`. That gives it:
- a gated pre-flight before any prompt is sent;
- an in-process permission guard;
- live progress output;
- timeout and cancellation;
- a typed result, and a normalized execution record that the evaluation framework grades.

It is read-only and educational. It never trades and never writes outside its own temporary directories (or
`--out`). It adds nothing to the MCP server, the analytics or the database schema.

```bash
npm run agent -- investigate --market-id 900103 --fixture S03 --dry-run      # no credentials, nothing spawned
npm run agent -- investigate --market-id <gammaId> [--objective "..."] --max-budget-usd 0.25 [--json] [--out <dir>]
npm run agent -- investigate --discover [--version v1|v2] --max-budget-usd 0.25
```

- `--fixture S01..S12` serves the synthetic evaluation fixtures (no network). It uses that scenario's exact task arguments.
- Without `--fixture`, the live MarketMind server makes bounded public GET requests to Polymarket and reads your local database read-only.
- Progress goes to stderr. The report, or with `--json` the `marketmind.agent.investigation/1` result, goes to stdout.

## Authentication and cost (read first)

- **API key only.** A real run needs `ANTHROPIC_API_KEY`: a Claude Console API key, set in the launching shell.
  - Anthropic's Agent SDK docs say third-party apps may not use claude.ai login: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
  - API usage is billed to your Console organization, separately from any Claude subscription.
  - Each developer who clones the repository uses their own key.
- **Your Claude Code login is never used.** The app never reads, copies or prints Claude Code credentials. To keep the bundled CLI from falling back to them:
  - the subprocess environment is an explicit allowlist: `ANTHROPIC_API_KEY`, `PATH`, the Windows system variables and `TEMP`. OAuth tokens, `ANTHROPIC_AUTH_TOKEN`, base URLs and `CLAUDE_CODE_USE_*` are dropped;
  - `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` point to a fresh, empty temporary directory;
  - **pre-flight rejects any credential source other than `ANTHROPIC_API_KEY`** (for example `none`, which means a claude.ai login, or a `/login` managed key) and any non-Anthropic API provider, before the prompt is released.
- **Cost limits.**
  - `--max-budget-usd` is required for a real run and capped in code at $0.50.
  - The SDK's own `maxBudgetUsd` stops the session (status `budget_stopped`).
  - Reported costs are client-side **estimates, not billing**. Set a spend limit on the Console workspace as the authoritative backstop.
- **Without a key:** `--dry-run` works and prints the effective configuration. A real run exits 2 before loading the SDK. All automated tests run offline with an injected fake `query()`.

## Security model

`allowedTools` only auto-approves tools; it does not restrict them. So the boundary has several layers, and each layer is asserted offline (`optionViolations`, unit tests).

| Layer | Setting |
|---|---|
| Built-in tools | `tools: []`, and every built-in name (`BUILTIN_TOOL_NAMES` of the installed SDK, plus `Task`) in `disallowedTools`; `skills: []`, `plugins: []`; `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` |
| Settings | `settingSources: []`: no user, project or local settings, rules, hooks or CLAUDE.md. The `cwd` is a fresh temp directory outside the repository |
| Shipped skills and plugins | Inline `settings: SESSION_SETTINGS` turns off what ships inside Claude Code (see below). `optionViolations` requires an exact match, because inline settings can also carry permissions, hooks or env |
| MCP | Only `marketmind` (stdio, `alwaysLoad: true` so no tool search), `strictMcpConfig: true`. It starts through `mcp-launcher.mjs`, which spawns the server with a fresh environment of MarketMind and platform variables only, so the Anthropic key never reaches it (see below) |
| Permission mode | `dontAsk`. Never `bypassPermissions` or `allowDangerouslySkipPermissions` |
| Allow rules | Exactly the five `mcp__marketmind__*` tools, no wildcards. This is the layer that authorizes a call |
| PreToolUse guard | Runs first, and a deny wins. It only narrows: a call within policy gets **no decision**, never a hook `allow`, because a hook `allow` overrides `dontAsk` (see below). It passes only the five tools from the `marketmind` server on the main thread (no nested agents), and `includeSynthetic` only for an authorized fixture scenario. It blocks a repeat of an identical successful or pending call, permits **one** retry of a failed call whose MarketMind error says `retryable: true`, and enforces the policy budget (7 calls in Mode A, 8 in Mode B) |
| `canUseTool` | A canary that always denies and is recorded. Under `dontAsk` it should never be reached |
| Validation, phase 1: pre-prompt pre-flight | `initializationResult()`: credential source and investigator agent. `mcpServerStatus()`: only `marketmind`, connected, exactly the five tools. Recorded as `preflight`. The prompt is released only if this passes |
| Validation, phase 2: effective session | The first `system/init`, which arrives after the prompt is released: the tool pool must be exactly the five tools, `dontAsk`, API key source, no skills or plugins. Recorded as `effectiveSession` (`null` when not reached). Any mismatch aborts the session |
| Output | The key, key-shaped strings, session ids and home and temp paths are redacted from everything printed or written |

**The MCP server never receives the API key.** The runtime needs `ANTHROPIC_API_KEY`; the server does not. SDK 0.3.302 types the stdio `env` without documenting how it is merged. A static read of the bundled CLI 2.1.302 suggests stdio servers start with the runtime's own environment, plus `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE`, with the configured `env` on top. A configured `env` can therefore add or override a variable but cannot remove one. So the configured command is the launcher:
- it rebuilds the server environment from exact names (`PATH`, `SystemRoot`, `TEMP` and similar, plus the seven `MARKETMIND_*` variables the servers read);
- it passes stdio and the orphan-sweep tag through unchanged, and propagates the exit code;
- it logs variable names only, including whether the key was received and withheld.

On Windows, Node also adds its required system variables (`USERNAME`, `USERPROFILE`, `HOMEDRIVE` and others) to any child environment, copying the parent's values. None carries a credential. `optionViolations` refuses a configuration that bypasses the launcher or puts a non-`MARKETMIND_` variable in the server env. `test/unit/agentMcpEnv.test.ts` checks this with real processes and a dummy key.

Market text stays untrusted data. The investigator policy that says so is unchanged, and the S10 injection scenario grades it.

### A hook `allow` overrides `dontAsk`

Measured with the real CLI 2.1.302 against the local API stub: with `allowedTools: []` and `dontAsk`, a PreToolUse hook that returns `permissionDecision: "allow"` lets the tool **run**. The guard used to return that, so `allowedTools` was not the gate it appeared to be, and the P01 probe could not have denied anything. The five-tool pool was never wider, because the guard passed only those tools. The guard now returns no decision, and with the same setup:

| Setup | Result |
|---|---|
| No allow rules | `dontAsk` denies. `result.permission_denials` carries the `tool_use_id`, the tool does not run and `canUseTool` is not reached |
| The five allow rules | The tool runs |
| No allow rules, identical call retried | Denied again by `dontAsk` |

A denied call emits `system/permission_denied` before its tool result. No `PermissionDenied` hook fires under `dontAsk`, so the session passes that message to the guard. The call then stops counting as pending or against the budget.

### Reading a failed validation

Both phases end in status `preflight_failed` (or `auth_source_rejected` / `mcp_failed` from phase 1), so read the record by phase:

| `preflight.passed` | `effectiveSession` | Meaning |
|---|---|---|
| `false` | `null` | Phase 1 failed. The prompt was never released |
| `true` | `{ passed: false, problems }` | Phase 1 passed, phase 2 failed. The prompt was released, so a model request may have been made |
| `true` | `{ passed: true }` | Both passed |
| `true` | `null` | The stream ended before any `system/init` |

### Skills, plugins and commands in Claude Code 2.1.302

`skills: []` and `plugins: []` do not empty `system/init`. `skills` filters what the model may invoke, and `plugins` only adds external plugins, while `system/init` lists the commands loaded in the process. So three different questions apply:

| Question | Without `SESSION_SETTINGS` | With `SESSION_SETTINGS` |
|---|---|---|
| Listed in `system/init.skills` | 16 | **0** |
| Listed in `system/init.plugins` | `cc-plugin-agents-md`, `cc-plugin-plugin-authoring` | **none** |
| Executable tools sent to the model | the five MarketMind tools | the five MarketMind tools |
| Skill listing in the model's context | none | none |
| `Skill`, `Bash`, `PowerShell`, `Read`, `Write`, `WebFetch`, `WebSearch`, `Agent`, `Task`, `ToolSearch` called anyway | `No such tool available` | `No such tool available`, also with the guard hooks removed |
| `/debug` as the first user message | **expands** | refused, command not available |
| `/doctor` as the first user message | **expands** | refused, disabled via `skillOverrides` |
| `/plugin-authoring` as the first user message | **expands** | refused, command not available |

`SESSION_SETTINGS` is needed because each key covers part of this:
- `disableBundledSkills: true` removes 14 of the 16 skills, but not `doctor` (a built-in prompt command) or `plugin-authoring` (a built-in plugin's skill). With this key alone, `/debug` is refused while `/doctor` and `/plugin-authoring` still expand.
- `enabledPlugins` with `"<name>@builtin": false` removes both plugins and that skill.
- `skillOverrides: { doctor: "off" }` removes `doctor`.

With these settings the model-facing `system`, `messages` and `tools` of the first request are byte-identical to a session without them, apart from per-run temp paths and ids, so the investigator's instructions do not change.

**What stays advertised.** `system/init.slash_commands` still lists 28 built-in commands, such as `/init`, `/security-review`, `/compact` and `/config`. `disableBundledSkills` documents this: they "stay typable but are hidden from the model". They are not skills, they are not in `system/init.skills`, and the check does not inspect them. They are reachable **only** through the user-message channel: `/init` and `/security-review` did expand when sent as the first user message. The application writes that channel, and it sends one message: the skill body, which starts with a fixed heading, so user arguments can never put a `/` first (`agentConfig.sdk.test.ts` asserts this). Market text and tool results are not slash commands. Even an expanded command gets only the five tools.

The evidence is from runs of the real bundled CLI against a local stub of the Messages API, with a dummy key and all other HTTP(S) sent to a dead proxy: no Anthropic request, no real key. The stub captured the requests and scripted hostile `tool_use` blocks, and each slash result held across three runs. It shows how the CLI behaves, not how a real model behaves. Those probes are not part of the test suite; `npm run verify` uses the fake `query()`.

## Investigator reuse

There is exactly one policy source: `.claude/agents/market-investigator.md` and `.claude/skills/investigate-market/SKILL.md`, read at runtime.
- The agent file body becomes the main-thread agent's prompt, byte for byte (`agent: "market-investigator"` plus a programmatic `agents` definition).
- Its frontmatter maps to `tools`, `model`, `maxTurns` and `permissionMode`.
- `omitClaudeMd` has no effect on a main-thread agent. It is recorded as ignored, and isolation relies on `settingSources: []` and the temp `cwd` instead.
- The task prompt is the skill body with `$ARGUMENTS` substituted.
- Every result records the agent, skill and settings SHA-256s, the rendered prompt's SHA-256 and an options digest.

**Harness difference from the v0.5.0 baseline (by design):** there is no forked skill and no Opus main session; the investigator itself is the main thread. Comparisons always list this as a confounder.

## Lifecycle

`session.ts` is a state machine with every side effect injected:

1. No key: `missing_credentials`.
2. Options checked: `invalid_options`.
3. `query()` with a **gated** streaming prompt, then the pre-prompt pre-flight: `auth_source_rejected`, `mcp_failed` or `preflight_failed`.
4. The prompt is released and messages stream. The first `system/init` is the effective-session check: `preflight_failed`.
5. The session ends in one of: `completed`, `api_error`, `max_turns`, `budget_stopped`, `error`, `auth_failed`, `truncated` (no result), `timeout` or `cancelled` (SIGINT).
6. In `finally`, with bounded deadlines:
   - `close()`;
   - wait for the CLI process to exit (it is spawned by the app through `spawnClaudeCodeProcess`, so its PID is known);
   - kill the process tree (`taskkill /T /F` on Windows);
   - sweep for orphaned MarketMind servers by command-line tag;
   - remove the temp directories.

   Any cleanup problem makes an otherwise completed run `cleanup_failed`; it is never reported as success.

**`startup()` was investigated and not used.** `startup()` spawns the CLI and completes the initialize handshake before a prompt, but its `WarmQuery` handle has no inspection methods (only `query()` and `close()`). A gated streaming prompt gives the same "initialized, nothing asked yet" phase, plus `initializationResult()` and `mcpServerStatus()`.

**An API failure looks like success.** When the API refuses a request, the CLI emits a synthetic assistant message (`model: "<synthetic>"`, `is_api_error_message: true`) and a result with `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`, no `modelUsage` and zero cost. It also retries a 400 once without `thinking.display`, so one failure is two requests. The session reports `api_error` with no report. `duration_api_ms: 0` and `$0` do not show that no request was sent: both appear when the stub answers every request.

## Evaluation integration

`npx tsx test-agent/run.ts --harness sdk --scenario S01,S02,S03,S09,S10 --max-budget-usd 0.40 --total-budget-usd 2 --out .eval-out/sdk`
records agent-sdk runs in the usual layout:
- `run.json` (`marketmind.eval.run/2`, `execution.mode: agent-sdk`);
- `execution.json` (`marketmind.agent.execution/1`);
- redacted `sdk-messages.jsonl`.

It accepts only that subset plus the `P01` permission probe, never `--all`, and needs `ANTHROPIC_API_KEY`. P01 runs with **no allow rules** (`allowedTools: []`, stricter than normal). The model gets the same five tools and the same task as a normal run; only the authorization is missing. The guard passes the calls without deciding, so any denial comes from `dontAsk`, and the P1 check grades it. A run that attempts no tool is inconclusive, never a successful denial, and `run.ts` exits 1 unless P1 passes. Only the evaluation harness can select a probe; the CLI rejects `--fixture P01`.

**Runtime evidence of the launcher.** Each session passes `MARKETMIND_LAUNCH_REPORT` (a file in its temp home) in the server's configured env. The launcher appends a names-only line, `marketmind.mcp-launcher/1`, recording:
- the variables it received;
- the variables it gave the server;
- whether `ANTHROPIC_API_KEY` arrived.

The session copies these lines into `execution.json` (`mcpLauncher`) before removing the temp directory. If the server connected but no report exists, or the server got anything beyond the allowlist, that is recorded as a problem. `harness.guardSha256` records the hash of `agent-sdk/guard.ts`, because the options digest shows only that a guard is installed; records from before this field read as null. `test-agent/eval/sdkTrace.ts` normalizes the execution record for the unchanged graders, labelled `source: agent-sdk`. The SDK-specific checks are described in `test-agent/README.md`. `test-agent/eval/compare.ts` compares directories, confounders first.

**Real runs.** Results are in [`docs/evaluation-sdk-stage-2.6.md`](../docs/evaluation-sdk-stage-2.6.md): one passing P01 and five synthetic investigations. Before that passing P01, two P01 runs passed both validation phases and then failed with an HTTP 400 with no body, so nothing was tested. Where that 400 came from is undetermined. An invalid key was rejected as `auth_failed`, and the run recorded no usage.

## Runtime assumptions

Verified offline: the option types and documentation of SDK 0.3.302 (`sdk.d.ts`), the application's state machine (fake query), Windows process cleanup with real child processes, and, with the real CLI against a local API stub, items 1 and 2's initialization facts and the skill and plugin behaviour above.

The six recorded real runs (five investigations and P01) settled these items on Windows with Claude Code 2.1.302:

| Item | Observed |
|---|---|
| 1 Tool pool | `system/init` listed exactly the five tools. The request's `tools` array was not captured |
| 2 Main-thread agent | The guard saw `agent_type: market-investigator` on every call |
| 4 Credential isolation | `apiKeySource` was `ANTHROPIC_API_KEY` in every run |
| 5 Hook payloads | No disagreement between hooks and the message stream. No tool returned an error, so the MarketMind `isError` path is **still unobserved** |
| 6 Permission denials | P01 recorded 2 denials, each with its `tool_use_id` |
| 7 Process tree | The CLI exited with no forced kill or orphans, and temp directories were removed |
| 8 Single turn | Every session ended cleanly |
| 9 Server environment | The launcher received the key and did not pass it to the server |
| 10 Cost reporting | `costBasis: list` and a total were reported. No run reached its budget, so **`maxBudgetUsd` overshoot is still unobserved** |

Item 3 remains unverified. The original assumptions:

1. **Tool pool against the real API:** with the stub, `tools: []` plus `disallowedTools` left exactly the five MCP tools in both `system/init` and the request's `tools` array. The first real run should confirm the same. The effective-session check aborts otherwise.
2. **Main-thread agent:** `agent` with a programmatic definition makes the investigator the main thread with its tools and model. With the stub, `initializationResult().agents` listed it, the request used the agent's prompt and model, and the guard saw `agent_type: market-investigator`. The first real run should confirm the same. D2 is NEEDS_REVIEW if hooks do not show it.
3. **No API request before the prompt:** `initializationResult()` and `mcpServerStatus()` answer without one. The docs do not say the initialize phase makes no API request. It is **not assumed to be free**, and a rejected pre-flight may still have cost a request.
4. **Credential isolation:** with an isolated `CLAUDE_CONFIG_DIR` and home, the bundled CLI finds no Claude Code login. If it did, `apiKeySource` would not be `ANTHROPIC_API_KEY` and pre-flight would abort.
5. **Hook payloads:** the shapes of the `PostToolUse` `tool_response` and `mcpServerStatus().tools[].name` for MCP tools, and whether a MarketMind `isError` result triggers PostToolUse or PostToolUseFailure. Both are handled, and disagreements between hooks and the message stream are recorded as problems.
6. **Permission denials:** with the stub, dontAsk denials appear in `result.permission_denials` with `tool_use_id`. The first real denial should confirm the same.
7. **Process tree:** `close()` and the forwarded abort signal terminate the CLI and its MCP grandchild on Windows within the cleanup deadline.
8. **Single turn:** keeping the input stream open until the result, then closing, ends the session cleanly.
9. **Environment reaching the server:** that the runtime starts the configured command (the launcher) as the stdio server, with roughly the environment read from the binary. The server is protected either way, because the launcher rebuilds its environment; the launcher's stderr line shows whether the key arrived, if the runtime surfaces server stderr.
10. **Cost reporting:** `costBasis` and `total_cost_usd` under API-key billing, and how far `maxBudgetUsd` overshoots.
