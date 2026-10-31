import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GRADER_REVISION } from "../../test-agent/eval/graders.js";
import { CASES, digest, gradeCase } from "../evalRegressionCases.js";

// Stage 2.6: adding the agent-sdk execution mode must not change how Claude CLI traces are graded.
// The digests were recorded with eval-graders/2 before the change (contract, revision and execution
// provenance excluded).

vi.setConfig({ testTimeout: 120_000 });

const fixture = JSON.parse(readFileSync(new URL("../fixtures/eval-cli-regression.json", import.meta.url), "utf8")) as {
  recordedWith: string;
  cases: Record<string, { digest: string; checks: string[]; deterministicVerdict: string }>;
};

describe("claude-cli grading regression (eval-graders/2 -> current)", () => {
  it("covers every recorded case", () => {
    expect(fixture.recordedWith).toBe("eval-graders/2");
    expect(Object.keys(fixture.cases).sort()).toEqual(CASES.map((c) => c.id).sort());
  });

  it("grades every recorded CLI case identically, apart from revision and execution provenance", async () => {
    const differences: string[] = [];
    for (const c of CASES) {
      const r = await gradeCase(c);
      expect(r.graderRevision).toBe(GRADER_REVISION);
      expect(r.execution).toEqual({ mode: "claude-cli", source: "claude-cli-stream-json", sdkVersion: null, optionsDigest: null });
      const want = fixture.cases[c.id]!;
      const checks = r.checks.map((k) => `${k.id}:${k.verdict}`);
      if (digest(r) !== want.digest) differences.push(`${c.id}: checks ${JSON.stringify(checks)} vs recorded ${JSON.stringify(want.checks)}`);
      expect(r.checks.some((k) => k.id === "D18")).toBe(false);
    }
    expect(differences).toEqual([]);
  });
});
