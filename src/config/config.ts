import { z } from "zod";
import { MarketMindError } from "../domain/errors.js";

export interface AppConfig {
  gammaBaseUrl: string;
  clobBaseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxRetryAfterMs: number;
  userAgent: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",
  timeoutMs: 10_000,
  maxRetries: 2,
  baseBackoffMs: 500,
  maxRetryAfterMs: 5_000,
  userAgent: "market-mind/0.2.0 (read-only educational explorer)",
};

const intFromEnv = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const httpsUrl = z.url({ protocol: /^https$/ }).transform((u) => u.replace(/\/+$/, ""));

const EnvSchema = z.object({
  MARKETMIND_GAMMA_URL: httpsUrl.optional(),
  MARKETMIND_CLOB_URL: httpsUrl.optional(),
  MARKETMIND_TIMEOUT_MS: intFromEnv(1, 60_000).optional(),
  MARKETMIND_MAX_RETRIES: intFromEnv(0, 5).optional(),
});

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
  };
}
