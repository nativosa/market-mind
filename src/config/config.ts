import { z } from "zod";
import { MarketMindError } from "../domain/errors.js";

/** Application version recorded with stored observations. Kept equal to package.json by a test. */
export const APP_VERSION = "0.3.0";

/** Default local database, relative to the working directory (ignored by Git). */
export const DEFAULT_DB_PATH = "data/marketmind.sqlite";

export interface AppConfig {
  gammaBaseUrl: string;
  clobBaseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxRetryAfterMs: number;
  userAgent: string;
  dbPath: string;
  /** Optional build identifier (e.g. a commit SHA) from MARKETMIND_BUILD_ID; never derived from Git at runtime. */
  buildId: string | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",
  timeoutMs: 10_000,
  maxRetries: 2,
  baseBackoffMs: 500,
  maxRetryAfterMs: 5_000,
  userAgent: `market-mind/${APP_VERSION} (read-only educational explorer)`,
  dbPath: DEFAULT_DB_PATH,
  buildId: null,
};

const intFromEnv = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const httpsUrl = z.url({ protocol: /^https$/ }).transform((u) => u.replace(/\/+$/, ""));

const EnvSchema = z.object({
  MARKETMIND_GAMMA_URL: httpsUrl.optional(),
  MARKETMIND_CLOB_URL: httpsUrl.optional(),
  MARKETMIND_TIMEOUT_MS: intFromEnv(1, 60_000).optional(),
  MARKETMIND_MAX_RETRIES: intFromEnv(0, 5).optional(),
  MARKETMIND_DB: z.string().optional(),
  MARKETMIND_BUILD_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "1-64 characters of [A-Za-z0-9._-]").optional(),
});

/**
 * Validate a database path given on the command line or in MARKETMIND_DB. Pure string checks only;
 * the storage layer checks the file system.
 */
export function parseDbPath(value: string, source: string): string {
  const path = value.trim();
  const problems: string[] = [];
  if (path === "") problems.push("must not be empty");
  if (path.includes("\0")) problems.push("must not contain NUL");
  if (path === ":memory:" || path.startsWith("file:")) problems.push("must be a file path (no :memory: or file: URIs)");
  if (!/\.(sqlite|db)$/i.test(path)) problems.push("must end in .sqlite or .db");
  if (problems.length > 0) {
    throw new MarketMindError("Usage", `Invalid database path from ${source}: ${JSON.stringify(value)}`, { issues: problems });
  }
  return path;
}

/** Defaults, optionally overridden by MARKETMIND_* environment variables (validated). */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new MarketMindError("Usage", "Invalid MARKETMIND_* environment configuration", {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const e = parsed.data;
  return {
    ...DEFAULT_CONFIG,
    gammaBaseUrl: e.MARKETMIND_GAMMA_URL ?? DEFAULT_CONFIG.gammaBaseUrl,
    clobBaseUrl: e.MARKETMIND_CLOB_URL ?? DEFAULT_CONFIG.clobBaseUrl,
    timeoutMs: e.MARKETMIND_TIMEOUT_MS ?? DEFAULT_CONFIG.timeoutMs,
    maxRetries: e.MARKETMIND_MAX_RETRIES ?? DEFAULT_CONFIG.maxRetries,
    dbPath: e.MARKETMIND_DB === undefined ? DEFAULT_CONFIG.dbPath : parseDbPath(e.MARKETMIND_DB, "MARKETMIND_DB"),
    buildId: e.MARKETMIND_BUILD_ID ?? null,
  };
}
