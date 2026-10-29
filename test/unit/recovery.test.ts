import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { realLiveness } from "../../src/adapters/storage/processLiveness.js";
import { assessRunOwner, finalizeRun, listRuns, persistObservation, recoverRuns, RUN_LEASE_MS } from "../../src/adapters/storage/snapshotStore.js";
import { get, run } from "../../src/adapters/storage/sqlite.js";
import { ANALYTICS_VERSION } from "../../src/analytics/version.js";
import { cleanupTemp, fakeLiveness, META, openMigrated, record, startRun, T0, tempDbPath } from "../storageFixtures.js";

afterEach(cleanupTemp);

const STALE = new Date(T0 + RUN_LEASE_MS + 1);
const FRESH = new Date(T0 + RUN_LEASE_MS); // exactly at the lease: not stale yet

describe("assessRunOwner", () => {
  const r = { ownerPid: 10, ownerHost: "test-host", heartbeatMs: T0 };
  it.each([
    [{}, "test-host", STALE, "RECOVERABLE"],
    [{ 10: "alive" as const }, "test-host", STALE, "OWNER_ALIVE"],
    [{ 10: "unknown" as const }, "test-host", STALE, "OWNER_UNKNOWN"],
    [{}, "other-host", STALE, "OTHER_HOST"],
    [{}, "test-host", FRESH, "HEARTBEAT_FRESH"],
  ])("states %j on %s at lease boundary -> %s", (states, host, now, expected) => {
    expect(assessRunOwner(r, fakeLiveness(states, host), now.getTime())).toBe(expected);
  });

  it("never probes a process on another host", () => {
    const l = fakeLiveness({}, "elsewhere");
    assessRunOwner(r, l, STALE.getTime());
    expect(l.probes).toEqual([]);
  });
});

describe("recoverRuns", () => {
  it("marks a provably abandoned run interrupted with incomplete accounting and observed counts only", () => {
    const db = openMigrated();
    const runId = startRun(db, { owner: { pid: 10, host: "test-host" } });
    persistObservation(db, runId, record(), { ...META, now: new Date(T0) }, ANALYTICS_VERSION);
    const report = recoverRuns(db, fakeLiveness(), STALE);
    expect(report).toEqual({ recovered: [runId], unverified: [] });
    const [r] = listRuns(db, 1);
    expect(r).toMatchObject({ status: "interrupted", accounting: "incomplete", recoveredReason: "OWNER_PROCESS_GONE", stopReasons: null, scanCounts: null });
    expect(r!.persistCounts).toEqual({
      selected: null,
      discovered: null,
      persistedObservations: 1,
      persistenceFailures: 0,
      booksWritten: 2,
      metricsWritten: 1,
      bookContentsNew: null,
      bookContentsReused: null,
    });
    expect(r!.error).toMatchObject({ code: "OWNER_PROCESS_GONE" });
  });

  it.each([
    ["alive owner", { 10: "alive" as const }, "test-host", STALE, "OWNER_ALIVE"],
    ["unverifiable owner (EPERM-like unknown)", { 10: "unknown" as const }, "test-host", STALE, "OWNER_UNKNOWN"],
    ["other host", {}, "other-host", STALE, "OTHER_HOST"],
    ["fresh heartbeat of a gone owner", {}, "test-host", FRESH, "HEARTBEAT_FRESH"],
  ])("leaves a run untouched for a %s", (_name, states, host, now, reason) => {
    const db = openMigrated();
    const runId = startRun(db, { owner: { pid: 10, host: "test-host" } });
    expect(recoverRuns(db, fakeLiveness(states, host), now)).toEqual({ recovered: [], unverified: [{ runId, reason }] });
    expect(get(db, "SELECT status, accounting, finished_at FROM collection_run")).toEqual({ status: "running", accounting: "pending", finished_at: null });
  });

  it("an old heartbeat alone never interrupts a live owner", () => {
    const db = openMigrated();
    startRun(db, { owner: { pid: 10, host: "test-host" } });
    const yearsLater = new Date(T0 + 10 * 365 * 24 * 3600 * 1000);
    expect(recoverRuns(db, fakeLiveness({ 10: "alive" }), yearsLater).recovered).toEqual([]);
  });

  it("skips the caller's own run", () => {
    const db = openMigrated();
    const runId = startRun(db);
    expect(recoverRuns(db, fakeLiveness(), STALE, runId)).toEqual({ recovered: [], unverified: [] });
  });

  it("two concurrent recoverers: exactly one wins (compare-and-set on status and heartbeat)", () => {
    const path = tempDbPath();
    const a = openMigrated(path);
    const b = openMigrated(path);
    startRun(a, { owner: { pid: 10, host: "test-host" } });
    const first = recoverRuns(a, fakeLiveness(), STALE);
    const second = recoverRuns(b, fakeLiveness(), STALE);
    expect(first.recovered).toHaveLength(1);
    expect(second).toEqual({ recovered: [], unverified: [] });
    a.close();
    b.close();
  });

  it("a heartbeat that moves between the check and the update makes the recovery lose", () => {
    const db = openMigrated();
    const runId = startRun(db, { owner: { pid: 10, host: "test-host" } });
    // The owner writes a heartbeat while the recoverer is deciding: simulate with a liveness probe side effect.
    const liveness = fakeLiveness();
    const original = liveness.probe.bind(liveness);
    liveness.probe = (pid: number) => {
      run(db, "UPDATE collection_run SET heartbeat_ms = heartbeat_ms + 1 WHERE run_id = ?", runId);
      return original(pid);
    };
    expect(recoverRuns(db, liveness, STALE).recovered).toEqual([]);
    expect(get(db, "SELECT status FROM collection_run")).toEqual({ status: "running" });
  });

  it("an owner finalizing after a (wrongful) recovery cannot overwrite it, and vice versa", () => {
    const db = openMigrated();
    const runId = startRun(db, { owner: { pid: 10, host: "test-host" } });
    recoverRuns(db, fakeLiveness(), STALE);
    const final = {
      status: "complete" as const,
      accounting: "verified" as const,
      finishedAt: new Date(T0),
      stopReasons: [],
      scanCounts: null,
      persistCounts: {},
      budgetUsed: 0,
      window: null,
      error: null,
    };
    expect(finalizeRun(db, runId, final)).toBe(false);
    expect(get(db, "SELECT status FROM collection_run")).toEqual({ status: "interrupted" });
  });
});

describe("realLiveness (this platform)", () => {
  it("reports this process alive and a finished child process gone", () => {
    expect(realLiveness.probe(process.pid)).toBe("alive");
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const pid = Number(child.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(realLiveness.probe(pid)).toBe("gone");
    expect(realLiveness.hostname()).toBe(hostname());
  });

  it("never treats non-positive or non-integer pids as provable", () => {
    expect([realLiveness.probe(0), realLiveness.probe(-1), realLiveness.probe(1.5), realLiveness.probe(Number.NaN)]).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it.runIf(process.platform === "win32")("treats an existing process owned by the system (EPERM) as alive on Windows", () => {
    expect(realLiveness.probe(4)).toBe("alive"); // PID 4 is the Windows System process
  });
});
