import { resolve } from "node:path";
import { APP_VERSION } from "../config/config.js";
import { isMarketMindError } from "../domain/errors.js";
import { webSettings } from "../web/settings.js";
import { staticRootOf } from "../web/static.js";
import { startDemo, type Demo, type DemoOptions } from "./demoServer.js";
import type { CleanupResult } from "./session.js";

// npm run web:demo, as a function of its environment so the shutdown path can be tested in process.
// Ctrl+C (SIGINT), SIGTERM, a closed console window (SIGHUP) or Ctrl+Break (SIGBREAK, Windows) close
// the server, which releases every database handle, and then delete the demonstration's temporary
// directory. A process killed outright cannot clean up: its marketmind-demo-* directory stays in the
// OS temporary folder (harmless; delete it by hand).

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

export interface DemoCliDeps {
  env: Record<string, string | undefined>;
  /** Where shutdown signals arrive (the process). */
  signals: { once(signal: (typeof SHUTDOWN_SIGNALS)[number], listener: () => void): unknown };
  log: (line: string) => void;
  /** The built UI, relative to the working directory (the launcher switches to the repository root). */
  staticDir?: string;
  session?: DemoOptions["session"];
}

export interface DemoRunning {
  demo: Demo;
  /** Resolves when a shutdown signal has been handled completely. */
  stopped: Promise<CleanupResult>;
}

/** Start the demonstration; returns null (after logging why) when it cannot start. */
export async function runDemo(deps: DemoCliDeps): Promise<DemoRunning | null> {
  const { log } = deps;
  try {
    // Only the port is taken from the environment; the configured database path is never used.
    const { port } = webSettings(deps.env);
    const staticRoot = await staticRootOf(resolve(deps.staticDir ?? "web/dist"));
    const demo = await startDemo({ port, staticRoot, log, ...(deps.session ? { session: deps.session } : {}) }).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      throw code === "EADDRINUSE" ? new Error(`port ${port} is already in use; set MARKETMIND_WEB_PORT to another port`, { cause: error }) : error;
    });
    const stopped = new Promise<CleanupResult>((done) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        log("shutting down");
        void demo.stop().then((result) => {
          log(result.removed ? "stopped; temporary database deleted" : `stopped; temporary directory kept (${result.reason}): ${demo.dir}`);
          done(result);
        });
      };
      for (const signal of SHUTDOWN_SIGNALS) deps.signals.once(signal, stop);
    });
    const { runs, observations, markets } = demo.summary;
    log(`v${APP_VERSION} SYNTHETIC DEMONSTRATION: ${markets} markets, ${runs} runs, ${observations} observations; offline, live Polymarket requests disabled`);
    log(`temporary database: ${demo.dbPath}`);
    log(staticRoot === null ? "UI not built: run npm run web:build" : `open ${demo.url}  (Ctrl+C stops the server and deletes the temporary database)`);
    return { demo, stopped };
  } catch (error) {
    log(`startup failed: ${isMarketMindError(error) ? `${error.message} ${(error.details.issues ?? []).join("; ")}` : error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
