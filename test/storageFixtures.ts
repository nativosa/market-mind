import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GammaMarketSchema } from "../src/adapters/polymarket/gammaSchemas.js";
import { toMarket } from "../src/adapters/polymarket/normalize.js";
import { migrate, SCHEMA_VERSION } from "../src/adapters/storage/migrations.js";
import type { Liveness, ProcessState } from "../src/adapters/storage/processLiveness.js";
import { createRun, type NewRun } from "../src/adapters/storage/snapshotStore.js";
import { openDatabase, type Database } from "../src/adapters/storage/sqlite.js";
import { computeScanMetrics, evaluateCandidate } from "../src/analytics/scanMetrics.js";
import { ANALYTICS_VERSION } from "../src/analytics/version.js";
import { decimal } from "../src/domain/decimal.js";
import type { ProtocolVersion } from "../src/domain/market.js";
import type { ScanFilters } from "../src/domain/scan.js";
import type { ObservationRecord, RequestEvidence } from "../src/domain/snapshot.js";
import { conditionId, DEFAULT_BOOK, gammaRecord, mirror, observation, provenance, type BookSpec } from "./scanFixtures.js";

export const T0 = Date.parse("2026-10-28T21:05:12.000Z");
export const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
export const FILTERS: ScanFilters = { minSpread: decimal("0"), minTopSize: decimal("10"), includeSuspicious: false };

const dirs: string[] = [];

/** A fresh temp directory database path (removed by cleanupTemp). */
export function tempDbPath(name = "test.sqlite"): string {
  const dir = mkdtempSync(join(tmpdir(), "mm-store-"));
  dirs.push(dir);
  return join(dir, name);
}

export function cleanupTemp(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Clock that advances 10 ms per read. */
export function clock(startMs = T0, stepMs = 10): () => Date {
  let t = startMs;
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

export function openMigrated(path = ":memory:"): Database {
  const db = openDatabase({ path, readOnly: false });
  migrate(db, clock());
  return db;
}

export function runInput(overrides: Partial<NewRun> = {}): NewRun {
  return {
    runId: "run-1",
    sourceType: "synthetic",
    startedAt: new Date(T0),
    owner: { pid: 4242, host: "test-host" },
    appVersion: "0.0.0-test",
    buildId: null,
    schemaVersion: SCHEMA_VERSION,
    analyticsVersion: ANALYTICS_VERSION,
    nodeVersion: "v24.0.0",
    sqliteVersion: "3.53.4",
    protocolVersion: "v1",
    config: { depthBand: "0.05" },
    budgetLimit: 48,
    ...overrides,
  };
}

export function startRun(db: Database, overrides: Partial<NewRun> = {}): string {
  const r = runInput(overrides);
  createRun(db, r);
  return r.runId;
}

export interface RecordSpec {
  id?: string;
  version?: ProtocolVersion;
  labels?: [string, string];
  /** Reference book; `null` = not received. */
  ref?: BookSpec | null;
  /** Other book; default = exact complement; `null` = not received. */
  other?: BookSpec | null;
  receivedAt?: [number, number];
  association?: ObservationRecord["association"];
  gamma?: Record<string, unknown>;
  position?: number;
  page?: number;
  /** Extra request evidence (e.g. failed sibling request). */
  requests?: RequestEvidence[];
}

const ev = (scope: string, endpoint: string, receivedOffset: number | null, errorKind: string | null = null, source: "gamma" | "clob" = "clob"): RequestEvidence => ({
  scope,
  source,
  endpoint,
  url: `https://${source}.example${endpoint}`,
  httpStatus: errorKind ? 500 : 200,
  attempts: 1,
  timing:
    receivedOffset === null
      ? null
      : {
          firstAttemptStartedAt: iso(receivedOffset - 5),
          finalAttemptStartedAt: iso(receivedOffset - 5),
          responseReceivedAt: iso(receivedOffset),
          durationMs: 5,
          attempts: 1,
          serverDateHeader: null,
        },
  errorKind,
});

export const evidence = ev;

/** A complete, valid observation record built like collect builds it. */
export function record(spec: RecordSpec = {}): ObservationRecord {
  const id = spec.id ?? "1";
  const version = spec.version ?? "v1";
  const labels = spec.labels ?? ["Yes", "No"];
  const market = toMarket(GammaMarketSchema.parse({ ...gammaRecord({ id, version, labels }), ...spec.gamma }), provenance());
  const kind = version === "v2" ? "positionId" : "tokenId";
  const [t0, t1] = spec.receivedAt ?? [100, 110];
  const refSpec = spec.ref === undefined ? DEFAULT_BOOK : spec.ref;
  const otherSpec = spec.other === undefined ? (refSpec ? mirror(refSpec) : null) : spec.other;
  const ref = refSpec ? observation(0, refSpec, { id, label: labels[0], receivedAt: iso(t0), kind }) : null;
  const other = otherSpec ? observation(1, otherSpec, { id, label: labels[1], receivedAt: iso(t1), kind }) : null;
  const books = [ref, other].filter((b) => b !== null);
  const outcomes = [0, 1].map((i) => books.find((b) => b.outcome.index === i)?.outcome ?? observation(i, DEFAULT_BOOK, { id, label: labels[i]!, kind }).outcome);
  let metrics = null;
  let bucket: ObservationRecord["bucket"] = "failed";
  let reasons: ObservationRecord["reasons"] = [{ code: "HTTP_UPSTREAM_5XX", detail: "sibling failed" }];
  let warnings: ObservationRecord["warnings"] = [];
  if (ref && other) {
    metrics = computeScanMetrics(ref, other);
    const e = evaluateCandidate(ref, other, metrics, FILTERS, market.endDate);
    bucket = e.bucket;
    reasons = e.reasons;
    warnings = e.warnings;
  }
  const requests: RequestEvidence[] = [
    ev(`discovery page ${spec.page ?? 1}`, "/markets/keyset", 0, null, "gamma"),
    ev(`market ${id} association`, "/clob-markets/{condition_id}", 50),
    ...books.map((b) => ({
      ...ev(`market ${id} book ${b.outcome.label}`, "/book", null),
      url: `https://clob.example/book?token_id=${b.outcome.assetId}`,
      timing: b.book.provenance.timing,
    })),
    ...(spec.requests ?? []),
  ];
  return {
    market,
    outcomes,
    discoveryPosition: spec.position ?? 0,
    bucket,
    reasons,
    warnings,
    association: spec.association ?? "confirmed",
    books,
    metrics,
    depthBand: decimal("0.05"),
    requests,
  };
}

export const META = { now: new Date(T0 + 1_000), appVersion: "0.0.0-test", buildId: "abc123" };

/** Liveness double: fixed host and a pid -> state table (default "gone"). */
export function fakeLiveness(states: Record<number, ProcessState> = {}, host = "test-host"): Liveness & { probes: number[] } {
  const probes: number[] = [];
  return {
    probes,
    hostname: () => host,
    probe: (pid) => {
      probes.push(pid);
      return states[pid] ?? "gone";
    },
  };
}

export { conditionId };
