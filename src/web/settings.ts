import { z } from "zod";
import { loadConfig, type AppConfig } from "../config/config.js";
import { MarketMindError } from "../domain/errors.js";
import { webGateSettings, type RollingWindowLimit } from "../research/liveGate.js";

/** Loopback only. Not configurable: the server is a single-user local tool. */
export const WEB_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT = 4317;

export interface WebSettings {
  config: AppConfig;
  port: number;
  /** Extra browser origins allowed to call the API, e.g. a local Vite dev server that proxies /api. */
  devOrigins: string[];
  processLimit: number;
  window: RollingWindowLimit;
}

/** A dev origin must be plain http on a loopback name with an explicit port, and nothing else. */
const DEV_ORIGIN_RULE = "must look like http://localhost:5173 (loopback, explicit port, no path)";
const DevOrigin = z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/, DEV_ORIGIN_RULE);

/** Web server configuration from the environment: the CLI's settings plus port, dev origin and budgets. */
export function webSettings(env: Record<string, string | undefined>): WebSettings {
  const config = loadConfig(env);
  const rawPort = env.MARKETMIND_WEB_PORT;
  let port = DEFAULT_WEB_PORT;
  if (rawPort !== undefined) {
    const parsed = z.coerce.number().int().min(1024).max(65_535).safeParse(rawPort);
    if (!parsed.success) throw new MarketMindError("Usage", "Invalid MARKETMIND_WEB_PORT", { issues: ["must be an integer from 1024 to 65535"] });
    port = parsed.data;
  }
  const rawOrigin = env.MARKETMIND_WEB_DEV_ORIGIN;
  const devOrigins: string[] = [];
  if (rawOrigin !== undefined) {
    // URL.canParse also rejects ports above 65535.
    const parsed = DevOrigin.refine((o) => URL.canParse(o)).safeParse(rawOrigin);
    if (!parsed.success) throw new MarketMindError("Usage", "Invalid MARKETMIND_WEB_DEV_ORIGIN", { issues: [DEV_ORIGIN_RULE] });
    devOrigins.push(parsed.data);
  }
  return { config, port, devOrigins, ...webGateSettings(env) };
}
