import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { persistObservation, readObservationDetail } from "../../src/adapters/storage/snapshotStore.js";
import { ANALYTICS_VERSION } from "../../src/analytics/version.js";
import { collectionRuns, marketHistory, observationDetails } from "../../src/app/marketHistory.js";
import { decimal } from "../../src/domain/decimal.js";
import type { MarketMindError } from "../../src/domain/errors.js";
import { ASOF, seedLookAhead } from "../mcpFixtures.js";
import { cleanupTemp, fakeLiveness, iso, META, openMigrated, record, startRun, tempDbPath } from "../storageFixtures.js";

afterEach(cleanupTemp);

const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error as MarketMindError;
  }
  throw new Error("expected a throw");
};

describe("readObservationDetail", () => {
  it("returns null for an unknown id", () => {
    const db = openMigrated();
    expect(readObservationDetail(db, 42)).toBeNull();
  });

  it("returns identity, observed metadata, exact books, every metrics version and only this market's requests", () => {
    const db = openMigrated();
    startRun(db, { runId: "r", sourceType: "live" });
    const one = persistObservation(db, "r", record({ id: "1", position: 0, labels: ["Up", "Down"] }), META, ANALYTICS_VERSION).observationId;
    persistObservation(db, "r", record({ id: "10", position: 1 }), META, ANALYTICS_VERSION);
    const d = readObservationDetail(db, one)!;
    expect(d).toMatchObject({ gammaId: "1", protocolVersion: "v1", outcomeLabels: ["Up", "Down"], pairing: "paired", run: { runId: "r", sourceType: "live" } });
    expect(d.books.map((b) => [b.outcome.index, b.labelObserved, b.quality])).toEqual([
      [0, "Up", "valid"],
      [1, "Down", "valid"],
    ]);
    expect(d.books[0]!.book.bids).toEqual([{ price: "0.40", size: "100" }]);
    expect(d.metrics.map((m) => [m.analyticsVersion, m.computedBy, m.spread])).toEqual([[1, "collect", "0.05"]]);
    // "market 1 " never matches "market 10 ...".
    expect(d.requests.map((r) => r.scope)).toEqual(["market 1 association", "market 1 book Up", "market 1 book Down"]);
  });
});

describe("observationDetails (app)", () => {
  it("never creates a missing database", () => {
    const dbPath = tempDbPath("absent.sqlite");
    expect(thrown(() => observationDetails({ dbPath, observationId: 1, asOf: null })).details.code).toBe("DATABASE_MISSING");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("reports unknown ids and ids not yet available at asOf as distinct NotFound codes", () => {
    const dbPath = tempDbPath();
    const { late } = seedLookAhead(dbPath);
    expect(thrown(() => observationDetails({ dbPath, observationId: 999, asOf: null })).details.code).toBe("OBSERVATION_NOT_FOUND");
    const e = thrown(() => observationDetails({ dbPath, observationId: late, asOf: ASOF }));
    expect([e.kind, e.details.code]).toEqual(["NotFound", "OBSERVATION_NOT_AVAILABLE_AS_OF"]);
  });

  it("withholds later facts at asOf and reveals them without it", () => {
    const dbPath = tempDbPath();
    const { early } = seedLookAhead(dbPath);
    const past = observationDetails({ dbPath, observationId: early, asOf: ASOF });
    expect(past).toMatchObject({ persistedAt: iso(150), runOutcome: null, requestsWithheld: 1 });
    expect(past.requests.every((r) => r.receivedAt !== null && Date.parse(r.receivedAt) <= Date.parse(ASOF))).toBe(true);
    expect(past.metrics.map((m) => m.retrospective)).toEqual([false, true]);
    expect(past.run).not.toHaveProperty("status");
    const before = observationDetails({ dbPath, observationId: early, asOf: iso(120) });
    expect(before.persistedAt).toBeNull();
    const nowView = observationDetails({ dbPath, observationId: early, asOf: null });
    expect(nowView).toMatchObject({ requestsWithheld: 0, runOutcome: { status: "complete" } });
  });

  it("keeps history metrics provenance (computedAt / computedBy)", () => {
    const dbPath = tempDbPath();
    seedLookAhead(dbPath);
    const h = marketHistory({ dbPath, gammaId: "1", asOf: ASOF, limit: 5, threshold: decimal("0.02"), analyticsVersion: 2, includeSynthetic: false });
    expect(h.rows[0]!.point.metrics).toMatchObject({ computedBy: "recompute", computedAt: iso(3_600_000) });
  });
});

describe("SQLite statement errors", () => {
  it("surface as typed Storage errors (a non-database file is CORRUPT), for the CLI and MCP alike", () => {
    const dbPath = tempDbPath("broken.sqlite");
    writeFileSync(dbPath, "this is not a database");
    const e = thrown(() => collectionRuns({ dbPath, limit: 1, liveness: fakeLiveness(), now: () => new Date() }));
    expect([e.kind, e.details.code]).toEqual(["Storage", "CORRUPT"]);
  });
});
