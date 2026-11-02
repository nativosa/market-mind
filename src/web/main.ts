import { resolve } from "node:path";
import { realHttpDeps } from "../adapters/polymarket/httpClient.js";
import { APP_VERSION } from "../config/config.js";
import { isMarketMindError } from "../domain/errors.js";
import { WEB_LIMITS } from "../research/contracts.js";
import { createLiveGate, withRateLimitCooldown } from "../research/liveGate.js";
import { createWebServer } from "./server.js";
import { WEB_HOST, webSettings } from "./settings.js";
import { staticRootOf } from "./static.js";

const log = (line: string) => process.stderr.write(`[marketmind-web] ${line}\n`);

/** Built SPA, relative to the repository root (the launcher switches there). */
const STATIC_DIR = "web/dist";

try {
  const settings = webSettings(process.env);
  const gate = withRateLimitCooldown(createLiveGate(realHttpDeps, settings.processLimit, { window: settings.window }), WEB_LIMITS.rateLimitCooldownMs);
  const staticRoot = await staticRootOf(resolve(STATIC_DIR));
  const web = createWebServer({ gate, config: settings.config, devOrigins: settings.devOrigins, staticRoot, now: () => new Date(), log });
  try {
    await web.listen(settings.port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === "EADDRINUSE" ? `port ${settings.port} is already in use; set MARKETMIND_WEB_PORT to another port` : `cannot listen: ${code ?? String(error)}`, { cause: error });
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("shutting down");
    void web.close().then(() => log("stopped"));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const { limit, windowMs } = settings.window;
  log(
    `v${APP_VERSION} listening on http://${WEB_HOST}:${settings.port}; live request ceiling ${settings.processLimit}, ${limit} per ${windowMs / 60_000} min; ` +
      `UI ${staticRoot === null ? "not built" : "built"}${settings.devOrigins.length > 0 ? "; dev origin allowed" : ""}`,
  );
} catch (error) {
  log(`startup failed: ${isMarketMindError(error) ? `${error.message} ${(error.details.issues ?? []).join("; ")}` : error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
