import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../agent-sdk/args.js";
import { createGuard } from "../../agent-sdk/guard.js";
import { loadInvestigator, REPO_ROOT } from "../../agent-sdk/investigator.js";
import { buildOptions, MCP_LAUNCHER, serverSpec } from "../../agent-sdk/options.js";
import { optionViolations } from "../../agent-sdk/session.js";
import { seedEvalDb } from "../../test-agent/fixtures.js";
import { killTree, processesTagged } from "../../test-agent/processes.js";

// Stage 2.6: the Anthropic credential the Claude Code runtime needs must not reach the MarketMind MCP
// server. These tests start REAL processes (the launcher and a dummy Node child, then the real fixture
// server) with a dummy sentinel key. Claude Code is never started and nothing contacts Anthropic.

vi.setConfig({ testTimeout: 60_000 });

const SENTINEL = "sk-ant-api03-MCPENV-SENTINEL-0000000000";
const OAUTH_SENTINEL = "oauth-MCPENV-SENTINEL-1111";
const platform = () => {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "PATHEXT", "COMSPEC", "WINDIR", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k];
  return env;
};

/**
 * On Windows, Node (libuv) adds these to any child environment that lacks them, copying the parent's
 * values. They identify the machine and user; none carries a credential.
 */
const LIBUV_WINDOWS_REQUIRED = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"];
const permitted = (k: string) => launcherKeys.SERVER_ENV_KEYS.includes(k) || (process.platform === "win32" && (LIBUV_WINDOWS_REQUIRED.includes(k.toUpperCase()) || /^=/.test(k)));

let dir: string;
let dummy: string;
let launcherKeys: { SERVER_ENV_KEYS: string[]; MARKETMIND_KEYS: string[]; serverEnv: (p: Record<string, string | undefined>) => Record<string, string> };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mm-mcpenv-"));
  dummy = join(dir, "dummy-server.cjs");
  // Reports everything this process can see of its environment: process.env and, where the platform
  // exposes it, the initial environment block. It also echoes one stdin line (the MCP stdio path).
  writeFileSync(
    dummy,
    `const fs = require("node:fs");
let raw = "";
try { raw = fs.readFileSync("/proc/self/environ", "latin1"); } catch {}
const seen = JSON.stringify(process.env) + raw;
const report = { keys: Object.keys(process.env).sort(), argv: process.argv.slice(2), sentinelVisible: /SENTINEL/.test(seen), environBlockRead: raw.length > 0 };
process.stdin.once("data", (d) => { process.stdout.write(JSON.stringify({ ...report, echo: String(d).trim() }) + "\\n"); process.exit(Number(process.env.MARKETMIND_TIMEOUT_MS ?? 0) === 3 ? 3 : 0); });
`,
  );
  launcherKeys = (await import(pathToFileURL(MCP_LAUNCHER).href)) as typeof launcherKeys;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface DummyReport {
  keys: string[];
  argv: string[];
  sentinelVisible: boolean;
  environBlockRead: boolean;
  echo: string;
}
function run(command: string, args: string[], env: Record<string, string | undefined>) {
  const r = spawnSync(command, args, { env, input: "ping\n", encoding: "utf8", timeout: 30_000, windowsHide: true });
  const line = r.stdout.trim().split(/\r?\n/).pop() ?? "";
  return { status: r.status, stderr: r.stderr, report: (line ? JSON.parse(line) : null) as DummyReport | null, raw: r.stdout + r.stderr };
}

const investigator = loadInvestigator();
const { request } = parseArgs(["investigate", "--market-id", "900103", "--fixture", "S03", "--max-budget-usd", "0.25"]);
function configured(parentEnv: Record<string, string>) {
  const options = buildOptions({
    investigator,
    request,
    server: serverSpec(request, parentEnv, "mm-sdk-envtest", join(dir, "fixture.sqlite")),
    iso: { cwd: join(dir, "cwd"), home: join(dir, "home") },
    parentEnv,
    maxBudgetUsd: 0.25,
    abortController: new AbortController(),
    guard: createGuard({ mode: "A", syntheticAuthorized: false, agentName: investigator.name }),
  });
  return { options, mcp: options.mcpServers!.marketmind as McpStdioServerConfig };
}
/**
 * The stdio environment as the bundled CLI 2.1.302 appears to build it (read statically from the
 * binary): the runtime's own environment, a few Claude Code variables, then the configured env on top.
 * The real runtime is not started here; this models the worst case, in which every runtime variable
 * reaches the server command.
 */
const runtimeStdioEnv = (runtimeEnv: Record<string, string | undefined>, configuredEnv: Record<string, string>) => ({
  ...runtimeEnv,
  CLAUDE_PROJECT_DIR: dir,
  CLAUDE_CODE_SESSION_ID: "SENTINEL-session",
  CLAUDECODE: "1",
  ...configuredEnv,
});

describe("MCP child environment isolation (real processes, dummy key)", () => {
  it("negative control: a child started with the runtime's environment can read the sentinel", () => {
    const { options, mcp } = configured({ ...platform(), ANTHROPIC_API_KEY: SENTINEL });
    expect(options.env!.ANTHROPIC_API_KEY).toBe(SENTINEL); // the runtime itself needs the key
    const r = run(process.execPath, [dummy], runtimeStdioEnv(options.env!, mcp.env ?? {}));
    expect(r.report?.sentinelVisible).toBe(true);
    expect(r.report?.keys).toContain("ANTHROPIC_API_KEY");
  });

  it("the configured server command (the launcher) gives the server no credential, whatever the runtime passes", () => {
    const { options, mcp } = configured({ ...platform(), ANTHROPIC_API_KEY: SENTINEL });
    expect(mcp.command).toBe(process.execPath);
    expect(mcp.args![0]).toBe(MCP_LAUNCHER);
    const runtimeEnv = { ...options.env!, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SENTINEL, ANTHROPIC_AUTH_TOKEN: OAUTH_SENTINEL };
    const args = [MCP_LAUNCHER, dummy, ...mcp.args!.slice(2)];
    const r = run(mcp.command, args, runtimeStdioEnv(runtimeEnv, mcp.env ?? {}));
    expect(r.status, r.stderr).toBe(0);
    expect(r.report).not.toBeNull();
    expect(r.report!.sentinelVisible).toBe(false);
    expect(r.raw).not.toContain(SENTINEL);
    expect(r.raw).not.toContain(OAUTH_SENTINEL);
    for (const k of r.report!.keys) expect(permitted(k), k).toBe(true);
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "HOME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"]) expect(r.report!.keys).not.toContain(k);
    expect(r.report!.keys.filter((k) => /ANTHROPIC|CLAUDE|TOKEN|SECRET|API_KEY/i.test(k))).toEqual([]);
    expect(r.report!.keys).toContain("MARKETMIND_DB");
    expect(r.report!.argv).toEqual(["--sdk-tag=mm-sdk-envtest"]); // the orphan-sweep tag reaches the server
    expect(r.report!.echo).toBe("ping"); // stdin/stdout pass through untouched
    expect(r.stderr).toContain("ANTHROPIC_API_KEY received: yes, withheld");
    if (process.platform === "linux") expect(r.report!.environBlockRead).toBe(true);
  });

  it("the launcher propagates the server's exit code and reports a missing script argument", () => {
    const r = run(process.execPath, [MCP_LAUNCHER, dummy], { ...platform(), MARKETMIND_TIMEOUT_MS: "3", ANTHROPIC_API_KEY: SENTINEL });
    expect(r.status).toBe(3);
    expect(r.report?.sentinelVisible).toBe(false);
    const usage = spawnSync(process.execPath, [MCP_LAUNCHER], { env: platform(), encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("usage");
  });

  it("serverEnv keeps exact allowlisted names only; the allowlist covers every variable the servers read", () => {
    expect(launcherKeys.serverEnv({ ANTHROPIC_API_KEY: SENTINEL, MARKETMIND_DB: "x", MARKETMIND_DBX: "y", marketmind_db: "z", PATH: "/bin", EMPTY: "", MARKETMIND_GAMMA_URL: "" })).toEqual({ MARKETMIND_DB: "x", PATH: "/bin" });
    expect(launcherKeys.SERVER_ENV_KEYS.some((k) => /ANTHROPIC|CLAUDE|TOKEN|KEY|SECRET|HOME|PROFILE|APPDATA/i.test(k))).toBe(false);
    const read = new Set<string>();
    for (const f of ["src/config/config.ts", "src/mcp/main.ts", "src/mcp/server.ts", "test-agent/scenarioServer.ts"]) {
      const p = join(REPO_ROOT, f);
      if (existsSync(p)) for (const m of readFileSync(p, "utf8").matchAll(/MARKETMIND_[A-Z_]+/g)) read.add(m[0]);
    }
    expect(read.size).toBeGreaterThan(0);
    for (const k of read) expect(launcherKeys.MARKETMIND_KEYS, k).toContain(k);
  });

  it("optionViolations rejects a server started without the launcher or with a credential in its env", () => {
    const { options, mcp } = configured({ ...platform(), ANTHROPIC_API_KEY: SENTINEL });
    expect(optionViolations(options)).toEqual([]);
    const direct = { ...options, mcpServers: { marketmind: { ...mcp, args: mcp.args!.slice(1) } } };
    expect(optionViolations(direct).join("; ")).toContain("environment-sanitizing launcher");
    const leaky = { ...options, mcpServers: { marketmind: { ...mcp, env: { ...mcp.env, ANTHROPIC_API_KEY: SENTINEL } } } };
    expect(optionViolations(leaky).join("; ")).toContain("must not carry ANTHROPIC_API_KEY");
  });

  it("the real fixture MCP server answers through the launcher with the sanitized environment", async () => {
    const db = join(dir, "fixture.sqlite");
    seedEvalDb(db);
    const { options, mcp } = configured({ ...platform(), ANTHROPIC_API_KEY: SENTINEL });
    const child = spawn(mcp.command, mcp.args, { env: runtimeStdioEnv(options.env!, mcp.env ?? {}), cwd: dir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += String(d)));
    child.stderr.on("data", (d: Buffer) => (err += String(d)));
    const response = (id: number) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setInterval(() => {
          const line = out.split("\n").find((l) => l.includes(`"id":${id}`));
          if (line) {
            clearInterval(timer);
            resolve(JSON.parse(line) as Record<string, unknown>);
          } else if (child.exitCode !== null) {
            clearInterval(timer);
            reject(new Error(`server exited: ${err}`));
          }
        }, 20);
      });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "env-test", version: "0" } } });
      const init = (await response(1)) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("marketmind");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const list = (await response(2)) as { result: { tools: { name: string }[] } };
      expect(list.result.tools.map((t) => t.name).sort()).toEqual(["get_market_history", "get_observation_details", "inspect_market", "list_collection_runs", "scan_markets"]);
      expect(err).toContain("ANTHROPIC_API_KEY received: yes, withheld");
      expect(out + err).not.toContain(SENTINEL);
    } finally {
      const exited = new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
      killTree(child.pid!);
      await exited;
      for (const pid of processesTagged("mm-sdk-envtest")) killTree(pid);
    }
    expect(processesTagged("mm-sdk-envtest")).toEqual([]);
  });
});

describe("MCP launcher self-report (real process)", () => {
  it("records names only: what it received, what the server got, and whether the key arrived", () => {
    const report = join(dir, "launch-report.jsonl");
    const r = run(process.execPath, [MCP_LAUNCHER, dummy], { ...platform(), ANTHROPIC_API_KEY: SENTINEL, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SENTINEL, MARKETMIND_DB: "x", MARKETMIND_LAUNCH_REPORT: report });
    expect(r.status, r.stderr).toBe(0);
    expect(r.report!.keys).not.toContain("MARKETMIND_LAUNCH_REPORT");
    const text = readFileSync(report, "utf8");
    expect(text).not.toContain("SENTINEL");
    const line = JSON.parse(text.trim()) as { contract: string; anthropicKeyReceived: boolean; credentialKeysReceived: string[]; serverEnvKeys: string[]; receivedEnvKeys: string[]; serverPid: number | null };
    expect(line).toMatchObject({ contract: "marketmind.mcp-launcher/1", anthropicKeyReceived: true, credentialKeysReceived: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] });
    expect(line.receivedEnvKeys).toContain("MARKETMIND_LAUNCH_REPORT");
    expect(line.serverEnvKeys).toContain("MARKETMIND_DB");
    expect(line.serverEnvKeys.filter((k) => /ANTHROPIC|CLAUDE|LAUNCH_REPORT/.test(k))).toEqual([]);
    expect(line.serverPid).toBeGreaterThan(0);
  });
});
