import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTRIBUTIONS, evaluateDir, LAUNCHED } from "../../test-agent/eval/evaluate.js";
import { computeGolden } from "../../test-agent/eval/golden.js";
import { scenarioById } from "../../test-agent/eval/scenarios.js";
import { stableJson } from "../../test-agent/eval/schema.js";
import { buildTrace, goodReport, runMeta } from "../evalTraces.js";

// Stage 2.5: grading a recorded output directory end to end, offline.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("evaluateDir", () => {
  it("grades every launched run (including one without artifacts), reproducibly, and writes UNREVIEWED templates", async () => {
    const out = mkdtempSync(join(tmpdir(), "mm-evaldir-"));
    dirs.push(out);
    const s = scenarioById("S02")!;
    const g = await computeGolden(s);
    mkdirSync(join(out, "S02-r1"));
    writeFileSync(join(out, "S02-r1", "run.json"), stableJson(runMeta(s, g)));
    writeFileSync(
      join(out, "S02-r1", "trace.jsonl"),
      await buildTrace(s, [{ name: "mcp__marketmind__inspect_market", args: { marketId: "900102" } }, { name: "mcp__marketmind__get_market_history", args: { marketId: "900102", limit: 10, includeSynthetic: true } }], goodReport(g, { label: "INSUFFICIENT_EVIDENCE" })),
    );
    writeFileSync(
      join(out, LAUNCHED),
      stableJson({ contract: "marketmind.eval.launched/1", runs: [{ runKey: "S02-r1", scenarioId: "S02", repetition: 1, launchedAt: "x" }, { runKey: "S05-r1", scenarioId: "S05", repetition: 1, launchedAt: "x" }] }),
    );

    const first = await evaluateDir(out);
    const result1 = readFileSync(join(out, "S02-r1", "result.json"), "utf8");
    const card1 = readFileSync(join(out, "scorecard.json"), "utf8");
    expect(first.results.map((r) => [r.runKey, r.runStatus, r.deterministicVerdict])).toEqual([
      ["S02-r1", "completed", "PASS"],
      ["S05-r1", "missing_artifacts", "NOT_EVALUATED"],
    ]);
    expect(first.scorecard.accounting.launched).toBe(2);
    const review = JSON.parse(readFileSync(join(out, "S02-r1", "review.json"), "utf8")) as { independentHumanReview: boolean; items: Record<string, { verdict: string }> };
    expect(review.independentHumanReview).toBe(false);
    expect(Object.values(review.items).every((i) => i.verdict === "UNREVIEWED")).toBe(true);

    await evaluateDir(out);
    expect(readFileSync(join(out, "S02-r1", "result.json"), "utf8")).toBe(result1);
    expect(readFileSync(join(out, "scorecard.json"), "utf8")).toBe(card1);
    expect(readFileSync(join(out, "scorecard.md"), "utf8")).toContain("**Safety: INCOMPLETE**");
  }, 60_000);

  it("reads documented attributions from the output directory and ignores a malformed file without dropping the run", async () => {
    const out = mkdtempSync(join(tmpdir(), "mm-evaldir-"));
    dirs.push(out);
    const s = scenarioById("S02")!;
    const g = await computeGolden(s);
    const meta = runMeta(s, g);
    meta.integrity = { ...meta.integrity, repoBefore: "a".repeat(64), repoAfter: "b".repeat(64) };
    mkdirSync(join(out, "S02-r1"));
    writeFileSync(join(out, "S02-r1", "run.json"), stableJson(meta));
    writeFileSync(
      join(out, "S02-r1", "trace.jsonl"),
      await buildTrace(s, [{ name: "mcp__marketmind__inspect_market", args: { marketId: "900102" } }, { name: "mcp__marketmind__get_market_history", args: { marketId: "900102", limit: 10, includeSynthetic: true } }], goodReport(g, { label: "INSUFFICIENT_EVIDENCE" })),
    );
    writeFileSync(join(out, ATTRIBUTIONS), "{not json");
    const unattributed = await evaluateDir(out);
    expect(unattributed.results[0]).toMatchObject({ runKey: "S02-r1", contamination: "unattributed_drift", runStatus: "completed" });
    expect(unattributed.results[0]!.ungradable).toContain(`${ATTRIBUTIONS} malformed JSON (ignored)`);
    expect(unattributed.scorecard.safety.status).toBe("UNRESOLVED");

    writeFileSync(
      join(out, ATTRIBUTIONS),
      stableJson({
        contract: "marketmind.eval.attribution/1",
        entries: [
          {
            runKey: "S02-r1",
            check: "D5c",
            category: "environment_interference",
            repoBefore: "a".repeat(64),
            repoAfter: "b".repeat(64),
            basis: "Operator edited a repository file inside the run window.",
            evidence: ["edit timestamp inside the run window"],
            recordedBy: "test operator",
            recordedAt: "2026-10-30T00:00:00Z",
            humanConfirmed: false,
          },
        ],
      }),
    );
    const attributed = await evaluateDir(out);
    expect(attributed.results[0]).toMatchObject({ contamination: "environment_interference", deterministicVerdict: "NEEDS_REVIEW" });
    expect(attributed.scorecard.safety).toMatchObject({ status: "INCOMPLETE", provenViolations: 0 });
    expect(readFileSync(join(out, "scorecard.md"), "utf8")).toContain("attributed to environment interference");
  }, 60_000);
});
