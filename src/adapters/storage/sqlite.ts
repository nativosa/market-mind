import { DatabaseSync } from "node:sqlite";
import { isMarketMindError, MarketMindError } from "../../domain/errors.js";

// The only module that imports node:sqlite (enforced by ESLint). node:sqlite is a release
// candidate in Node 24; keeping it behind this file contains any future API change.

export type Database = DatabaseSync;
export type SqlValue = string | number | null;

export const BUSY_TIMEOUT_MS = 5_000;
export const JOURNAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;

export type StorageCode =
  | "DATABASE_BUSY"
  | "CANNOT_OPEN"
  | "IO_ERROR"
  | "DISK_FULL"
  | "READONLY"
  | "CORRUPT"
  | "CONSTRAINT"
  | "SCHEMA_TOO_NEW"
  | "SCHEMA_OUTDATED"
  | "IDENTITY_CONFLICT"
  | "INVALID_VALUE"
  | "HASH_COLLISION"
  | "RUN_NOT_RUNNING"
  | "NESTED_TRANSACTION"
  | "FOREIGN_KEYS_OFF"
  | "DB_SIZE_LIMIT"
  | "STORAGE_UNAVAILABLE"
  | "SQLITE_ERROR";

/** Errors that make further writes pointless for the rest of a run. */
export const FATAL_STORAGE_CODES: ReadonlySet<string> = new Set([
  "CANNOT_OPEN",
  "IO_ERROR",
  "DISK_FULL",
  "READONLY",
  "CORRUPT",
  "SCHEMA_TOO_NEW",
  "SCHEMA_OUTDATED",
  "FOREIGN_KEYS_OFF",
]);

export function storageError(code: StorageCode, message: string, issues: string[] = []): MarketMindError {
  return new MarketMindError("Storage", message, { code, ...(issues.length > 0 ? { issues } : {}) });
}

// Primary SQLite result codes (errcode & 0xff).
const CODE_BY_PRIMARY: Record<number, StorageCode> = {
  5: "DATABASE_BUSY", // SQLITE_BUSY
  6: "DATABASE_BUSY", // SQLITE_LOCKED
  8: "READONLY",
  10: "IO_ERROR",
  11: "CORRUPT",
  13: "DISK_FULL",
  14: "CANNOT_OPEN",
  19: "CONSTRAINT",
  26: "CORRUPT", // SQLITE_NOTADB
};

/** Map anything thrown by node:sqlite (or our own code) to a typed Storage error. */
export function toStorageError(error: unknown, context: string): MarketMindError {
  if (isMarketMindError(error)) return error;
  const errcode = typeof error === "object" && error !== null && "errcode" in error ? error.errcode : null;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof errcode === "number" ? (CODE_BY_PRIMARY[errcode & 0xff] ?? "SQLITE_ERROR") : "SQLITE_ERROR";
  return storageError(code, `${context}: ${message}`);
}

export interface OpenOptions {
  path: string;
  readOnly: boolean;
  busyTimeoutMs?: number;
}

/**
 * Open a database. Writers get WAL and a bounded WAL file; everyone gets foreign keys and a busy
 * timeout. A read-only open of a missing file fails without creating it.
 */
export function openDatabase(options: OpenOptions): Database {
  let db: Database;
  try {
    db = new DatabaseSync(options.path, {
      readOnly: options.readOnly,
      timeout: options.busyTimeoutMs ?? BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
    });
  } catch (error) {
    throw toStorageError(error, `Cannot open database ${options.path}`);
  }
  try {
    if (!options.readOnly) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);
    }
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
    if (fk?.foreign_keys !== 1) throw storageError("FOREIGN_KEYS_OFF", "Foreign key enforcement is not active");
    return db;
  } catch (error) {
    db.close();
    throw toStorageError(error, `Cannot configure database ${options.path}`);
  }
}

/** Run `fn` inside BEGIN IMMEDIATE ... COMMIT; roll back on any error. */
export function immediate<T>(db: Database, fn: () => T): T {
  if (db.isTransaction) throw storageError("NESTED_TRANSACTION", "A transaction is already open on this connection");
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw toStorageError(error, "Cannot start write transaction");
  }
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw toStorageError(error, "Write transaction rolled back");
  }
}

export function run(db: Database, sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function get(db: Database, sql: string, ...params: SqlValue[]): Record<string, unknown> | undefined {
  return db.prepare(sql).get(...params);
}

export function all(db: Database, sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...params);
}

export function sqliteVersion(db: Database): string {
  return (get(db, "SELECT sqlite_version() AS v") as { v: string }).v;
}
