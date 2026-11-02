import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebStatusOutput } from "../../src/research/contracts.js";
import { DEFAULT_WEB_PORT, webSettings } from "../../src/web/settings.js";
import { get } from "../webFixtures.js";

const LAUNCHER = fileURLToPath(new URL("../../bin/marketmind-web.mjs", import.meta.url));
const FORBID_NETWORK = pathToFileURL(fileURLToPath(new URL("../mcp/forbidNetwork.mjs", import.meta.url))).href;

describe("webSettings", () => {
  it("defaults to port 4317, no dev origin, 2,000 lifetime attempts and 60 per five minutes", () => {
    expect(webSettings({})).toMatchObject({ port: DEFAULT_WEB_PORT, devOrigins: [], processLimit: 2_000, window: { limit: 60, windowMs: 300_000 } });
    expect(DEFAULT_WEB_PORT).toBe(4317);
  });

  it("accepts a port and a loopback dev origin", () => {
    expect(webSettings({ MARKETMIND_WEB_PORT: "5000", MARKETMIND_WEB_DEV_ORIGIN: "http://localhost:5173" })).toMatchObject({ port: 5000, devOrigins: ["http://localhost:5173"] });
    expect(webSettings({ MARKETMIND_WEB_DEV_ORIGIN: "http://127.0.0.1:5173" }).devOrigins).toEqual(["http://127.0.0.1:5173"]);
  });

  it.each(["0", "80", "65536", "abc", "4317.5"])("rejects MARKETMIND_WEB_PORT=%s", (port) => {
    expect(() => webSettings({ MARKETMIND_WEB_PORT: port })).toThrow(/MARKETMIND_WEB_PORT/);
  });

  it.each(["*", "http://evil.example:5173", "https://localhost:5173", "http://localhost", "http://localhost:5173/", "http://localhost:99999", "http://0.0.0.0:5173", "null"])(
    "rejects MARKETMIND_WEB_DEV_ORIGIN=%s",
    (origin) => {
      expect(() => webSettings({ MARKETMIND_WEB_DEV_ORIGIN: origin })).toThrow(/MARKETMIND_WEB_DEV_ORIGIN/);
    },
  );

  it("rejects invalid budgets and base configuration", () => {
    expect(() => webSettings({ MARKETMIND_WEB_WINDOW_REQUESTS: "7" })).toThrow(/WINDOW_REQUESTS/);
    expect(() => webSettings({ MARKETMIND_GAMMA_URL: "http://gamma.example" })).toThrow(/MARKETMIND_\* environment/);
  });
});

// The real launcher in a child process, with any upstream fetch blocked and reported.
const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

function launch(env: Record<string, string>) {
  const child = spawn(process.execPath, [LAUNCHER], { cwd: tmpdir(), env: { ...process.env, NODE_OPTIONS: `--import ${FORBID_NETWORK}`, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const waitFor = async (text: string) => {
    const end = Date.now() + 20_000;
    while (!stderr.includes(text)) {
      if (Date.now() > end) throw new Error(`timed out waiting for "${text}"; stderr: ${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { child, exited, waitFor, stderr: () => stderr, stdout: () => stdout };
}

/** A free port: bind 0, read it, release it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
  return port;
}

describe("spawned launcher (bin/marketmind-web.mjs)", () => {
  it("starts from outside the repository on 127.0.0.1, serves status without any upstream request", async () => {
    const port = await freePort();
    const p = launch({ MARKETMIND_WEB_PORT: String(port) });
    await p.waitFor("listening on");
    expect(p.stderr()).toContain(`listening on http://127.0.0.1:${port}; live request ceiling 2000, 60 per 5 min`);
    const r = await get(port, "/api/status");
    expect(r.status).toBe(200);
    expect(WebStatusOutput.parse(r.json()).budget.process).toEqual({ limit: 2_000, used: 0, remaining: 2_000 });
    expect(p.stderr()).not.toContain("[forbidNetwork]");
    expect(p.stdout()).toBe("");
  }, 30_000);

  it("fails clearly when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const p = launch({ MARKETMIND_WEB_PORT: String(port) });
      expect(await p.exited).toBe(1);
      expect(p.stderr()).toContain(`startup failed: port ${port} is already in use`);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  }, 30_000);

  it("refuses invalid configuration at startup", async () => {
    const p = launch({ MARKETMIND_WEB_DEV_ORIGIN: "*" });
    expect(await p.exited).toBe(1);
    expect(p.stderr()).toContain("startup failed: Invalid MARKETMIND_WEB_DEV_ORIGIN");
  }, 30_000);
});
