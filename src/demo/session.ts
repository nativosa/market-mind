import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The demonstration's private temporary directory. It is created fresh under the OS temporary
// directory (mkdtemp never reuses a path), marked with a token known only to this process, and
// deleted only after the mark is verified: a directory this process did not create is never removed.

export const DEMO_DIR_PREFIX = "marketmind-demo-";
const MARKER = "marketmind-demo.json";
export const DEMO_DB_NAME = "demo.sqlite";

export interface DemoSession {
  /** The created directory (real path). */
  readonly dir: string;
  /** The database file inside it; it does not exist until the generator writes it. */
  readonly dbPath: string;
  /** Delete the directory if, and only if, it is still the one this session created. Idempotent. */
  cleanup(): CleanupResult;
}

export type CleanupResult = { removed: true } | { removed: false; reason: string };

export interface SessionDeps {
  tmpRoot?: string;
  pid?: number;
  /** Removal retries: Windows may hold a just-closed file briefly (antivirus, indexer). */
  retries?: number;
  /** The recursive delete (tests replace it to simulate a locked file). */
  remove?: (dir: string, retries: number) => void;
}

const removeDir = (dir: string, retries: number) => rmSync(dir, { recursive: true, force: false, maxRetries: retries, retryDelay: 100 });

export function createDemoSession(deps: SessionDeps = {}): DemoSession {
  const root = realpathSync.native(deps.tmpRoot ?? tmpdir());
  const dir = mkdtempSync(join(root, DEMO_DIR_PREFIX));
  const token = randomUUID();
  // "wx": fails if the file exists, so the mark is always this process's own.
  writeFileSync(join(dir, MARKER), JSON.stringify({ purpose: "MarketMind synthetic demonstration (npm run web:demo)", pid: deps.pid ?? process.pid, token }), { flag: "wx" });
  let done: CleanupResult | null = null;

  const ownership = (): string | null => {
    let real: string;
    try {
      real = realpathSync.native(dir);
    } catch {
      return "the directory no longer exists";
    }
    if (real !== dir) return "the path no longer resolves to the directory that was created";
    try {
      const mark = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { token?: unknown };
      return mark.token === token ? null : "the directory's ownership mark belongs to another process";
    } catch {
      return "the directory's ownership mark is missing or unreadable";
    }
  };

  return {
    dir,
    dbPath: join(dir, DEMO_DB_NAME),
    cleanup() {
      if (done !== null) return done;
      const problem = ownership();
      if (problem !== null) return (done = { removed: false, reason: problem });
      try {
        (deps.remove ?? removeDir)(dir, deps.retries ?? 10);
        done = { removed: true };
      } catch (error) {
        done = { removed: false, reason: `removal failed: ${(error as NodeJS.ErrnoException).code ?? String(error)}` };
      }
      return done;
    },
  };
}
