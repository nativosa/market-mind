import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { assertSchemaCurrent, migrate, MIGRATIONS, SCHEMA_VERSION, userVersion, type Migration } from "../../src/adapters/storage/migrations.js";
import { all, get, immediate, openDatabase, run, sqliteVersion, toStorageError } from "../../src/adapters/storage/sqlite.js";
import { MarketMindError } from "../../src/domain/errors.js";
import { cleanupTemp, clock, openMigrated, tempDbPath } from "../storageFixtures.js";

afterEach(cleanupTemp);

function thrown(fn: () => unknown): MarketMindError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MarketMindError);
    return e as MarketMindError;
  }
  throw new Error("expected an error");
}

describe("openDatabase", () => {
  it("opens writers in WAL mode with foreign keys, a busy timeout and a bounded WAL", () => {
    const path = tempDbPath();
    const db = openDatabase({ path, readOnly: false });
    expect(get(db, "PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    expect(get(db, "PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
    expect(get(db, "PRAGMA busy_timeout")).toEqual({ timeout: 5000 });
    expect(get(db, "PRAGMA journal_size_limit")).toEqual({ journal_size_limit: 8 * 1024 * 1024 });
    expect(sqliteVersion(db)).toMatch(/^3\.\d+\.\d+$/);
    db.close();
  });

  it("read-only open of a missing database fails with CANNOT_OPEN and creates nothing", () => {
    const path = tempDbPath("missing.sqlite");
    const error = thrown(() => openDatabase({ path, readOnly: true }));
    expect(error.kind).toBe("Storage");
    expect(error.details.code).toBe("CANNOT_OPEN");
    expect(existsSync(path)).toBe(false);
  });

  it("read-only connections cannot write", () => {
    const path = tempDbPath();
    openMigrated(path).close();
    const ro = openDatabase({ path, readOnly: true });
    expect(thrown(() => immediate(ro, () => run(ro, "DELETE FROM schema_migrations"))).details.code).toBe("READONLY");
    ro.close();
  });
});

describe("immediate transactions", () => {
  it("commits on success and rolls back everything on failure", () => {
    const db = openMigrated();
    db.exec("CREATE TABLE t (x TEXT NOT NULL) STRICT");
    immediate(db, () => run(db, "INSERT INTO t VALUES ('a')"));
    const error = thrown(() =>
      immediate(db, () => {
        run(db, "INSERT INTO t VALUES ('b')");
        run(db, "INSERT INTO t VALUES (NULL)");
      }),
    );
    expect(error.details.code).toBe("CONSTRAINT");
    expect(all(db, "SELECT x FROM t")).toEqual([{ x: "a" }]);
    expect(db.isTransaction).toBe(false);
  });

  it("refuses nested transactions", () => {
    const db = openMigrated();
    const error = thrown(() => immediate(db, () => immediate(db, () => 1)));
    expect(error.details.code).toBe("NESTED_TRANSACTION");
    expect(db.isTransaction).toBe(false);
  });

  it("a second writer gets DATABASE_BUSY after its timeout while readers still read (WAL)", () => {
    const path = tempDbPath();
    const a = openMigrated(path);
    const b = openDatabase({ path, readOnly: false, busyTimeoutMs: 50 });
    const reader = openDatabase({ path, readOnly: true });
    a.exec("BEGIN IMMEDIATE");
    run(a, "INSERT INTO schema_migrations VALUES (99, 'x', 'held')");
    expect(thrown(() => immediate(b, () => 1)).details.code).toBe("DATABASE_BUSY");
    expect(get(reader, "SELECT count(*) AS n FROM schema_migrations")).toEqual({ n: 1 }); // uncommitted row invisible
    a.exec("COMMIT");
    expect(get(reader, "SELECT count(*) AS n FROM schema_migrations")).toEqual({ n: 2 });
    [a, b, reader].forEach((d) => d.close());
  });

  it("maps SQLite result codes to storage codes", () => {
    const err = (errcode: number) => toStorageError(Object.assign(new Error("x"), { errcode }), "ctx").details.code;
    expect([err(5), err(6), err(8), err(10), err(11), err(13), err(14), err(19), err(26), err(1555), err(1)]).toEqual([
      "DATABASE_BUSY",
      "DATABASE_BUSY",
      "READONLY",
      "IO_ERROR",
      "CORRUPT",
      "DISK_FULL",
      "CANNOT_OPEN",
      "CONSTRAINT",
      "CORRUPT",
      "CONSTRAINT",
      "SQLITE_ERROR",
    ]);
    expect(toStorageError("plain", "ctx").details.code).toBe("SQLITE_ERROR");
    const own = new MarketMindError("Storage", "mine", { code: "IDENTITY_CONFLICT" });
    expect(toStorageError(own, "ctx")).toBe(own);
  });
});

describe("migrations", () => {
  it("creates every table as STRICT and records the schema version", () => {
    const db = openMigrated();
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    const tables = all(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual([
      "book_content",
      "book_observation",
      "collection_run",
      "market",
      "market_metrics",
      "market_observation",
      "outcome",
      "persistence_failure",
      "request_log",
      "schema_migrations",
    ]);
    for (const t of tables) expect(String(t.sql)).toMatch(/\) STRICT$/);
    expect(all(db, "SELECT version, description FROM schema_migrations")).toEqual([{ version: 1, description: "initial snapshot schema" }]);
  });

  it("is idempotent", () => {
    const db = openMigrated();
    expect(migrate(db, clock())).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(get(db, "SELECT count(*) AS n FROM schema_migrations")).toEqual({ n: 1 });
  });

  it("refuses a database from a newer MarketMind", () => {
    const db = openMigrated();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(thrown(() => migrate(db, clock())).details.code).toBe("SCHEMA_TOO_NEW");
    expect(thrown(() => assertSchemaCurrent(db, "x.sqlite")).details.code).toBe("SCHEMA_TOO_NEW");
  });

  it("readers require the current schema", () => {
    const db = openDatabase({ path: ":memory:", readOnly: false });
    expect(thrown(() => assertSchemaCurrent(db, "x.sqlite")).details.code).toBe("SCHEMA_OUTDATED");
  });

  it("a failing migration rolls back completely and keeps the previous version", () => {
    const db = openMigrated();
    const broken: Migration[] = [...MIGRATIONS, { version: 2, description: "broken", sql: "CREATE TABLE extra (x TEXT) STRICT; SELECT * FROM no_such_table;" }];
    expect(thrown(() => migrate(db, clock(), broken)).kind).toBe("Storage");
    expect(userVersion(db)).toBe(1);
    expect(get(db, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'extra'")).toEqual({ n: 0 });
  });

  it("decimal columns reject floating-point renderings even though STRICT TEXT would coerce numbers", () => {
    const db = openMigrated();
    db.exec("CREATE TABLE probe (v TEXT CHECK (v IS NULL OR (v GLOB '[0-9]*' AND v NOT GLOB '*[^0-9.]*'))) STRICT");
    expect(() => run(db, "INSERT INTO probe VALUES (?)", 1e-7)).toThrow(/CHECK/);
    const ddl = String(get(db, "SELECT sql FROM sqlite_master WHERE name = 'market_metrics'")!.sql);
    expect(ddl).toContain("spread TEXT CHECK");
    expect(ddl).toContain("best_bid TEXT CHECK");
  });
});
