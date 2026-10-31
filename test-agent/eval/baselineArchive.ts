// The preserved v0.5.0 evaluation baseline (offline; no Claude invocation):
//
//   npx tsx test-agent/eval/baselineArchive.ts verify [dir]     # hashes, then a regrade into a temp directory
//   npx tsx test-agent/eval/baselineArchive.ts manifest <dir> <archive.tar.gz>
//
// The raw runs hold local paths and session ids, so they stay in the git-ignored archive. The committed
// manifest holds only file hashes and the recorded verdicts and metrics: enough to prove that an archive is
// the original, and that the current evaluator still grades it the same way. Verification never writes to
// the archive; see docs/evaluation-archive/README.md for restoring it.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { REPO } from "../processes.js";
import { evaluateDir } from "./evaluate.js";
import { stableJson } from "./schema.js";

export const BASELINE_MANIFEST = join(REPO, "docs", "evaluation-archive", "v0.5.0-baseline.manifest.json");
export const BASELINE_ARCHIVE = join(REPO, ".eval-out", "archive", "v0.5.0-baseline");
/** Where the archive is expected; MARKETMIND_BASELINE_DIR overrides it (for example after a restore elsewhere). */
export const baselineDir = () => process.env.MARKETMIND_BASELINE_DIR ?? BASELINE_ARCHIVE;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const BaselineManifest = z
  .object({
    contract: z.literal("marketmind.eval.baseline-manifest/1"),
    baseline: z.literal("v0.5.0"),
    graderRevision: z.string(),
    archive: z.object({ file: z.string(), sha256: sha }).strict(),
    files: z.array(z.object({ path: z.string(), bytes: z.number().int(), sha256: sha }).strict()),
    runs: z.array(z.object({ runKey: z.string(), checks: z.array(z.string()), deterministicVerdict: z.string(), overallVerdict: z.string() }).strict()),
    metrics: z.record(z.string(), z.string()),
  })
  .strict();
export type BaselineManifest = z.infer<typeof BaselineManifest>;

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[])
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replace(/\\/g, "/"))
    .sort();
}

interface RecordedResult {
  runKey: string;
  checks: { id: string; verdict: string }[];
  deterministicVerdict: string;
  overallVerdict: string;
}
const runOf = (r: RecordedResult): BaselineManifest["runs"][number] => ({ runKey: r.runKey, checks: r.checks.map((c) => `${c.id}:${c.verdict}`), deterministicVerdict: r.deterministicVerdict, overallVerdict: r.overallVerdict });
const metricsOf = (card: { metrics: Record<string, { text: string }> }) => Object.fromEntries(Object.entries(card.metrics).map(([k, m]) => [k, m.text]));
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const runKeysIn = (dir: string) => readdirSync(dir).filter((k) => /^[PS]\d\d-r\d+$/.test(k)).sort();

export function buildManifest(dir: string, archiveFile: string, archiveSha256: string): BaselineManifest {
  const card = readJson<{ grader: { revision: string }; metrics: Record<string, { text: string }> }>(join(dir, "scorecard.json"));
  return {
    contract: "marketmind.eval.baseline-manifest/1",
    baseline: "v0.5.0",
    graderRevision: card.grader.revision,
    archive: { file: archiveFile, sha256: archiveSha256 },
    files: listFiles(dir).map((path) => {
      const data = readFileSync(join(dir, path));
      return { path, bytes: data.length, sha256: sha256(data) };
    }),
    runs: runKeysIn(dir).map((k) => runOf(readJson<RecordedResult>(join(dir, k, "result.json")))),
    metrics: metricsOf(card),
  };
}

/** Differences between a directory and the manifest: missing, extra or changed files. */
export function fileProblems(dir: string, manifest: BaselineManifest): string[] {
  if (!existsSync(dir)) return [`${dir} does not exist`];
  const actual = new Set(listFiles(dir));
  const problems = [...actual].filter((p) => !manifest.files.some((f) => f.path === p)).map((p) => `unexpected file ${p}`);
  for (const f of manifest.files) {
    if (!actual.has(f.path)) problems.push(`missing file ${f.path}`);
    else if (sha256(readFileSync(join(dir, f.path))) !== f.sha256) problems.push(`changed file ${f.path}`);
  }
  return problems;
}

/** Regrades into a temp directory and compares every run's checks and verdicts, and the metrics, with the manifest. */
export async function regradeProblems(dir: string, manifest: BaselineManifest): Promise<string[]> {
  const output = mkdtempSync(join(tmpdir(), "mm-baseline-regrade-"));
  try {
    const { results, scorecard } = await evaluateDir(dir, { outputDir: output });
    const problems: string[] = [];
    const current = new Map(results.map((r) => [r.runKey, runOf(r)]));
    for (const run of manifest.runs) {
      const now = current.get(run.runKey);
      if (!now) problems.push(`${run.runKey}: not regraded`);
      else if (JSON.stringify(now) !== JSON.stringify(run)) problems.push(`${run.runKey}: verdicts differ from the recorded run`);
    }
    if (results.length !== manifest.runs.length) problems.push(`${results.length} runs regraded, ${manifest.runs.length} recorded`);
    const metrics = metricsOf(scorecard);
    for (const [k, text] of Object.entries(manifest.metrics)) if (metrics[k] !== text) problems.push(`metric ${k}: ${metrics[k]} now, ${text} recorded`);
    return problems;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

export const readBaselineManifest = () => BaselineManifest.parse(readJson(BASELINE_MANIFEST));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  if (command === "manifest" && first && second) {
    const archive = readFileSync(second);
    writeFileSync(BASELINE_MANIFEST, stableJson(buildManifest(resolve(first), "v0.5.0-baseline.tar.gz", sha256(archive))));
    console.log(`wrote ${relative(REPO, BASELINE_MANIFEST)}`);
  } else if (command === "verify") {
    const dir = resolve(first ?? baselineDir());
    const manifest = readBaselineManifest();
    const problems = fileProblems(dir, manifest);
    if (problems.length === 0) problems.push(...(await regradeProblems(dir, manifest)), ...fileProblems(dir, manifest));
    for (const p of problems) console.error(p);
    console.log(problems.length === 0 ? `baseline verified: ${manifest.files.length} files, ${manifest.runs.length} runs regraded with the same verdicts and metrics` : `baseline NOT verified: ${problems.length} problems`);
    if (problems.length > 0) process.exitCode = 1;
  } else {
    console.error("usage: npx tsx test-agent/eval/baselineArchive.ts verify [dir] | manifest <dir> <archive.tar.gz>");
    process.exitCode = 2;
  }
}
