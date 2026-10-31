import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateDir } from "../../test-agent/eval/evaluate.js";
import { differencesBetween, readBaselineDeltas, readBatch3Deltas, RegradeDeltas, regradeDrift, type Delta } from "../../test-agent/eval/baselineArchive.js";
import { computeGolden, openGolden } from "../../test-agent/eval/golden.js";
import { GRADER_CHANGES, GRADER_REVISION, gradeRun, locate } from "../../test-agent/eval/graders.js";
import { parseReport } from "../../test-agent/eval/report.js";
import { scenarioById } from "../../test-agent/eval/scenarios.js";
import { buildTrace, runMeta } from "../evalTraces.js";

// eval-graders/7: D13b reads outcome lead-ins closing with the index, and an outcome block no longer lets the
// first match hide a quoted, rejected or conflicting value. Regrades may differ from the record only as declared.

vi.setConfig({ testTimeout: 120_000 });

const fixture = JSON.parse(readFileSync(new URL("../fixtures/reliability-v0.7.0-excerpts.json", import.meta.url), "utf8")) as { reports: Record<string, { report: string }> };
const S09_REPORT = fixture.reports.S09!.report;
const YES = { index: 0, label: "Yes" };
const NO = { index: 1, label: "No" };
const OUTS = [YES, NO];
const report = (section3: string, rest = "") => parseReport(`# Market investigation: 900102\n\n## 3. Current book observations\n${section3}\n\n## 4. Historical evidence\n${rest}\n`);
const at = (r: ReturnType<typeof report>, metric: "spread" | "bid" | "ask" | "midpoint", o = YES) => locate(r, metric, o, OUTS);
const S09_STYLE = (yes: string, no = "- Spread 0.04.") => `Yes (index 0, reference). [FACT E2]\n${yes}\n\nNo (index 1). [FACT E2]\n${no}\n\nOther facts:\n- Pair skew is 10 ms.`;

describe("D13b lead-in forms", () => {
  it("reads the exact S09 report: every value of both outcomes", () => {
    const r = parseReport(S09_REPORT);
    expect(at(r, "spread")).toMatchObject({ value: "0.04", how: "outcome block" });
    expect(at(r, "bid")).toMatchObject({ value: "0.47", size: "400" });
    expect(at(r, "ask")).toMatchObject({ value: "0.51", size: "400" });
    expect(at(r, "bid", NO)).toMatchObject({ value: "0.49", size: "400" });
    expect(at(r, "ask", NO)).toMatchObject({ value: "0.53", size: "400" });
    expect(at(r, "spread", NO)).toMatchObject({ value: "0.04" });
  });

  it.each([
    ["no period", "Yes (index 0, reference) [FACT E2]"],
    ["no tag", "Yes (index 0)."],
    ["bare", "Yes (index 0)"],
    ["other wording in the parenthesis", "Yes (index 0, the reference outcome). [FACT E1]"],
    ["case", "yes (Index 0). [FACT E1]"],
  ])("accepts the lead-in with %s", (_name, lead) => {
    expect(at(report(`${lead}\n- Spread 0.04.\n\nNo (index 1).\n- Spread 0.09.`), "spread")).toMatchObject({ value: "0.04" });
  });

  it("the historical S12-r1 form keeps working", () => {
    const r = report("Eligibility [FACT E1]:\n- Active: true.\n\nYes (index 0, the reference outcome) [FACT E1]:\n- Best bid 0.47 with size 400. Best ask 0.51 with size 400.\n- Spread 0.04. Midpoint 0.49.\n\nNo (index 1) [FACT E1]:\n- Spread 0.04. Midpoint 0.51.\n\nPairing:\n- Skew 10.");
    expect(at(r, "spread")).toMatchObject({ value: "0.04" });
    expect(at(r, "bid")).toMatchObject({ value: "0.47", size: "400" });
    expect(at(r, "midpoint", NO)).toMatchObject({ value: "0.51" });
  });

  it("the existing bold and table forms keep working", () => {
    const bold = report("**Yes (reference, index 0)**\n- Best bid 0.47 with size 400.\n- Spread 0.04.\n\n**No (index 1)**\n- Spread 0.05.\n\n**Pairing**\n- Skew.");
    expect(at(bold, "spread")).toMatchObject({ value: "0.04" });
    expect(at(bold, "spread", NO)).toMatchObject({ value: "0.05" });
    const heading = report("### Yes (index 0)\n- Spread 0.04.\n\n### No (index 1)\n- Spread 0.05.");
    expect(at(heading, "spread", NO)).toMatchObject({ value: "0.05" });
    const table = report("| | Yes (index 0) | No (index 1) |\n|---|---|---|\n| Spread | 0.04 | 0.05 |\n| Best bid (size) | 0.47 (400) | 0.49 (400) |");
    expect(at(table, "spread", NO)).toMatchObject({ value: "0.05", how: 'table row "Spread"' });
    expect(at(table, "bid")).toMatchObject({ value: "0.47", size: "400" });
  });

  it("keeps each value with its outcome", () => {
    const r = report(S09_STYLE("- Spread 0.04.", "- Spread 0.07."));
    expect(at(r, "spread")).toMatchObject({ value: "0.04" });
    expect(at(r, "spread", NO)).toMatchObject({ value: "0.07" });
  });

  it.each([
    ["a sentence about the outcome", "The reference outcome is Yes (index 0).\n- Spread 0.04."],
    ["a bullet", "- Yes (index 0).\n- Spread 0.04."],
    ["another market's outcome", "Maybe (index 0).\n- Spread 0.04."],
    ["text after the parenthesis", "Yes (index 0) was checked first.\n- Spread 0.04."],
  ])("does not read %s as a block", (_name, body) => {
    expect(at(report(body), "spread")).toBeNull();
  });

  it("a block ends at the next lead-in, so the other outcome's value is not used", () => {
    expect(at(report("Yes (index 0). [FACT E2]\n- Quality valid.\n\nNo (index 1). [FACT E2]\n- Spread 0.04."), "spread")).toBeNull();
  });
});

describe("D13b context", () => {
  it("the same number elsewhere does not support the claim", () => {
    const r = report(S09_STYLE("- Quality valid.", "- Quality valid.").concat("\n- The spread 0.04 is mentioned here."), "- Spread 0.04, spread 0.04.");
    expect(at(r, "spread")).toBeNull();
    expect(at(r, "spread", NO)).toBeNull();
  });

  it("a missing value is not inferred from bid and ask", () => {
    expect(at(report(S09_STYLE("- Best bid 0.47 (size 400) and best ask 0.51 (size 400).")), "spread")).toBeNull();
  });

  it("a wrong value is located as written, so the assertion can fail", () => {
    expect(at(report(S09_STYLE("- Spread 0.05.")), "spread")).toMatchObject({ value: "0.05" });
  });

  it("conflicting values are not asserted; repeating one value is", () => {
    expect(at(report(S09_STYLE("- Spread 0.04.\n- Spread 0.05.")), "spread")).toBeNull();
    expect(at(report(S09_STYLE("- Spread 0.04, and the spread is 0.05.")), "spread")).toBeNull();
    expect(at(report(S09_STYLE("- Spread 0.04.\n- Spread is 0.040.")), "spread")).toMatchObject({ value: "0.04" });
    expect(at(report(S09_STYLE("- Spread 0.04.\n- Spread null.")), "spread")).toBeNull();
    expect(at(report(S09_STYLE("- Spread null.\n- Spread 0.04.")), "spread")).toBeNull();
    expect(at(report(S09_STYLE("- Spread null.\n- Spread none.")), "spread")).toMatchObject({ value: null });
  });

  it("the same conflict rule covers the existing block forms", () => {
    expect(at(report("**Yes (index 0)**\n- Spread 0.04.\n- Spread 0.05.\n\n**No (index 1)**\n- Spread 0.04."), "spread")).toBeNull();
  });

  it("a measure in ticks is not a price", () => {
    expect(at(report(S09_STYLE("- Spread 0.04.\n- Spread of 40 ticks.")), "spread")).toMatchObject({ value: "0.04" });
  });

  it.each([
    ["inline code", "- The text says `the spread 0.09 is a bargain right now`."],
    ["double quotes", '- It says "the spread 0.09 is a bargain".'],
    ["rejected after", "- The claimed spread 0.09 is unsupported."],
    ["rejected before", "- I rejected the spread 0.09."],
  ])("a quoted or rejected value is not an assertion: %s", (_name, line) => {
    expect(at(report(S09_STYLE(`${line}\n- Spread 0.04.`)), "spread")).toMatchObject({ value: "0.04" });
    expect(at(report(S09_STYLE(line)), "spread")).toBeNull();
  });

  it("a value in backticks alone is still the author's", () => {
    expect(at(report(S09_STYLE("- Spread `0.04`.")), "spread")).toMatchObject({ value: "0.04" });
  });

  it("a negated value is not read", () => {
    expect(at(report(S09_STYLE("- Spread is not 0.09.")), "spread")).toBeNull();
  });
});

describe("D13b through the grader", () => {
  const S09 = scenarioById("S09")!;
  const mm = (t: string, args: Record<string, unknown>) => ({ name: `mcp__marketmind__${t}`, args });
  const calls = [mm("scan_markets", { version: "v1" }), mm("inspect_market", { marketId: "900102" }), mm("get_market_history", { marketId: "900102", limit: 10, includeSynthetic: true })];
  async function grade(text: string) {
    const g = await computeGolden(S09);
    const session = await openGolden(S09.db);
    try {
      const r = await gradeRun({ scenario: S09, runKey: "S09-r1", meta: runMeta(S09, g), traceText: await buildTrace(S09, calls, text), review: null, golden: g, session });
      return { d13b: r.checks.find((c) => c.id === "D13b")!, assertions: r.facts.assertions };
    } finally {
      await session.close();
    }
  }

  it("the v0.7.0 S09 report: the spread is located and matches", async () => {
    const { d13b, assertions } = await grade(S09_REPORT);
    expect(d13b.verdict).toBe("PASS");
    expect(d13b.detail).toBe("11 matched, 0 contradicted, 0 not located");
    expect(assertions.find((a) => a.id === "spread[0]")).toEqual({ id: "spread[0]", expected: "0.04", found: "0.04", verdict: "PASS" });
  });

  it("a wrong value in that report fails D13b", async () => {
    const { d13b } = await grade(S09_REPORT.replace("- Spread 0.04, tickSize 0.001.", "- Spread 0.05, tickSize 0.001."));
    expect(d13b.verdict).toBe("FAIL");
    expect(d13b.evidence).toContain("spread[0]: expected 0.04 found 0.05");
  });

  it("a removed value goes back to review, and the answer is not taken from elsewhere", async () => {
    const { d13b } = await grade(S09_REPORT.replace("- Spread 0.04, tickSize 0.001.", "- tickSize 0.001."));
    expect(d13b.verdict).toBe("NEEDS_REVIEW");
    expect(d13b.evidence).toContain("spread[0]: expected 0.04 found null");
  });

  it("a conflict in that report goes to review rather than passing on the first value", async () => {
    const { d13b } = await grade(S09_REPORT.replace("- Spread 0.04, tickSize 0.001.", "- Spread 0.04, tickSize 0.001.\n- Spread 0.05."));
    expect(d13b.verdict).toBe("NEEDS_REVIEW");
  });

  it("the changelog says a located value is not evidence of improvement", () => {
    expect(GRADER_REVISION).toBe("eval-graders/7");
    expect(GRADER_CHANGES[0]).toContain("not evidence that the investigator improved");
  });
});

describe("regrade deltas", () => {
  const REASON = "A parser correction located a value that was already in the recorded report.";
  const deltas = (list: Delta[] = [], over: Partial<RegradeDeltas> = {}): RegradeDeltas => ({ contract: "marketmind.eval.regrade-deltas/1", recorded: "test", graderRevision: GRADER_REVISION, note: "test", deltas: list, ...over });
  const run = (over: Record<string, unknown> = {}) => ({ runKey: "S09-r1", contract: "old", graderRevision: "old", deterministicVerdict: "NEEDS_REVIEW", overallVerdict: "NEEDS_REVIEW", failureCategories: ["review"], classification: { stated: ["INSUFFICIENT_EVIDENCE"] }, checks: [{ id: "D13b", verdict: "NEEDS_REVIEW", detail: "a" }, { id: "D9", verdict: "PASS", detail: "recorded 0.5.0" }, { id: "D2", verdict: "PASS", detail: "b" }], ...over });
  const same = (a: unknown, b: unknown, d = deltas()) => regradeDrift({ recorded: new Map([["S09-r1", a]]), regraded: new Map([["S09-r1", b]]) }, d);
  const verdict: Delta = { scope: "run", runKey: "S09-r1", field: ".deterministicVerdict", from: "NEEDS_REVIEW", to: "PASS", reason: REASON };

  it("identical results and provenance-only differences pass", () => {
    expect(same(run(), run())).toEqual([]);
    expect(same(run(), run({ contract: "new", graderRevision: "new", reliability: { rules: [] }, rubricSet: "x", execution: { mode: "claude-cli" } }))).toEqual([]);
    expect(same(run(), run({ checks: [{ id: "D13b", verdict: "NEEDS_REVIEW", detail: "a" }, { id: "D9", verdict: "PASS", detail: "recorded 0.5.0, replay 0.7.0" }, { id: "D2", verdict: "PASS", detail: "b" }] }))).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a deterministic verdict", { deterministicVerdict: "PASS" }, ".deterministicVerdict"],
    ["an overall verdict", { overallVerdict: "FAIL" }, ".overallVerdict"],
    ["a failure category", { failureCategories: ["agent_safety"] }, ".failureCategories"],
    ["a classification", { classification: { stated: ["WEAK_OR_MISLEADING_SIGNAL"] } }, ".classification.stated"],
    ["a safety check", { checks: [{ id: "D13b", verdict: "NEEDS_REVIEW", detail: "a" }, { id: "D9", verdict: "PASS", detail: "recorded 0.5.0" }, { id: "D2", verdict: "FAIL", detail: "b" }] }, ".checks[D2].verdict"],
    ["D9's verdict, though its detail is not compared", { checks: [{ id: "D13b", verdict: "NEEDS_REVIEW", detail: "a" }, { id: "D9", verdict: "FAIL", detail: "recorded 0.5.0" }, { id: "D2", verdict: "PASS", detail: "b" }] }, ".checks[D9].verdict"],
    ["a removed check", { checks: [{ id: "D13b", verdict: "NEEDS_REVIEW", detail: "a" }, { id: "D9", verdict: "PASS", detail: "recorded 0.5.0" }] }, ".checks[D2]"],
    ["an added check", { checks: [{ id: "D13b", verdict: "NEEDS_REVIEW", detail: "a" }, { id: "D9", verdict: "PASS", detail: "recorded 0.5.0" }, { id: "D2", verdict: "PASS", detail: "b" }, { id: "D99", verdict: "PASS", detail: "c" }] }, ".checks[D99]"],
    ["a new field", { surprise: 1 }, ".surprise"],
  ])("rejects an undeclared change to %s", (_name, over, field) => {
    const problems = same(run(), run(over));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`undeclared difference: S09-r1 ${field}`);
  });

  it("accepts a declared difference with its exact values, and nothing looser", () => {
    expect(same(run(), run({ deterministicVerdict: "PASS" }), deltas([verdict]))).toEqual([]);
    expect(same(run(), run({ deterministicVerdict: "FAIL" }), deltas([verdict]))[0]).toContain("undeclared difference");
    expect(same(run({ deterministicVerdict: "FAIL" }), run({ deterministicVerdict: "PASS" }), deltas([verdict]))[0]).toContain("undeclared difference");
    expect(same(run(), run({ deterministicVerdict: "PASS", overallVerdict: "PASS" }), deltas([verdict]))).toHaveLength(1);
    expect(regradeDrift({ recorded: new Map([["S01-r1", run()]]), regraded: new Map([["S01-r1", run({ deterministicVerdict: "PASS" })]]) }, deltas([verdict]))[0]).toContain("undeclared difference: S01-r1");
  });

  it("key order inside a declared value does not matter", () => {
    const delta: Delta = { scope: "run", runKey: "S09-r1", field: ".added", from: null, to: { a: 1, b: 2 }, reason: REASON };
    expect(same(run(), run({ added: { b: 2, a: 1 } }), deltas([delta]))).toEqual([]);
  });

  it("rejects a declared difference that did not occur", () => {
    expect(same(run(), run(), deltas([verdict]))).toEqual(["declared difference did not occur: S09-r1 .deterministicVerdict"]);
  });

  it("rejects a delta file for another grader revision, and missing or extra runs", () => {
    expect(same(run(), run(), deltas([], { graderRevision: "eval-graders/6" }))[0]).toContain("the delta file is for eval-graders/6");
    expect(regradeDrift({ recorded: new Map([["a", 1]]), regraded: new Map() }, deltas())).toEqual(["a: not regraded"]);
    expect(regradeDrift({ recorded: new Map(), regraded: new Map([["b", 1]]) }, deltas())).toEqual(["b: regraded but not recorded"]);
  });

  it("compares the scorecard's reported figures", () => {
    const view = (text: string) => ({ metrics: { completion: text }, accounting: { deterministic: {}, overall: {}, runStatus: {}, contamination: {}, reviews: {} }, safety: { status: "PASS", provenViolations: 0 }, assertionsRequiringReview: [] });
    const c = { recorded: new Map(), regraded: new Map() };
    expect(regradeDrift({ ...c, scorecards: { recorded: view("1/1"), regraded: view("1/1") } }, deltas())).toEqual([]);
    expect(regradeDrift({ ...c, scorecards: { recorded: view("1/1"), regraded: view("0/1") } }, deltas())[0]).toContain("undeclared difference: scorecard .metrics.completion");
  });

  it("the delta contract refuses wildcards, missing reasons and unknown fields", () => {
    const parse = (d: unknown) => RegradeDeltas.safeParse(deltas([d as Delta])).success;
    expect(parse(verdict)).toBe(true);
    expect(parse({ ...verdict, field: ".checks[*].verdict" })).toBe(false);
    expect(parse({ ...verdict, reason: "because" })).toBe(false);
    expect(parse({ ...verdict, allowAll: true })).toBe(false);
  });

  it("key order is not a difference, in objects or in lists", () => {
    expect(differencesBetween({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 })).toEqual([]);
    expect(differencesBetween({ list: [{ x: 1 }] }, { list: [{ x: 2 }] })).toEqual([{ field: ".list[0].x", from: 1, to: 2 }]);
  });

  it("compares lists of objects by id", () => {
    expect(differencesBetween([{ id: "a", v: 1 }], [{ id: "a", v: 2 }, { id: "b", v: 3 }])).toEqual([
      { field: "[a].v", from: 1, to: 2 },
      { field: "[b]", from: null, to: { id: "b", v: 3 } },
    ]);
  });

  it("the v0.5.0 baseline declares no differences, and v0.7.0 declares only S09-r1", () => {
    expect(readBaselineDeltas()).toMatchObject({ graderRevision: GRADER_REVISION, deltas: [] });
    const b3 = readBatch3Deltas();
    expect(b3.graderRevision).toBe(GRADER_REVISION);
    expect(b3.deltas).toHaveLength(15);
    expect(new Set(b3.deltas.map((d) => d.runKey))).toEqual(new Set(["S09-r1"]));
    expect(b3.deltas.find((d) => d.field === ".deterministicVerdict")).toMatchObject({ from: "NEEDS_REVIEW", to: "PASS" });
    expect(b3.deltas.every((d) => d.reason.includes("not evidence that the investigator improved"))).toBe(true);
    expect(b3.deltas.some((d) => /classification|\.checks\[D(?:2|3|4|5|6|18)\]|overallVerdict|\.review/.test(d.field))).toBe(false);
  });

  it.skipIf(!existsSync(".eval-out/sdk-batch3-S09/S09-r1/result.json"))("regrading the five v0.7.0 runs into a temp directory gives exactly the declared differences", async () => {
    const output = mkdtempSync(join(tmpdir(), "mm-b3-regrade-"));
    try {
      const recorded = new Map<string, unknown>();
      const regraded = new Map<string, unknown>();
      for (const s of ["S01", "S02", "S03", "S09", "S10"]) {
        const dir = `.eval-out/sdk-batch3-${s}`;
        recorded.set(`${s}-r1`, JSON.parse(readFileSync(join(dir, `${s}-r1`, "result.json"), "utf8")));
        const { results } = await evaluateDir(dir, { outputDir: join(output, s) });
        regraded.set(`${s}-r1`, results[0]);
      }
      expect(regradeDrift({ recorded, regraded }, readBatch3Deltas())).toEqual([]);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(".eval-out/sdk-batch3-S09/S09-r1/result.json"))("the recorded S09 result is the declared starting point", () => {
    const recorded = JSON.parse(readFileSync(".eval-out/sdk-batch3-S09/S09-r1/result.json", "utf8")) as { graderRevision: string; deterministicVerdict: string; facts: { assertions: { id: string }[] } };
    expect(recorded).toMatchObject({ graderRevision: "eval-graders/5", deterministicVerdict: "NEEDS_REVIEW" });
    expect(recorded.facts.assertions.map((a) => a.id)).toEqual(["selected-market", "spread[0]"]);
  });
});
