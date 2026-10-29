import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTemp, tempDbPath } from "../storageFixtures.js";
import { seedObservation } from "../mcpFixtures.js";

// These tests start the actual server executables as child processes and talk to them over real stdio.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("../../bin/marketmind-mcp.mjs", import.meta.url));
const FIXTURE_SERVER = fileURLToPath(new URL("../mcp/fixtureServer.ts", import.meta.url));
const FORBID_NETWORK = pathToFileURL(fileURLToPath(new URL("../mcp/forbidNetwork.mjs", import.meta.url))).href;

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  cleanupTemp();
});

async function stdioClient(args: string[], env: Record<string, string>, cwd: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args, env: { ...getDefaultEnvironment(), ...env }, cwd, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "marketmind-stdio-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  await client.listTools();
  return { client, stderr: () => stderr.join("") };
}

type Result = { isError?: boolean; content: { text?: string }[]; structuredContent?: Record<string, unknown> };
const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;

describe("spawned real server (bin/marketmind-mcp.mjs) with the network forbidden", () => {
  it("starts from outside the repository, lists five tools and serves stored evidence offline", async () => {
    const dbPath = tempDbPath();
    const id = seedObservation(dbPath, { id: "1" });
    const { client, stderr } = await stdioClient([LAUNCHER], { MARKETMIND_DB: dbPath, NODE_OPTIONS: `--import ${FORBID_NETWORK}` }, tmpdir());
    expect(client.getServerVersion()?.name).toBe("marketmind");
    expect((await client.listTools()).tools).toHaveLength(5);
    const runs = await callTool(client, "list_collection_runs");
    expect(runs.isError).toBeFalsy();
    const history = await callTool(client, "get_market_history", { marketId: "1" });
    expect(history.structuredContent).toMatchObject({ status: "ok", rows: { items: [{ observationId: id }] } });
    const details = await callTool(client, "get_observation_details", { observationId: id });
    expect(details.structuredContent).toMatchObject({ observation: { observationId: id, gammaId: "1" } });
    expect(stderr()).toContain("ready on stdio");
    expect(stderr()).not.toContain("[forbidNetwork]");
  }, 30_000);

  it("a live tool's every attempt reaches only the (blocked) network and maps to upstream_unavailable", async () => {
    const { client, stderr } = await stdioClient([LAUNCHER], { MARKETMIND_DB: tempDbPath("none.sqlite"), NODE_OPTIONS: `--import ${FORBID_NETWORK}` }, tmpdir());
    const r = await callTool(client, "scan_markets", { maxMarkets: 1 });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text!)).toMatchObject({ error: { category: "upstream_unavailable", details: { kind: "Network" } } });
    expect(stderr().match(/\[forbidNetwork\] blocked https:\/\/gamma-api\.polymarket\.com\/markets\/keyset/g)).toHaveLength(2);
    const missing = await callTool(client, "get_market_history", { marketId: "1" });
    expect(JSON.parse(missing.content[0]!.text!)).toMatchObject({ error: { category: "database_missing" } });
  }, 30_000);
});

describe("spawned fixture server (same server factory, fixture HTTP)", () => {
  it("runs both live tools end to end over real stdio", async () => {
    const { client } = await stdioClient(["--import", "tsx", FIXTURE_SERVER], {}, ROOT);
    const scan = (await callTool(client, "scan_markets", { maxMarkets: 2 })).structuredContent as { status: string; ranked: { items: { gammaId: string; metrics: { spread: string } }[] } };
    expect(scan.status).toBe("complete");
    expect(scan.ranked.items.map((x) => [x.gammaId, x.metrics.spread])).toEqual([
      ["91", "0.06"],
      ["92", "0.05"],
    ]);
    const inspect = await callTool(client, "inspect_market", { marketId: "100001" });
    expect(inspect.structuredContent).toMatchObject({ status: "ok", outcomes: [{ metrics: { spread: "0.001" } }, {}] });
  }, 30_000);
});

/** Spawn a server, write raw JSON-RPC lines, then close stdin; resolve with everything it printed. */
function rawSession(args: string[], lines: string[], env: Record<string, string>, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...getDefaultEnvironment(), ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let closedAt = 0;
    let sent = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      // Wait until the server is up, send the requests, then close stdin once they are answered (or at once).
      if (/ready/.test(stderr) && !sent) {
        sent = true;
        for (const l of lines) child.stdin.write(`${l}\n`);
        setTimeout(() => {
          closedAt = Date.now();
          child.stdin.end();
        }, env.FIXTURE_HANG === "1" ? 300 : 1_500);
      }
    });
    const killer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not exit after stdin closed; stderr: ${stderr}`));
    }, 20_000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, ms: Date.now() - closedAt });
    });
  });
}

const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"raw","version":"0"}}}';
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';

describe("stdio protocol integrity and shutdown", () => {
  it("stdout carries only JSON-RPC messages; diagnostics go to stderr; closing stdin exits cleanly", async () => {
    const r = await rawSession(
      [LAUNCHER],
      [INIT, INITIALIZED, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_collection_runs","arguments":{}}}'],
      { MARKETMIND_DB: tempDbPath("none.sqlite"), NODE_OPTIONS: `--import ${FORBID_NETWORK}` },
      tmpdir(),
    );
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const messages = lines.map((l) => JSON.parse(l) as { jsonrpc: string; id: number });
    expect(messages.every((m) => m.jsonrpc === "2.0")).toBe(true);
    expect(messages.map((m) => m.id).sort()).toEqual([1, 2, 3]);
    expect(r.stderr).toMatch(/\[marketmind-mcp\] v\d+\.\d+\.\d+ ready on stdio/);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(5_000);
  }, 30_000);

  it("exits promptly when stdin closes during an in-flight live call, without answering it", async () => {
    const r = await rawSession(
      ["--import", "tsx", FIXTURE_SERVER],
      [INIT, INITIALIZED, '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"scan_markets","arguments":{}}}'],
      { FIXTURE_HANG: "1" },
      ROOT,
    );
    const ids = r.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as { id?: number }).id);
    expect(ids).toEqual([1]);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(5_000);
  }, 30_000);
});
