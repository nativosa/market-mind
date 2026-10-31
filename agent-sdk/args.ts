// Validated command-line arguments. Produces the exact $ARGUMENTS string the skill body expects:
//   Mode A: "<gammaId> [objective]"      Mode B: "discover <v1|v2> [objective]"
// In fixture mode the arguments are the evaluation scenario's own (identical to the CLI baseline prompt),
// so results stay comparable; a custom objective is rejected there.
import { promptFor, scenarioById } from "../test-agent/eval/scenarios.js";
import type { InvestigationRequest } from "./contract.js";

/** Hard ceiling for --max-budget-usd, whatever the caller asks for. */
export const HARD_BUDGET_CAP_USD = 0.5;
export const TIMEOUT_BOUNDS_MS = { min: 10_000, max: 900_000, default: 300_000 } as const;
export const OBJECTIVE_MAX = 500;
export const USAGE =
  "usage: npm run agent -- investigate (--market-id <gammaId> | --discover [--version v1|v2]) [--objective <text>] [--fixture <scenario>] " +
  `[--max-budget-usd <0-${HARD_BUDGET_CAP_USD}>] [--timeout-ms <ms>] [--out <dir>] [--json] [--dry-run]`;

export class UsageError extends Error {}

export interface CliArgs {
  request: InvestigationRequest;
  maxBudgetUsd: number | null;
  timeoutMs: number;
  dryRun: boolean;
  json: boolean;
  out: string | null;
}

const FLAGS_WITH_VALUE = new Set(["--market-id", "--version", "--objective", "--fixture", "--max-budget-usd", "--timeout-ms", "--out"]);
const BOOLEAN_FLAGS = new Set(["--discover", "--json", "--dry-run"]);

/**
 * `evaluationProbe` is set only by the evaluation harness (test-agent/sdkRun.ts), never by the CLI: it
 * lets --fixture name a permission probe scenario, whose run then has no allow rules.
 */
export function parseArgs(argv: string[], internal: { evaluationProbe?: boolean } = {}): CliArgs {
  const [command, ...rest] = argv;
  if (command !== "investigate") throw new UsageError(USAGE);
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (BOOLEAN_FLAGS.has(a)) {
      if (bools.has(a)) throw new UsageError(`${a} given twice`);
      bools.add(a);
    } else if (FLAGS_WITH_VALUE.has(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      if (values.has(a)) throw new UsageError(`${a} given twice`);
      values.set(a, v);
      i++;
    } else throw new UsageError(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
  }

  const marketId = values.get("--market-id") ?? null;
  const discover = bools.has("--discover");
  if ((marketId === null) === !discover) throw new UsageError(`give exactly one of --market-id or --discover\n${USAGE}`);
  if (marketId !== null && !/^\d{1,20}$/.test(marketId)) throw new UsageError("--market-id must be a numeric Gamma id (1 to 20 digits)");
  const versionArg = values.get("--version");
  if (versionArg !== undefined && !discover) throw new UsageError("--version applies only to --discover");
  if (versionArg !== undefined && versionArg !== "v1" && versionArg !== "v2") throw new UsageError("--version must be v1 or v2");
  const version = discover ? ((versionArg) ?? "v1") : null;

  const objectiveArg = values.get("--objective");
  let objective: string | null = null;
  if (objectiveArg !== undefined) {
    const o = objectiveArg.trim();
    // eslint-disable-next-line no-control-regex
    if (o === "" || o.length > OBJECTIVE_MAX || /[\u0000-\u001f\u007f]/.test(o)) throw new UsageError(`--objective must be 1-${OBJECTIVE_MAX} printable characters on one line`);
    objective = o;
  }

  const fixture = values.get("--fixture") ?? null;
  let args: string;
  let syntheticAuthorized = false;
  let allowRules: "marketmind" | "none" = "marketmind";
  if (fixture !== null) {
    const s = scenarioById(fixture);
    if (s?.kind === "probe" && internal.evaluationProbe === true && s.withoutAllowRules === true) allowRules = "none";
    else if (!s || s.kind !== "golden") throw new UsageError(`--fixture must name a golden evaluation scenario (S01-S12), got ${JSON.stringify(fixture)}`);
    if (objective !== null) throw new UsageError("--objective is not allowed with --fixture (the scenario's objective is used, for comparability)");
    if (s.mode === "A" && marketId !== s.marketId) throw new UsageError(`fixture ${s.id} investigates market ${s.marketId}; pass --market-id ${s.marketId}`);
    if (s.mode === "B" && (!discover || version !== "v1")) throw new UsageError(`fixture ${s.id} is a discovery scenario; pass --discover --version v1`);
    args = promptFor(s).replace(/^\/investigate-market /, "");
    syntheticAuthorized = s.syntheticAuthorized;
  } else {
    const target = discover ? `discover ${version}` : marketId!;
    args = objective === null ? target : `${target} ${objective}`;
  }

  const budgetArg = values.get("--max-budget-usd");
  let maxBudgetUsd: number | null = null;
  if (budgetArg !== undefined) {
    const b = Number(budgetArg);
    if (!/^\d+(\.\d+)?$/.test(budgetArg) || !(b > 0) || b > HARD_BUDGET_CAP_USD) throw new UsageError(`--max-budget-usd must be greater than 0 and at most ${HARD_BUDGET_CAP_USD}`);
    maxBudgetUsd = b;
  }
  const dryRun = bools.has("--dry-run");
  if (!dryRun && maxBudgetUsd === null) throw new UsageError("--max-budget-usd is required for a real run (or use --dry-run)");

  const timeoutArg = values.get("--timeout-ms");
  const timeoutMs = timeoutArg === undefined ? TIMEOUT_BOUNDS_MS.default : Number(timeoutArg);
  if (!/^\d+$/.test(timeoutArg ?? "0") || timeoutMs < TIMEOUT_BOUNDS_MS.min || timeoutMs > TIMEOUT_BOUNDS_MS.max) {
    throw new UsageError(`--timeout-ms must be an integer from ${TIMEOUT_BOUNDS_MS.min} to ${TIMEOUT_BOUNDS_MS.max}`);
  }

  return {
    request: {
      mode: discover ? "B" : "A",
      marketId,
      version,
      objective,
      arguments: args,
      server: fixture === null ? "live" : "fixture",
      fixtureScenario: fixture === null ? null : scenarioById(fixture)!.id,
      syntheticAuthorized,
      allowRules,
    },
    maxBudgetUsd,
    timeoutMs,
    dryRun,
    json: bools.has("--json"),
    out: values.get("--out") ?? null,
  };
}
