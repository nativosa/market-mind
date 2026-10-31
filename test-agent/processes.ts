// Shared runner helpers (moved unchanged from run.ts so the SDK harness can reuse them): content hashes
// for integrity checks, investigator file hashes, and process-tree cleanup by command-line tag.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunMeta } from "./eval/schema.js";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
export const BASELINE_TAG = "v0.5.0";
export const INVESTIGATOR_FILES = { agent: ".claude/agents/market-investigator.md", skill: ".claude/skills/investigate-market/SKILL.md", settings: ".claude/settings.json" } as const;

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const git = (...args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
export const repoState = () => sha256(`${git("status", "--porcelain").stdout}\n${git("diff").stdout}`);

/** Hash of every file below a directory (relative path + content), for detecting writes. */
export function treeHash(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else parts.push(`${relative(dir, p)}\0${sha256(readFileSync(p))}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return sha256(parts.join("\n"));
}

export function investigator(): RunMeta["investigator"] {
  const hash = (p: string) => sha256(readFileSync(join(REPO, p)));
  const baseline = (p: string) => {
    const r = spawnSync("git", ["show", `${BASELINE_TAG}:${p}`], { cwd: REPO });
    return r.status === 0 ? sha256(r.stdout) : null;
  };
  const files = Object.values(INVESTIGATOR_FILES);
  const base = files.map(baseline);
  const head = git("rev-parse", "HEAD");
  const dirty = git("diff", "--quiet", "HEAD", "--", ...files);
  return {
    agentSha256: hash(INVESTIGATOR_FILES.agent),
    skillSha256: hash(INVESTIGATOR_FILES.skill),
    settingsSha256: hash(INVESTIGATOR_FILES.settings),
    baselineTag: BASELINE_TAG,
    matchesBaseline: base.some((b) => b === null) ? null : files.every((f, i) => hash(f) === base[i]),
    gitCommit: head.status === 0 ? head.stdout.trim() : null,
    gitDirty: dirty.status === null ? null : dirty.status !== 0,
  };
}

/** Process ids whose command line contains `tag` (excluding the querying process itself). */
export function processesTagged(tag: string): number[] {
  if (process.platform === "win32") {
    const ps = spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${tag}%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8" });
    return ps.stdout.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n !== process.pid);
  }
  const pg = spawnSync("pgrep", ["-f", tag], { encoding: "utf8" });
  return pg.stdout.split(/\s+/).filter(Boolean).map(Number).filter((n) => n !== process.pid);
}

export function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}
