// The preserved v0.5.0 evaluation baseline (offline; no Claude invocation):
//
//   npx tsx test-agent/eval/baselineArchive.ts verify [dir]     # hashes, then a regrade into a temp directory
//   npx tsx test-agent/eval/baselineArchive.ts manifest <dir> <archive.tar.gz>
//
// The raw runs hold local paths and session ids, so they stay in the git-ignored archive. The committed
// manifest holds only file hashes and the recorded verdicts and metrics: enough to prove that an archive is
// the original. A regrade must then reproduce the recorded results exactly, apart from the differences listed
// one by one in a committed delta file for the current grader revision; anything else fails, and so does a
// listed difference that did not occur. Verification never writes to the archive; see
// docs/evaluation-archive/README.md for restoring it.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { REPO } from "../processes.js";
import { evaluateDir } from "./evaluate.js";
import { GRADER_REVISION } from "./graders.js";
import { stableJson } from "./schema.js";

export const BASELINE_MANIFEST = join(REPO, "docs", "evaluation-archive", "v0.5.0-baseline.manifest.json");
export const BASELINE_DELTAS = join(REPO, "docs", "evaluation-archive", "v0.5.0-regrade-deltas.json");
export const BATCH3_DELTAS = join(REPO, "docs", "evaluation-archive", "v0.7.0-regrade-deltas.json");
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

/** One allowed difference between a recorded result and its regrade: an exact field, with both exact values. */
const Delta = z
  .object({
    scope: z.enum(["run", "scorecard"]),
    runKey: z.string().nullable(),
    field: z.string().regex(/^[^*?]+$/, "a delta names one exact field"),
    from: z.unknown(),
    to: z.unknown(),
    reason: z.string().min(40),
  })
  .strict();
export type Delta = z.infer<typeof Delta>;
export const RegradeDeltas = z
  .object({ contract: z.literal("marketmind.eval.regrade-deltas/1"), recorded: z.string(), graderRevision: z.string(), note: z.string(), deltas: z.array(Delta) })
  .strict();
export type RegradeDeltas = z.infer<typeof RegradeDeltas>;

/** Fields added or reworded since a run was graded; they carry no grading result. D9's detail states the application versions. */
const NOT_COMPARED = [".contract", ".graderRevision", ".execution", ".reliability", ".rubricSet", ".checks[D9].detail"];

export interface Difference {
  field: string;
  from: unknown;
  to: unknown;
}

/** Leaf differences between two JSON values, whatever their key order. Lists of objects with an id are compared by id, so an added or lost entry is one difference. */
export function differencesBetween(a: unknown, b: unknown, field = ""): Difference[] {
  if (stableJson(a) === stableJson(b)) return [];
  const objects = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  const keyed = (x: unknown): x is { id: string }[] => Array.isArray(x) && x.every((y) => objects(y) && typeof y.id === "string");
  if (keyed(a) && keyed(b)) return [...new Set([...a, ...b].map((x) => x.id))].flatMap((id) => differencesBetween(a.find((x) => x.id === id), b.find((x) => x.id === id), `${field}[${id}]`));
  if (objects(a) && objects(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => differencesBetween(a[k], b[k], `${field}.${k}`));
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.flatMap((x, i) => differencesBetween(x, b[i], `${field}[${i}]`));
  return [{ field, from: a ?? null, to: b ?? null }];
}

/** What a scorecard reports about results, limited to the metrics the recorded one had. */
function scorecardView(card: { metrics: Record<string, { text: string }>; accounting: Record<string, unknown>; safety: Record<string, unknown>; assertionsRequiringReview: unknown }, metrics: string[]) {
  const { deterministic, overall, runStatus, contamination, reviews } = card.accounting;
  return { metrics: Object.fromEntries(metrics.map((k) => [k, card.metrics[k]?.text])), accounting: { deterministic, overall, runStatus, contamination, reviews }, safety: { status: card.safety.status, provenViolations: card.safety.provenViolations }, assertionsRequiringReview: card.assertionsRequiringReview };
}
type CardView = ReturnType<typeof scorecardView>;

export interface RegradeComparison {
  recorded: Map<string, unknown>;
  regraded: Map<string, unknown>;
  scorecards?: { recorded: CardView; regraded: CardView };
}

/** Every way a regrade departs from the record and its delta file. Empty means exactly the declared differences occurred. */
export function regradeDrift(c: RegradeComparison, deltas: RegradeDeltas): string[] {
  const problems: string[] = [];
  if (deltas.graderRevision !== GRADER_REVISION) problems.push(`the delta file is for ${deltas.graderRevision}, the grader is ${GRADER_REVISION}`);
  for (const k of c.recorded.keys()) if (!c.regraded.has(k)) problems.push(`${k}: not regraded`);
  for (const k of c.regraded.keys()) if (!c.recorded.has(k)) problems.push(`${k}: regraded but not recorded`);
  const observed: (Difference & { scope: Delta["scope"]; runKey: string | null })[] = [
    ...[...c.recorded].flatMap(([k, r]) => (c.regraded.has(k) ? differencesBetween(r, c.regraded.get(k)).map((d) => ({ ...d, scope: "run" as const, runKey: k })) : [])),
    ...(c.scorecards ? differencesBetween(c.scorecards.recorded, c.scorecards.regraded).map((d) => ({ ...d, scope: "scorecard" as const, runKey: null })) : []),
  ].filter((d) => !NOT_COMPARED.some((n) => d.field === n || d.field.startsWith(`${n}.`)));
  const key = (d: { scope: string; runKey: string | null; field: string; from: unknown; to: unknown }) => stableJson([d.scope, d.runKey, d.field, d.from ?? null, d.to ?? null]);
  const declared = new Set(deltas.deltas.map(key));
  const seen = new Set(observed.map(key));
  for (const d of observed) if (!declared.has(key(d))) problems.push(`undeclared difference: ${d.runKey ?? "scorecard"} ${d.field}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
  for (const d of deltas.deltas) if (!seen.has(key(d))) problems.push(`declared difference did not occur: ${d.runKey ?? "scorecard"} ${d.field}`);
  return problems;
}

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

/**
 * Regrades into a temp directory, then compares every field of every result, and the scorecard's reported
 * figures, with the recorded ones in the archive. Only differences declared in the delta file may remain.
 */
export async function regradeProblems(dir: string, manifest: BaselineManifest, deltas: RegradeDeltas = readBaselineDeltas()): Promise<string[]> {
  const output = mkdtempSync(join(tmpdir(), "mm-baseline-regrade-"));
  try {
    const { results } = await evaluateDir(dir, { outputDir: output });
    type Card = Parameters<typeof scorecardView>[0];
    const recordedCard = readJson<Card>(join(dir, "scorecard.json"));
    return regradeDrift(
      {
        recorded: new Map(manifest.runs.map((r) => [r.runKey, readJson(join(dir, r.runKey, "result.json"))])),
        regraded: new Map(results.map((r) => [r.runKey, JSON.parse(JSON.stringify(r)) as unknown])),
        scorecards: { recorded: scorecardView(recordedCard, Object.keys(manifest.metrics)), regraded: scorecardView(readJson<Card>(join(output, "scorecard.json")), Object.keys(manifest.metrics)) },
      },
      deltas,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

export const readBaselineManifest = () => BaselineManifest.parse(readJson(BASELINE_MANIFEST));
export const readBaselineDeltas = () => RegradeDeltas.parse(readJson(BASELINE_DELTAS));
export const readBatch3Deltas = () => RegradeDeltas.parse(readJson(BATCH3_DELTAS));

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
    console.log(problems.length === 0 ? `baseline verified: ${manifest.files.length} files, ${manifest.runs.length} runs reproduce the record with ${readBaselineDeltas().deltas.length} declared differences` : `baseline NOT verified: ${problems.length} problems`);
    if (problems.length > 0) process.exitCode = 1;
  } else {
    console.error("usage: npx tsx test-agent/eval/baselineArchive.ts verify [dir] | manifest <dir> <archive.tar.gz>");
    process.exitCode = 2;
  }
}
