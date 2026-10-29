import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

// Runtime compatibility checks for the features the storage layer relies on (Stage 2.2, step 0).

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mm-compat-"));
  dirs.push(dir);
  return join(dir, "compat.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("node:sqlite runtime compatibility", () => {
  it("bundles a SQLite with STRICT tables, JSON and the WAL-reset fix (>= 3.51.3)", () => {
    const db = new DatabaseSync(":memory:");
    const version = (db.prepare("select sqlite_version() as v").get() as { v: string }).v;
    const [major, minor, patch] = version.split(".").map((p) => Number(p));
    expect(major! * 1_000_000 + minor! * 1_000 + patch!).toBeGreaterThanOrEqual(3_051_003);
    expect(db.prepare("select json_extract('[\"a\",\"b\"]', '$[1]') as x").get()).toEqual({ x: "b" });
    db.close();
  });

  it("enforces foreign keys by default and keeps TEXT exactly", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("create table p (id integer primary key) strict; create table c (p integer not null references p(id), d text not null) strict;");
    expect(() => db.prepare("insert into c values (1, '1')").run()).toThrow(/FOREIGN KEY/);
    db.exec("insert into p values (1)");
    db.prepare("insert into c values (1, ?)").run("0.123456789012345678");
    expect(db.prepare("select d from c").get()).toEqual({ d: "0.123456789012345678" });
    db.close();
  });

  it("supports WAL, BEGIN IMMEDIATE busy errors and readers during a write", () => {
    const file = tempFile();
    const a = new DatabaseSync(file, { timeout: 1000 });
    expect(a.prepare("pragma journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
    a.exec("create table t (x text) strict");
    const b = new DatabaseSync(file, { timeout: 50 });
    a.exec("BEGIN IMMEDIATE");
    expect(a.isTransaction).toBe(true);
    let caught: unknown;
    try {
      b.exec("BEGIN IMMEDIATE");
    } catch (e) {
      caught = e;
    }
    expect((caught as { errcode?: number }).errcode).toBe(5); // SQLITE_BUSY
    expect(b.prepare("select count(*) as n from t").get()).toEqual({ n: 0 });
    a.exec("COMMIT");
    a.close();
    b.close();
  });

  it("read-only open of a missing file fails without creating it", () => {
    const file = tempFile();
    expect(() => new DatabaseSync(file, { readOnly: true })).toThrow();
  });
});
