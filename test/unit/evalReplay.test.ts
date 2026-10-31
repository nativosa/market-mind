import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../../src/config/config.js";
import { BASELINE_MANIFEST, BaselineManifest, baselineDir, buildManifest, fileProblems, readBaselineManifest, regradeProblems } from "../../test-agent/eval/baselineArchive.js";
import { computeGolden, openGolden, type GoldenSession } from "../../test-agent/eval/golden.js";
import { gradeRun } from "../../test-agent/eval/graders.js";
import { compareReplay, summarizeReplay, type Answer } from "../../test-agent/eval/replay.js";
import { scenarioById, type EvalScenario } from "../../test-agent/eval/scenarios.js";
import type { EvalResult } from "../../test-agent/eval/schema.js";
import { buildTrace, goodReport, runMeta, type PlannedCall } from "../evalTraces.js";

// eval-graders/4: D9 sets aside only the envelope appVersion (server provenance). Substance, contracts,
// analytics versions and nested database appVersion values are still compared; incomplete or
// incompatible historical evidence is never counted as identical.

vi.setConfig({ testTimeout: 120_000 });

const HISTORICAL = "0.5.0";
const clone = <T>(v: T): T => structuredClone(v);
type Json = Record<string, unknown>;
/** Applies fn to the first nested (depth >= 1) object holding `key` whose value passes `when`. */
function mutateNested(root: unknown, key: string, fn: (v: unknown) => unknown, when: (v: unknown) => boolean = () => true): boolean {
  const walk = (v: unknown, depth: number): boolean => {
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    if (!v || typeof v !== "object") return false;
    const o = v as Json;
    if (depth >= 1 && key in o && when(o[key])) {
      o[key] = fn(o[key]);
      return true;
    }
    return Object.values(o).some((x) => walk(x, depth + 1));
  };
  return walk(root, 0);
}
const asVersion = (a: Answer, version: string): Answer => ({ ...a, json: { ...(a.json as Json), appVersion: version } });

let session: GoldenSession;
let inspect: Answer;
let history: Answer;
let notFound: Answer;
let runs: Answer;
const S03 = scenarioById("S03")!;

beforeAll(async () => {
  session = await openGolden(S03.db);
  inspect = await session.replay("inspect_market", { marketId: S03.marketId });
  history = await session.replay("get_market_history", { marketId: S03.marketId, limit: 10 });
  runs = await session.replay("list_collection_runs", {});
  notFound = await session.replay("get_observation_details", { observationId: 987654 });
});
afterAll(async () => {
  await session.close();
});

describe("compareReplay", () => {
  it("fixtures are what the cases assume", () => {
    expect(inspect.status).toBe("ok");
    expect((inspect.json as Json).appVersion).toBe(APP_VERSION);
    expect(history.status).toBe("ok");
    expect(notFound.status).toBe("error");
    expect(APP_VERSION).not.toBe(HISTORICAL);
  });

  it("same version and substance: identical", () => {
    expect(compareReplay(inspect, clone(inspect))).toMatchObject({ outcome: "identical", recordedAppVersion: APP_VERSION, replayAppVersion: APP_VERSION });
    expect(compareReplay(notFound, clone(notFound)).outcome).toBe("identical");
  });

  it("1. same substance, different envelope appVersion: identical apart from appVersion, both versions recorded", () => {
    for (const a of [inspect, history]) {
      const c = compareReplay(asVersion(a, HISTORICAL), a);
      expect(c).toEqual({ outcome: "identical_apart_from_app_version", recordedAppVersion: HISTORICAL, replayAppVersion: APP_VERSION, reason: null });
    }
    const s = summarizeReplay([{ key: "inspect", comparison: compareReplay(asVersion(inspect, HISTORICAL), inspect) }]);
    expect(s.verdict).toBe("PASS");
    expect(s.detail).toContain(`recorded appVersion ${HISTORICAL}, replay appVersion ${APP_VERSION}`);
    expect(s.detail).toContain("assumption:");
  });

  it("2. same appVersion, altered market result: mismatch and FAIL", () => {
    const altered = clone(inspect);
    expect(mutateNested(altered.json, "bestBid", () => "0.0101", (v) => typeof v === "string")).toBe(true);
    expect(compareReplay(altered, inspect)).toMatchObject({ outcome: "mismatch", reason: "substantive result differs" });
    // An appVersion difference does not hide a substantive change.
    const both = asVersion(altered, HISTORICAL);
    expect(compareReplay(both, inspect).outcome).toBe("mismatch");
    expect(summarizeReplay([{ key: "inspect", comparison: compareReplay(both, inspect) }]).verdict).toBe("FAIL");
  });

  it("2b. nested appVersion values come from the database and are still compared", () => {
    expect(runs.status).toBe("ok");
    const altered = clone(runs);
    expect(mutateNested(altered.json, "appVersion", () => "9.9.9")).toBe(true);
    expect(compareReplay(altered, runs).outcome).toBe("mismatch");
    expect(compareReplay(asVersion(altered, HISTORICAL), runs).outcome).toBe("mismatch");
    expect(compareReplay(asVersion(runs, HISTORICAL), runs).outcome).toBe("identical_apart_from_app_version");
  });

  it("2c. a recorded error where the replay succeeds (or the reverse) is a mismatch", () => {
    expect(compareReplay(notFound, inspect).outcome).toBe("mismatch");
    expect(compareReplay(inspect, notFound).outcome).toBe("mismatch");
    const otherError = clone(notFound);
    (otherError.json as { error: { message: string } }).error.message = "something else";
    expect(compareReplay(otherError, notFound).outcome).toBe("mismatch");
  });

  it("3. a different tool contract or analytics version is incompatible, not a pass", () => {
    const contract = asVersion({ ...inspect, json: { ...(inspect.json as Json), contract: "marketmind.inspect_market/2" } }, HISTORICAL);
    expect(compareReplay(contract, inspect)).toMatchObject({ outcome: "incompatible", reason: expect.stringContaining("marketmind.inspect_market/2") as unknown });
    const analytics = clone(history);
    expect(mutateNested(analytics.json, "analyticsVersion", () => 2)).toBe(true);
    expect(compareReplay(analytics, history)).toMatchObject({ outcome: "incompatible", reason: expect.stringContaining("analyticsVersion") as unknown });
    const s = summarizeReplay([
      { key: "a", comparison: compareReplay(asVersion(inspect, HISTORICAL), inspect) },
      { key: "b", comparison: compareReplay(analytics, history) },
    ]);
    expect(s.verdict).toBe("NOT_EVALUATED");
    expect(s.detail).toContain("1 incompatible");
    expect(s.evidence).toEqual([expect.stringMatching(/^incompatible: b: analyticsVersion/)]);
    expect(compareReplay(inspect, { status: "ok", json: null }).outcome).toBe("incompatible");
  });

  it("4. corrupted or incomplete historical evidence is never counted as identical", () => {
    const { appVersion: _drop, ...noVersion } = inspect.json as Json;
    const { contract: _drop2, ...noContract } = inspect.json as Json;
    const cases: Answer[] = [
      { status: "ok", json: null },
      { status: "ok", json: "not json" },
      { status: "ok", json: [inspect.json] },
      { status: "ok", json: noVersion },
      { status: "ok", json: noContract },
      { status: "error", json: { error: "plain text" } },
      { status: "error", json: { contract: "other/1", error: {} } },
      { status: "missing", json: null },
    ];
    for (const c of cases) expect(compareReplay(c, inspect).outcome, JSON.stringify(c).slice(0, 60)).toBe("incomplete");
    const s = summarizeReplay(cases.map((c, i) => ({ key: `c${i}`, comparison: compareReplay(c, inspect) })));
    expect(s.verdict).toBe("NOT_EVALUATED");
    expect(s.detail).toMatch(/^0\/8 replayed results identical; 8 not comparable \(0 incompatible, 8 incomplete historical evidence\)/);
    // A real mismatch alongside incomplete evidence is still a FAIL.
    const altered = clone(inspect);
    mutateNested(altered.json, "bestBid", () => "0.0101", (v) => typeof v === "string");
    expect(summarizeReplay([{ key: "x", comparison: compareReplay(cases[0]!, inspect) }, { key: "y", comparison: compareReplay(altered, inspect) }]).verdict).toBe("FAIL");
  });

  it("same-version wording is unchanged from eval-graders/3; no calls stays NOT_EVALUATED", () => {
    expect(summarizeReplay([{ key: "a", comparison: compareReplay(inspect, inspect) }, { key: "b", comparison: compareReplay(history, history) }])).toEqual({ verdict: "PASS", detail: "2/2 replayed results identical", evidence: [] });
    expect(summarizeReplay([])).toEqual({ verdict: "NOT_EVALUATED", detail: "0/0 replayed results identical", evidence: [] });
  });
});

/** Grades a CLI trace whose MarketMind results were recorded by `version` (optionally altered). */
async function gradeRecordedBy(s: EvalScenario, version: string, alter?: (json: Json, tool: string) => void): Promise<EvalResult> {
  const g = await computeGolden(s);
  const live = await openGolden(s.db);
  const grading = await openGolden(s.db);
  try {
    const args = { marketId: s.marketId, limit: 10, ...(s.syntheticAuthorized ? { includeSynthetic: true } : {}) };
    const planned: [string, Json][] = s.mode === "B" ? [["scan_markets", { version: "v1" }], ["inspect_market", { marketId: g.marketId }], ["get_market_history", { ...args, marketId: g.marketId }]] : [["inspect_market", { marketId: s.marketId }], ["get_market_history", args]];
    const calls: PlannedCall[] = [];
    for (const [tool, a] of planned) {
      const r = await live.replay(tool, a);
      const json = clone(r.json) as Json;
      if (r.status === "ok") json.appVersion = version;
      alter?.(json, tool);
      calls.push({ name: `mcp__marketmind__${tool}`, args: a, result: { isError: r.status === "error", text: JSON.stringify(json) } });
    }
    const trace = await buildTrace(s, calls, goodReport(g, { label: s.labels.strict[0]! }));
    return await gradeRun({ scenario: s, runKey: `${s.id}-r1`, meta: runMeta(s, g), traceText: trace, review: null, golden: g, session: grading, attributions: [] });
  } finally {
    await live.close();
    await grading.close();
  }
}
const d9 = (r: EvalResult) => r.checks.find((c) => c.id === "D9")!;
const others = (r: EvalResult) => r.checks.filter((c) => c.id !== "D9").map((c) => `${c.id}:${c.verdict}:${c.detail}`);

describe("5. re-grading v0.5.0-recorded runs with the current application", () => {
  for (const id of ["S03", "S09", "S12"]) {
    it(`${id}: D9 passes with both versions stated; every other check equals same-version grading`, async () => {
      const s = scenarioById(id)!;
      const historical = await gradeRecordedBy(s, HISTORICAL);
      const current = await gradeRecordedBy(s, APP_VERSION);
      expect(d9(current)).toMatchObject({ verdict: "PASS", detail: expect.stringMatching(/^\d+\/\d+ replayed results identical$/) as unknown });
      expect(d9(historical).verdict).toBe("PASS");
      expect(d9(historical).detail).toContain(`recorded appVersion ${HISTORICAL}, replay appVersion ${APP_VERSION}`);
      expect(others(historical)).toEqual(others(current));
      expect(historical.deterministicVerdict).toBe(current.deterministicVerdict);
    });
  }

  it("a v0.5.0-recorded run whose market data was altered still fails D9", async () => {
    const r = await gradeRecordedBy(S03, HISTORICAL, (json, tool) => {
      if (tool === "inspect_market") mutateNested(json, "bestBid", () => "0.0101", (v) => typeof v === "string");
    });
    expect(d9(r).verdict).toBe("FAIL");
    expect(d9(r).evidence).toEqual([expect.stringContaining("inspect_market")]);
  });

  it("a v0.5.0-recorded run under a different tool contract is NOT_EVALUATED, not PASS", async () => {
    const r = await gradeRecordedBy(S03, HISTORICAL, (json, tool) => {
      if (tool === "get_market_history") json.contract = "marketmind.get_market_history/0";
    });
    expect(d9(r).verdict).toBe("NOT_EVALUATED");
    expect(d9(r).detail).toContain("1 incompatible");
  });

  // The preserved baseline stays out of Git (raw traces hold local paths and session ids). This runs when
  // the local archive exists (or MARKETMIND_BASELINE_DIR names one) and is skipped otherwise, never pointed
  // at a temporary directory; docs/evaluation-archive/README.md explains how to restore it.
  const baseline = baselineDir();
  it.skipIf(!existsSync(baseline))("the preserved v0.5.0 baseline re-grades to its recorded verdicts and is not written to", async () => {
    const manifest = readBaselineManifest();
    expect(fileProblems(baseline, manifest)).toEqual([]);
    const { evaluateDir } = await import("../../test-agent/eval/evaluate.js");
    await expect(evaluateDir(baseline)).rejects.toThrow("--output");
    expect(await regradeProblems(baseline, manifest)).toEqual([]);
    expect(fileProblems(baseline, manifest)).toEqual([]);
  });
});

describe("baseline manifest", () => {
  const manifest = readBaselineManifest();
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("is committed with the recorded 23 runs and metrics, and no local paths or raw content", () => {
    const text = readFileSync(BASELINE_MANIFEST, "utf8");
    expect(manifest).toMatchObject({ baseline: "v0.5.0", graderRevision: "eval-graders/2" });
    expect(manifest.files).toHaveLength(118);
    expect(manifest.runs).toHaveLength(23);
    expect(manifest.metrics).toMatchObject({ delegation: "22/22 = 100.0% (excluded 0)", authorizedToolUse: "57/57 = 100.0% (excluded 0)" });
    const golden = manifest.runs.filter((r) => !r.runKey.startsWith("P"));
    expect(golden.filter((r) => r.deterministicVerdict === "PASS")).toHaveLength(16);
    expect(golden.filter((r) => r.deterministicVerdict === "NEEDS_REVIEW")).toHaveLength(6);
    expect(text).not.toMatch(/[A-Za-z]:[\\/]|\/Users\/|\/home\/|session_id|sk-ant/);
  });

  it("detects a missing, an unexpected and a changed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-manifest-"));
    dirs.push(dir);
    mkdirSync(join(dir, "S01-r1"));
    writeFileSync(join(dir, "S01-r1", "result.json"), JSON.stringify({ runKey: "S01-r1", checks: [{ id: "D0", verdict: "PASS" }], deterministicVerdict: "PASS", overallVerdict: "NEEDS_REVIEW" }));
    writeFileSync(join(dir, "S01-r1", "trace.jsonl"), "{}\n");
    writeFileSync(join(dir, "scorecard.json"), JSON.stringify({ grader: { revision: "eval-graders/2" }, metrics: { completion: { text: "1/1" } } }));
    const m = buildManifest(dir, "x.tar.gz", "a".repeat(64));
    expect(BaselineManifest.safeParse(m).success).toBe(true);
    expect(m.files.map((f) => f.path)).toEqual(["S01-r1/result.json", "S01-r1/trace.jsonl", "scorecard.json"]);
    expect(m.runs).toEqual([{ runKey: "S01-r1", checks: ["D0:PASS"], deterministicVerdict: "PASS", overallVerdict: "NEEDS_REVIEW" }]);
    expect(fileProblems(dir, m)).toEqual([]);
    writeFileSync(join(dir, "S01-r1", "trace.jsonl"), "{ }\n");
    writeFileSync(join(dir, "extra.txt"), "x");
    rmSync(join(dir, "scorecard.json"));
    expect(fileProblems(dir, m).sort()).toEqual(["changed file S01-r1/trace.jsonl", "missing file scorecard.json", "unexpected file extra.txt"]);
    expect(fileProblems(join(dir, "absent"), m)[0]).toContain("does not exist");
  });
});
