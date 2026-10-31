import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { realDeps } from "../../agent-sdk/cli.js";
import { parseArgs } from "../../agent-sdk/args.js";
import { loadInvestigator } from "../../agent-sdk/investigator.js";
import { runInvestigation } from "../../agent-sdk/session.js";
import { processesTagged } from "../../test-agent/processes.js";
import { fakeQuery } from "../sdkFakes.js";

// Stage 2.6: cleanup with REAL child processes on this platform (Windows: taskkill /T, CIM process
// search). The "CLI" here is a plain Node script, not Claude Code, so nothing is billed.

vi.setConfig({ testTimeout: 120_000 });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const investigator = loadInvestigator();
const request = parseArgs(["investigate", "--market-id", "900103", "--fixture", "S03", "--max-budget-usd", "0.25"]).request;

async function session(childScript: string, tag: string, pauseMs = 0) {
  let pid: number | undefined;
  const { query } = fakeQuery({ spawn: true, spawnCommand: { command: process.execPath, args: ["-e", childScript, "--", `--sdk-tag=${tag}`] }, report: "# Market investigation: 900103\n", pauseMs });
  const deps = realDeps({ stdout: () => {}, stderr: () => {}, env: { ANTHROPIC_API_KEY: "sk-ant-api03-CLEANUP-TEST-0000", PATH: process.env.PATH ?? process.env.Path ?? "" } }, query);
  const spawn = (o: Parameters<typeof deps.spawn>[0]) => deps.spawn(o);
  const outcome = await runInvestigation(
    { investigator, request, maxBudgetUsd: 0.25, timeoutMs: 30_000, cleanupMs: 3_000 },
    {
      ...deps,
      tag: () => tag,
      spawn: (o) => {
        const c = spawn(o);
        pid = c.pid;
        return c;
      },
      onProgress: () => {},
    },
  );
  return { outcome, pid: pid! };
}

describe("process cleanup (real processes)", () => {
  it("a CLI child that keeps running is killed with its tree and the temp directories are removed", async () => {
    const tag = `mm-sdk-cleanup-${randomUUID()}`;
    const { outcome, pid } = await session("setInterval(() => {}, 1000)", tag, 1_000);
    expect(pid).toBeGreaterThan(0);
    expect(outcome.stderr).not.toContain("bad option");
    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.cleanup).toMatchObject({ closeCalled: true, childExited: true, tempRemoved: true, problems: [] });
    expect(alive(pid)).toBe(false);
    expect(processesTagged(tag)).toEqual([]);
  });

  it("an orphaned server left behind by an exited child is found by tag and killed", async () => {
    const tag = `mm-sdk-orphan-${randomUUID()}`;
    // The child starts a detached grandchild carrying the tag, then exits: the grandchild is an orphan.
    const script = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--sdk-tag=${tag}"], { detached: true, stdio: "ignore" }); g.unref(); setTimeout(() => process.exit(0), 300);`;
    const { outcome, pid } = await session(script, tag, 2_000);
    expect(alive(pid)).toBe(false);
    expect(outcome.result.cleanup.orphansFound).toBeGreaterThanOrEqual(1);
    expect(outcome.result.cleanup.orphansKilled).toBe(outcome.result.cleanup.orphansFound);
    expect(outcome.result.status).toBe("completed");
    expect(processesTagged(tag)).toEqual([]);
  });
});
