#!/usr/bin/env node
// Environment-sanitizing launcher for the MarketMind stdio MCP server under the Agent SDK.
//
//   node agent-sdk/mcp-launcher.mjs <server script> [server args...]
//
// The Claude Code runtime needs ANTHROPIC_API_KEY; the MarketMind server does not. SDK 0.3.302 types
// stdio `env` as Record<string, string> without documenting merge semantics, and the bundled CLI
// (2.1.302) appears to start stdio servers with its own environment plus the configured `env` on top,
// so a configured `env` can add or override variables but cannot remove one. This launcher therefore
// spawns the server with a fresh environment built only from SERVER_ENV_KEYS, whatever it was given
// itself. The server process never holds the Anthropic credential. Nothing here writes to stdout,
// which is reserved for the MCP protocol.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Platform variables Node needs to start and resolve paths; none carries a credential. */
export const PLATFORM_KEYS = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR"];
/** Every variable the MarketMind servers read (src/config, src/mcp/main.ts, test-agent/scenarioServer.ts). */
export const MARKETMIND_KEYS = ["MARKETMIND_DB", "MARKETMIND_GAMMA_URL", "MARKETMIND_CLOB_URL", "MARKETMIND_TIMEOUT_MS", "MARKETMIND_MAX_RETRIES", "MARKETMIND_MCP_MAX_REQUESTS", "MARKETMIND_BUILD_ID"];
export const SERVER_ENV_KEYS = [...PLATFORM_KEYS, ...MARKETMIND_KEYS];

/** The server environment: exact allowlisted names only, non-empty string values only. */
export function serverEnv(parent) {
  const env = {};
  for (const k of SERVER_ENV_KEYS) if (typeof parent[k] === "string" && parent[k] !== "") env[k] = parent[k];
  return env;
}

function main(argv) {
  const [script, ...args] = argv;
  if (!script) {
    process.stderr.write("marketmind-launcher: usage: mcp-launcher.mjs <server script> [args...]\n");
    process.exit(2);
  }
  const env = serverEnv(process.env);
  // Names only, never values: shows what the runtime passed in and what was withheld.
  const dropped = Object.keys(process.env).filter((k) => !(k in env)).sort();
  process.stderr.write(`marketmind-launcher: server env ${Object.keys(env).sort().join(",")}; withheld ${dropped.length} variable(s); ANTHROPIC_API_KEY received: ${"ANTHROPIC_API_KEY" in process.env ? "yes, withheld" : "no"}\n`);
  const child = spawn(process.execPath, [script, ...args], { env, stdio: "inherit", windowsHide: true });
  // Runtime evidence for the SDK session (it reads this before removing its temp directory). The path
  // comes from the configured server env and is not passed on; the report holds names, never values.
  const reportPath = process.env.MARKETMIND_LAUNCH_REPORT;
  if (reportPath) {
    const received = Object.keys(process.env).sort();
    const report = {
      contract: "marketmind.mcp-launcher/1",
      launcherPid: process.pid,
      serverPid: child.pid ?? null,
      receivedEnvKeys: received,
      serverEnvKeys: Object.keys(env).sort(),
      anthropicKeyReceived: "ANTHROPIC_API_KEY" in process.env,
      credentialKeysReceived: received.filter((k) => /ANTHROPIC|OAUTH|TOKEN|API_KEY|SECRET|PASSWORD/i.test(k)),
    };
    try {
      appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
    } catch (error) {
      process.stderr.write(`marketmind-launcher: report not written: ${error.message}\n`);
    }
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(`marketmind-launcher: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
