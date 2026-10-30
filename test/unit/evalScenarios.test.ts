import { afterEach, describe, expect, it } from "vitest";
import { computeGolden, normalize } from "../../test-agent/eval/golden.js";
import { LABELS } from "../../test-agent/eval/report.js";
import { promptFor, RUBRICS, SCENARIOS } from "../../test-agent/eval/scenarios.js";
import { agentRoutes, EVAL_NOW, evalClock, fixtureDigest, HISTORY, LIVE, liveSpec, RUNS, seedEvalDb } from "../../test-agent/fixtures.js";
import { call, connect, ok, type Connected } from "../mcpFixtures.js";
import { cleanupTemp, tempDbPath } from "../storageFixtures.js";

// Stage 2.5: the golden scenario universe is reproducible, chronologically consistent and never leaks
// expectations into the prompts the investigator receives. No model is called.

const ms = (iso: string) => Date.parse(iso);
const NOW = ms(EVAL_NOW);

describe("fixture revision 2", () => {
  let c: Connected | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
    cleanupTemp();
  });

  it("seeding is reproducible: identical manifests and digest", () => {
    const a = seedEvalDb(tempDbPath("a.sqlite"));
    const b = seedEvalDb(tempDbPath("b.sqlite"));
    expect(a).toEqual(b);
    expect(fixtureDigest(a)).toBe(fixtureDigest(b));
    expect(fixtureDigest({ ...a, observations: a.observations.slice(1) })).not.toBe(fixtureDigest(a));
  });

  it("collection runs are finalized, ordered and contain only earlier evidence", async () => {
    const path = tempDbPath();
    const manifest = seedEvalDb(path);
    expect(manifest.runs.map((r) => r.runId)).toEqual(RUNS.map((r) => r.runId));
    c = await connect({ routes: agentRoutes(), dbPath: path });
    const runs = ok(await call(c, "list_collection_runs", { limit: 50 })).runs.items;
    expect(runs.map((r) => [r.runId, r.status, r.accounting, r.sourceType, r.owner])).toEqual(
      [...RUNS].reverse().map((r) => [r.runId, "complete", "verified", "synthetic", null]),
    );
    for (const r of runs) {
      expect(ms(r.finishedAt!)).toBeGreaterThan(ms(r.startedAt));
      expect(ms(r.window.first!)).toBeGreaterThanOrEqual(ms(r.startedAt));
      expect(ms(r.window.last!)).toBeLessThanOrEqual(ms(r.finishedAt!));
    }
    for (let i = 1; i < manifest.runs.length; i++) expect(ms(manifest.runs[i]!.startedAt)).toBeGreaterThan(ms(manifest.runs[i - 1]!.finishedAt));
    expect(Math.max(...manifest.runs.map((r) => ms(r.finishedAt)))).toBeLessThan(NOW);
  });

  it("every stored observation: request -> upstream timestamp -> receipt -> availability -> persistence, inside its run", async () => {
    const path = tempDbPath();
    const manifest = seedEvalDb(path);
    c = await connect({ routes: agentRoutes(), dbPath: path });
    const runOf = new Map(manifest.runs.map((r) => [r.runId, r]));
    const upstream = new Set<string>();
    for (const o of manifest.observations) {
      const d = ok(await call(c, "get_observation_details", { observationId: o.observationId }));
      const run = runOf.get(o.runId)!;
      expect(d.observation.availableAt).toBe(o.availableAt);
      expect(d.books).toHaveLength(2);
      for (const b of d.books) {
        upstream.add(b.serverTimestamp.iso!);
        expect(ms(b.serverTimestamp.iso!)).toBeLessThan(ms(b.request.responseReceivedAt));
        expect(ms(b.request.firstAttemptStartedAt)).toBeLessThan(ms(b.request.responseReceivedAt));
        expect(ms(b.request.firstAttemptStartedAt)).toBeGreaterThan(ms(run.startedAt));
        expect(ms(b.request.responseReceivedAt)).toBeLessThanOrEqual(ms(d.observation.availableAt));
      }
      expect(ms(d.observation.persistedAt!)).toBeGreaterThan(ms(d.observation.availableAt));
      expect(ms(d.observation.persistedAt!)).toBeLessThan(ms(run.finishedAt));
      for (const r of d.requests.items) {
        expect(ms(r.startedAt!)).toBeGreaterThan(ms(run.startedAt));
        expect(ms(r.receivedAt!)).toBeLessThanOrEqual(ms(d.observation.availableAt));
      }
      expect(ms(o.availableAt)).toBeLessThan(NOW);
    }
    expect(upstream.size).toBe(manifest.observations.length * 2);
  });

  it("simulated live books carry varied upstream timestamps before the evaluation clock", () => {
    const stamps = Object.keys(LIVE).flatMap((id) => {
      const s = liveSpec(id);
      return [Number(s.book!.raw!.timestamp), Number(s.other!.raw!.timestamp)];
    });
    expect(new Set(stamps).size).toBe(stamps.length);
    for (const t of stamps) expect(t).toBeLessThan(NOW);
    expect(evalClock()().toISOString()).toBe(EVAL_NOW);
  });

  it("history shapes: S07 has a real 9-day gap, S08 one distinct state, S06 a current spread outside the stored range", async () => {
    const path = tempDbPath();
    seedEvalDb(path);
    c = await connect({ routes: agentRoutes(), dbPath: path });
    const h = async (id: string) => ok(await call(c!, "get_market_history", { marketId: id, includeSynthetic: true, limit: 25 })).stats!;
    const gaps = await h("900108");
    expect(gaps.usable).toBe(5);
    expect(gaps.gaps.irregular).toBe(1);
    expect(gaps.gaps.maxMs).toBeGreaterThanOrEqual(9 * 86_400_000);
    expect(gaps.gaps.maxMs).toBeLessThan(9 * 86_400_000 + 3_600_000);
    expect(ms(gaps.lastUsableAt!)).toBeLessThan(NOW);
    expect((await h("900109")).states.distinct).toBe(1);
    const contra = await h("900107");
    expect([contra.spread.min, contra.spread.max]).toEqual(["0.02", "0.03"]);
    expect(ok(await call(c, "inspect_market", { marketId: "900107" })).outcomes[0]!.metrics!.spread).toBe("0.15");
    expect((await h("900103")).gaps.irregular).toBe(0);
    expect(Object.keys(HISTORY).sort()).toEqual(["900101", "900103", "900107", "900108", "900109"]);
  });

  it("the crossed market is suspicious and crossed, not invalid", async () => {
    c = await connect({ routes: agentRoutes(), dbPath: tempDbPath() });
    const v = ok(await call(c, "inspect_market", { marketId: "900106" }));
    expect(v.status).toBe("ok");
    expect(v.outcomes[0]).toMatchObject({ quality: "suspicious", metrics: { crossed: true } });
  });
});

describe("golden scenarios", () => {
  it("cover the 12 planned cases plus the permission probe, with unique ids", () => {
    expect(SCENARIOS.filter((s) => s.kind === "golden").map((s) => s.id)).toEqual(["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12"]);
    expect(new Set(SCENARIOS.map((s) => s.slug)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS.filter((x) => x.kind === "golden")) {
      expect(s.labels.strict.length).toBeGreaterThan(0);
      expect(s.labels.strict.filter((l) => s.labels.reviewable.includes(l))).toEqual([]);
    }
  });

  it("golden facts are reproducible", async () => {
    for (const id of ["S03", "S09", "S11"]) {
      const s = SCENARIOS.find((x) => x.id === id)!;
      const a = await computeGolden(s);
      const b = await computeGolden(s);
      expect(JSON.stringify(normalize(a))).toBe(JSON.stringify(normalize(b)));
    }
    const s11 = await computeGolden(SCENARIOS.find((x) => x.id === "S11")!);
    expect(s11.historyError).toBe("database_missing");
    expect(s11.fixtureDigest).toBe((await computeGolden(SCENARIOS.find((x) => x.id === "S02")!)).fixtureDigest);
    expect((await computeGolden(SCENARIOS.find((x) => x.id === "S12")!)).history?.status).toBe("no_history");
  }, 30_000);

  it("prompts carry no labels, golden facts, rubrics or other markets (no ground-truth leakage)", async () => {
    for (const s of SCENARIOS) {
      const prompt = promptFor(s);
      for (const l of LABELS) expect(prompt).not.toContain(l);
      for (const r of Object.values(RUBRICS)) expect(prompt).not.toContain(r.slice(0, 40));
      const g = await computeGolden(s);
      for (const f of s.facts(g).filter((x) => x.number)) expect(prompt.match(/\d+\.\d+/g) ?? []).not.toContain(f.number);
      expect(prompt).not.toMatch(/\d+\.\d+/);
      expect(prompt).not.toMatch(/EXTREME_PRICE|obs\s+\d|synthetic-run|no_history|database_missing|crossed|one-sided|irregular|identical/i);
      const ids = prompt.match(/\b9001\d\d\b/g) ?? [];
      expect(ids).toEqual(s.mode === "B" ? [] : [s.marketId]);
    }
  }, 60_000);
});
