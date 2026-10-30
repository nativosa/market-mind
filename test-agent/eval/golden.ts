// Golden facts for evaluation, derived by calling the real MarketMind server in process over the same
// fixture revision the investigator saw. This checks the agent against MarketMind's own deterministic
// computations; it does not independently verify those computations (that is the unit suite's job).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryOutput, InspectOutput, ScanOutput } from "../../src/mcp/contracts.js";
import { call, connect, errorOf, type Connected } from "../../test/mcpFixtures.js";
import { agentRoutes, fixtureDigest, seedEvalDb, type SeedManifest } from "../fixtures.js";
import type { EvalScenario } from "./scenarios.js";

/** Warnings that disqualify a scan candidate under the investigator's documented Mode B rule. */
export const DISQUALIFYING_WARNINGS = ["EXTREME_PRICE", "END_DATE_PASSED", "SUSPICIOUS_BOOK_ADMITTED"];

export interface Golden {
  fixtureDigest: string;
  manifest: SeedManifest;
  /** Market the investigation must end up on (Mode A: the argument; Mode B: the rule applied to the scan). */
  marketId: string | null;
  scan: ScanOutput | null;
  inspect: InspectOutput | null;
  history: HistoryOutput | null;
  historyError: string | null;
}

export interface GoldenSession {
  manifest: SeedManifest;
  fixtureDigest: string;
  /** Replays one tool call against the in-process server; returns parsed success JSON or the error object. */
  replay: (tool: string, args: Record<string, unknown>) => Promise<{ status: "ok" | "error"; json: unknown }>;
  close: () => Promise<void>;
}

/** A fresh seeded (or missing) database plus a connected in-process server, as the scenario prescribes. */
export async function openGolden(db: EvalScenario["db"]): Promise<GoldenSession> {
  const dir = mkdtempSync(join(tmpdir(), "mm-golden-"));
  const path = join(dir, db === "missing" ? "absent.sqlite" : "golden.sqlite");
  const manifest = db === "missing" ? { runs: [], observations: [] } : seedEvalDb(path);
  // The digest always describes the full fixture revision, whichever database mode the scenario uses.
  const full = db === "missing" ? seedEvalDb(join(dir, "digest.sqlite")) : manifest;
  let c: Connected;
  try {
    c = await connect({ routes: agentRoutes(), dbPath: path });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    manifest,
    fixtureDigest: fixtureDigest(full),
    replay: async (tool, args) => {
      const r = await call(c, tool, args);
      // Errors travel as their full marketmind.error/1 JSON text, exactly as Claude Code shows them to the model.
      if (r.isError) {
        errorOf(r); // validates the error shape
        return { status: "error", json: JSON.parse(r.content[0]!.text!) as unknown };
      }
      return { status: "ok", json: r.structuredContent ?? null };
    },
    close: async () => {
      await c.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function computeGolden(s: EvalScenario): Promise<Golden> {
  const g = await openGolden(s.db);
  try {
    const parse = async <T>(tool: string, args: Record<string, unknown>) => {
      const r = await g.replay(tool, args);
      return r.status === "ok" ? (r.json as T) : null;
    };
    let scan: ScanOutput | null = null;
    let marketId = s.marketId;
    if (s.mode === "B") {
      scan = await parse<ScanOutput>("scan_markets", { version: "v1" });
      marketId = scan?.ranked.items.find((i) => !i.warningCodes.some((w) => DISQUALIFYING_WARNINGS.includes(w)))?.gammaId ?? null;
    }
    const inspect = marketId ? await parse<InspectOutput>("inspect_market", { marketId }) : null;
    let history: HistoryOutput | null = null;
    let historyError: string | null = null;
    if (marketId) {
      const r = await g.replay("get_market_history", { marketId, limit: 10, ...(s.syntheticAuthorized ? { includeSynthetic: true } : {}) });
      if (r.status === "ok") history = r.json as HistoryOutput;
      else historyError = (r.json as { error: { category: string } }).error.category;
    }
    return { fixtureDigest: g.fixtureDigest, manifest: g.manifest, marketId, scan, inspect, history, historyError };
  } finally {
    await g.close();
  }
}

/** Fields that legitimately differ between the investigator's run and a replay (clocks, budgets, file sizes). */
const VOLATILE = new Set(["generatedAt", "firstAttemptStartedAt", "finalAttemptStartedAt", "responseReceivedAt", "durationMs", "pairSkewMs", "budget", "window", "footprintBytes"]);

/** Deep copy without volatile fields, with object keys sorted (stable comparison and serialization). */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !VOLATILE.has(k))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}
