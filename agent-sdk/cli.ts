// MarketMind SDK investigator CLI.
//
//   npm run agent -- investigate --market-id 900103 --fixture S03 --dry-run
//   npm run agent -- investigate --market-id <gammaId> [--objective "..."] --max-budget-usd 0.25
//   npm run agent -- investigate --discover [--version v1|v2] --max-budget-usd 0.25
//
// --dry-run prints the effective configuration and prompt digest. It needs no credentials, never loads
// the SDK runtime, never spawns Claude Code and never makes an API call. A real run requires
// ANTHROPIC_API_KEY (a Claude Console API key) and an explicit --max-budget-usd; it never uses Claude
// Code login credentials. Progress goes to stderr; the report (or --json result) goes to stdout.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { seedEvalDb } from "../test-agent/fixtures.js";
import { killTree, processesTagged, repoState, sha256 } from "../test-agent/processes.js";
import { DEFAULT_DB_PATH } from "../src/config/config.js";
import { parseArgs, UsageError, type CliArgs } from "./args.js";
import { createGuard } from "./guard.js";
import { loadInvestigator, REPO_ROOT, type Investigator } from "./investigator.js";
import { buildOptions, describeOptions, harnessOf, serverSpec, stableStringify } from "./options.js";
import { Redactor } from "./redact.js";
import { optionViolations, runInvestigation, type QueryFn, type SessionDeps, type SessionOutcome } from "./session.js";

export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  env: Record<string, string | undefined>;
}

/** The dry-run report: options with placeholders, never the environment's values. Pure. */
export function dryRun(args: CliArgs, investigator: Investigator, env: Record<string, string | undefined>): Record<string, unknown> {
  const iso = { cwd: "<temp>/cwd", home: "<temp>/home" };
  const server = serverSpec(args.request, env, "<tag>", args.request.server === "fixture" ? "<temp>/fixture.sqlite" : null);
  const guard = createGuard({ mode: args.request.mode, syntheticAuthorized: args.request.syntheticAuthorized, agentName: investigator.name });
  const options = buildOptions({ investigator, request: args.request, server, iso, parentEnv: env, maxBudgetUsd: args.maxBudgetUsd, abortController: new AbortController(), guard });
  const described = describeOptions(options, { investigator, server, timeoutMs: args.timeoutMs });
  const prompt = investigator.renderPrompt(args.request.arguments);
  return {
    contract: "marketmind.agent.dry-run/1",
    request: args.request,
    harness: harnessOf(options, described, { investigator, timeoutMs: args.timeoutMs }),
    options: described,
    optionViolations: optionViolations(options),
    investigator: { ...investigator.hashes, promptSha256: sha256(prompt), ignoredFrontmatter: investigator.ignoredFrontmatter },
    credentials: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ? "set (value not shown)" : "not set (required for a real run)" },
    wouldSpawn: false,
    note: "Dry run: the SDK runtime was not loaded, nothing was spawned and no API request was made.",
  };
}

export function realDeps(io: Io, query: QueryFn): SessionDeps {
  return {
    query,
    parentEnv: io.env,
    isolation() {
      const root = mkdtempSync(join(tmpdir(), "mm-sdk-"));
      const cwd = join(root, "cwd");
      const home = join(root, "home");
      for (const d of [cwd, join(home, ".claude"), join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) mkdirSync(d, { recursive: true });
      return { cwd, home, remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
    },
    seedFixture(dir) {
      const db = join(dir, "agent-fixtures.sqlite");
      seedEvalDb(db);
      return db;
    },
    spawn(o) {
      return spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    },
    processesTagged,
    killTree,
    hashFile: (p) => (existsSync(p) ? sha256(readFileSync(p)) : null),
    repoState: () => {
      try {
        return repoState();
      } catch {
        return null;
      }
    },
    databasePath: (request, fixtureDb) => (request.server === "fixture" ? fixtureDb : resolve(REPO_ROOT, io.env.MARKETMIND_DB ?? DEFAULT_DB_PATH)),
    tag: () => `mm-sdk-${randomUUID()}`,
    onProgress: (p) => io.stderr(`${p.text}\n`),
  };
}

/** --out must be outside the repository or under its gitignored .eval-out/. */
export function checkOut(out: string): string {
  const abs = resolve(out);
  const inRepo = relative(REPO_ROOT, abs);
  if (!isAbsolute(inRepo) && !inRepo.startsWith("..") && !inRepo.startsWith(".eval-out")) throw new UsageError("--out inside the repository must be under .eval-out/ (gitignored)");
  return abs;
}

function writeArtifacts(out: string, o: SessionOutcome): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "sdk-messages.jsonl"), o.messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  writeFileSync(join(out, "execution.json"), stableStringify(o.record) + "\n");
  writeFileSync(join(out, "investigation.json"), stableStringify(o.result) + "\n");
  writeFileSync(join(out, "stderr.txt"), o.stderr);
}

/** Entry point; returns the process exit code. `loadQuery` is only called for a real run. */
export async function main(argv: string[], io: Io, loadQuery: () => Promise<QueryFn>): Promise<number> {
  let args: CliArgs;
  let out: string | null;
  try {
    args = parseArgs(argv);
    out = args.out === null ? null : checkOut(args.out);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const investigator = loadInvestigator();
  if (args.dryRun) {
    io.stdout(stableStringify(dryRun(args, investigator, io.env)) + "\n");
    return 0;
  }
  if (!io.env.ANTHROPIC_API_KEY) {
    io.stderr("ANTHROPIC_API_KEY is not set. The SDK application needs a Claude Console API key in the launching shell; it never uses Claude Code login credentials. Nothing was started.\n");
    return 2;
  }
  const abort = new AbortController();
  const onSigint = () => {
    io.stderr("cancelling...\n");
    abort.abort("cancelled");
  };
  process.once("SIGINT", onSigint);
  try {
    const query = await loadQuery();
    const outcome = await runInvestigation({ investigator, request: args.request, maxBudgetUsd: args.maxBudgetUsd!, timeoutMs: args.timeoutMs, abort }, realDeps(io, query));
    if (out) writeArtifacts(out, outcome);
    const r = outcome.result;
    io.stdout(args.json ? stableStringify(r) + "\n" : `${r.report.markdown || "(no report)"}\n`);
    io.stderr(`status: ${r.status} (${r.statusDetail})${r.usage.estimatedCostUsd !== null ? `; estimated usage $${r.usage.estimatedCostUsd.toFixed(4)} (estimate, not billing)` : ""}\n`);
    return r.status === "completed" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const io: Io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(new Redactor(process.env.ANTHROPIC_API_KEY ? [process.env.ANTHROPIC_API_KEY] : []).text(s)), env: process.env };
  const code = await main(process.argv.slice(2), io, async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return sdk.query; // type-checked: QueryFn is a structural subset of the real query()
  });
  process.exitCode = code;
}
