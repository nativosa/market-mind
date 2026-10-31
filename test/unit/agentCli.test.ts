import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main, type Io } from "../../agent-sdk/cli.js";
import { REPO_ROOT } from "../../agent-sdk/investigator.js";
import { fakeQuery } from "../sdkFakes.js";

// Stage 2.6: the CLI entry point. --dry-run needs no credentials, never loads the SDK runtime, never
// spawns Claude Code and never calls the API; a real run without ANTHROPIC_API_KEY stops before anything.

vi.setConfig({ testTimeout: 60_000 });

function io(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env };
  return { io: value, out, err };
}
const neverLoad = () => vi.fn(() => Promise.reject(new Error("the SDK runtime must not be loaded")));

describe("agent CLI", () => {
  it("--dry-run without credentials prints the effective configuration and loads nothing", async () => {
    const t = io({ PATH: "/usr/bin" });
    const load = neverLoad();
    expect(await main(["investigate", "--market-id", "900103", "--fixture", "S03", "--dry-run"], t.io, load)).toBe(0);
    expect(load).not.toHaveBeenCalled();
    const report = JSON.parse(t.out.join("")) as Record<string, unknown> & { optionViolations: string[]; wouldSpawn: boolean; credentials: Record<string, string>; harness: { permissionMode: string; sdkVersion: string } };
    expect(report).toMatchObject({ contract: "marketmind.agent.dry-run/1", wouldSpawn: false, optionViolations: [], harness: { permissionMode: "dontAsk", sdkVersion: "0.3.302" }, options: { settings: { disableBundledSkills: true } } });
    expect(report.credentials.ANTHROPIC_API_KEY).toContain("not set");
  });

  it("--dry-run with a key never prints it", async () => {
    const t = io({ ANTHROPIC_API_KEY: "sk-ant-api03-DRYRUN-SENTINEL-000", PATH: "/usr/bin" });
    expect(await main(["investigate", "--discover", "--dry-run"], t.io, neverLoad())).toBe(0);
    expect(t.out.join("")).not.toContain("DRYRUN-SENTINEL");
    expect(t.out.join("")).toContain("set (value not shown)");
  });

  it("a real run without ANTHROPIC_API_KEY exits 2 before loading the SDK", async () => {
    const t = io({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "must-not-be-used" });
    const load = neverLoad();
    expect(await main(["investigate", "--market-id", "900103", "--max-budget-usd", "0.2"], t.io, load)).toBe(2);
    expect(load).not.toHaveBeenCalled();
    expect(t.err.join("")).toContain("ANTHROPIC_API_KEY is not set");
  });

  it("usage errors exit 2 with a message", async () => {
    const t = io({});
    expect(await main(["investigate", "--market-id", "x"], t.io, neverLoad())).toBe(2);
    expect(t.err.join("")).toContain("numeric Gamma id");
  });

  it("only cli.ts loads the SDK runtime (dynamically); every other module imports types only", () => {
    const dir = join(REPO_ROOT, "agent-sdk");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      const valueImports = src.split(/\r?\n/).filter((l) => /from "@anthropic-ai\/claude-agent-sdk"/.test(l) && !/^import type /.test(l));
      expect(valueImports, f).toEqual([]);
      if (f !== "cli.ts") expect(src.includes('import("@anthropic-ai/claude-agent-sdk")'), f).toBe(false);
    }
  });

  it("a real run (injected fake query) writes redacted artifacts and prints the --json result", async () => {
    const KEY = "sk-ant-api03-CLIRUN-SENTINEL-000000";
    const out = mkdtempSync(join(tmpdir(), "mm-cli-out-"));
    try {
      const t = io({ ANTHROPIC_API_KEY: KEY, PATH: process.env.PATH ?? process.env.Path ?? "" });
      const { query, state } = fakeQuery({ report: "# Market investigation: 900103\n\n## 7. Research classification\n- Label: INSUFFICIENT_EVIDENCE.\n" });
      const code = await main(["investigate", "--market-id", "900103", "--fixture", "S03", "--max-budget-usd", "0.2", "--json", "--out", out], t.io, () => Promise.resolve(query));
      expect(code).toBe(0);
      expect(state.options?.maxBudgetUsd).toBe(0.2);
      const result = JSON.parse(t.out.join("")) as { contract: string; status: string; report: { classification: string[] } };
      expect(result).toMatchObject({ contract: "marketmind.agent.investigation/1", status: "completed", report: { classification: ["INSUFFICIENT_EVIDENCE"] } });
      expect(readdirSync(out).sort()).toEqual(["execution.json", "investigation.json", "sdk-messages.jsonl", "stderr.txt"]);
      const written = readdirSync(out).map((f) => readFileSync(join(out, f), "utf8")).join("\n") + t.err.join("");
      expect(written).not.toContain(KEY);
      expect(written).not.toContain(homedir());
      expect(t.err.join("")).toContain("estimate, not billing");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("--out inside the repository but outside .eval-out/ is refused before anything runs", async () => {
    const t = io({ ANTHROPIC_API_KEY: "sk-ant-api03-X-000000000", PATH: "" });
    const load = neverLoad();
    expect(await main(["investigate", "--market-id", "900103", "--max-budget-usd", "0.2", "--out", join(REPO_ROOT, "docs", "x")], t.io, load)).toBe(2);
    expect(load).not.toHaveBeenCalled();
    expect(t.err.join("")).toContain(".eval-out");
  });

  it("npm run agent -- investigate --market-id 900103 --fixture S03 --dry-run works in a clean environment", () => {
    const env: Record<string, string> = {};
    for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "PATHEXT", "COMSPEC", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME"]) if (process.env[k]) env[k] = process.env[k];
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO_ROOT, "agent-sdk", "cli.ts"), "investigate", "--market-id", "900103", "--fixture", "S03", "--dry-run"], { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    expect((JSON.parse(out) as { note: string }).note).toContain("no API request was made");
    for (const p of [REPO_ROOT, homedir(), tmpdir()]) {
      expect(out).not.toContain(p);
      expect(out).not.toContain(JSON.stringify(p).slice(1, -1));
    }
  });
});
