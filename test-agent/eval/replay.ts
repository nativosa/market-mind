// D9 replay fidelity (eval-graders/4). A recorded MarketMind tool result is compared with an in-process
// replay of the same call over the same fixture revision. The recorded result is never modified.
//
// Provenance versus substance: every MarketMind success envelope carries the server's `appVersion`
// (APP_VERSION of the build that answered). That field identifies who answered, not what was answered,
// so it alone is set aside, and only at the envelope's top level. Everything else is compared as before
// (after the existing volatile-field normalization): market data, metrics, nested run/metrics
// `appVersion` values that come from the database, analytics versions and the contract id.
//
// Compatibility rules, checked per call before any comparison:
//   - the recorded result must be a complete MarketMind envelope (success: string `contract` and
//     `appVersion`; error: the marketmind.error/1 contract), otherwise the call is `incomplete`;
//   - recorded and replayed results must carry the same contract id, otherwise `incompatible`;
//   - the set of `analyticsVersion` values anywhere in the result must be equal, otherwise `incompatible`.
// An incomplete or incompatible call is never counted as identical: D9 is then NOT_EVALUATED, unless
// another call shows a substantive mismatch, which is a FAIL.
import { normalize } from "./golden.js";

export type ReplayOutcome = "identical" | "identical_apart_from_app_version" | "mismatch" | "incompatible" | "incomplete";

export interface ReplayComparison {
  outcome: ReplayOutcome;
  recordedAppVersion: string | null;
  replayAppVersion: string | null;
  reason: string | null;
}

export interface Answer {
  status: "ok" | "error" | "missing";
  json: unknown;
}

export const ERROR_CONTRACT = "marketmind.error/1";
export const COMPATIBILITY_ASSUMPTION =
  "the envelope appVersion is server provenance only; replay is treated as compatible when the tool contract id and every analyticsVersion value match";

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function analyticsVersions(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) analyticsVersions(v, out);
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value)) {
      if (k === "analyticsVersion") out.add(JSON.stringify(v));
      analyticsVersions(v, out);
    }
  return out;
}
const sorted = (s: Set<string>) => [...s].sort();

/** The envelope without its top-level appVersion; nested values are untouched. */
function withoutEnvelopeVersion(json: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...json };
  delete rest.appVersion;
  return rest;
}

export function compareReplay(recorded: Answer, replay: Answer): ReplayComparison {
  const rec = recorded.json;
  const rep = replay.json;
  const version = (v: unknown) => (isRecord(v) && typeof v.appVersion === "string" ? v.appVersion : null);
  const base = { recordedAppVersion: version(rec), replayAppVersion: version(rep) };
  const result = (outcome: ReplayOutcome, reason: string | null = null): ReplayComparison => ({ outcome, ...base, reason });

  if (recorded.status === "missing") return result("incomplete", "no recorded result");
  if (!isRecord(rec) || typeof rec.contract !== "string") return result("incomplete", "recorded result is not a MarketMind envelope");
  if (recorded.status === "ok" && typeof rec.appVersion !== "string") return result("incomplete", "recorded success envelope has no appVersion");
  if (recorded.status === "error" && rec.contract !== ERROR_CONTRACT) return result("incomplete", `recorded error is not ${ERROR_CONTRACT}`);
  if (recorded.status !== replay.status) return result("mismatch", `status ${recorded.status} recorded, ${replay.status} replayed`);
  if (!isRecord(rep) || typeof rep.contract !== "string") return result("incompatible", "replay did not return a MarketMind envelope");
  if (rec.contract !== rep.contract) return result("incompatible", `contract ${rec.contract} recorded, ${rep.contract} replayed`);
  const ra = sorted(analyticsVersions(rec));
  const pa = sorted(analyticsVersions(rep));
  if (JSON.stringify(ra) !== JSON.stringify(pa)) return result("incompatible", `analyticsVersion ${ra.join(",") || "none"} recorded, ${pa.join(",") || "none"} replayed`);
  const same = JSON.stringify(normalize(withoutEnvelopeVersion(rec))) === JSON.stringify(normalize(withoutEnvelopeVersion(rep)));
  if (!same) return result("mismatch", "substantive result differs");
  return result(base.recordedAppVersion === base.replayAppVersion ? "identical" : "identical_apart_from_app_version");
}

export interface ReplaySummary {
  verdict: "PASS" | "FAIL" | "NOT_EVALUATED";
  detail: string;
  evidence: string[];
}

/** Aggregates per-call comparisons into the D9 verdict. `key` labels a call in the evidence. */
export function summarizeReplay(items: { key: string; comparison: ReplayComparison }[]): ReplaySummary {
  const compared = items.length;
  if (compared === 0) return { verdict: "NOT_EVALUATED", detail: "0/0 replayed results identical", evidence: [] };
  const of = (o: ReplayOutcome) => items.filter((i) => i.comparison.outcome === o);
  const mismatches = of("mismatch");
  const unusable = items.filter((i) => i.comparison.outcome === "incompatible" || i.comparison.outcome === "incomplete");
  const identical = compared - mismatches.length - unusable.length;
  const recorded = [...new Set(items.map((i) => i.comparison.recordedAppVersion).filter((v): v is string => v !== null))].sort();
  const replayed = [...new Set(items.map((i) => i.comparison.replayAppVersion).filter((v): v is string => v !== null))].sort();
  const versionsDiffer = of("identical_apart_from_app_version").length > 0 || JSON.stringify(recorded) !== JSON.stringify(replayed);
  // Same-version runs keep the eval-graders/3 wording; a version difference is always stated explicitly.
  const versions = versionsDiffer ? `; recorded appVersion ${recorded.join(",") || "none"}, replay appVersion ${replayed.join(",") || "none"}; assumption: ${COMPATIBILITY_ASSUMPTION}` : "";
  const evidence = [...mismatches.map((i) => i.key), ...unusable.map((i) => `${i.comparison.outcome}: ${i.key}: ${i.comparison.reason ?? ""}`)];
  const unusableNote = unusable.length > 0 ? `; ${unusable.length} not comparable (${of("incompatible").length} incompatible, ${of("incomplete").length} incomplete historical evidence)` : "";
  const detail = `${identical}/${compared} replayed results identical${versionsDiffer && identical > 0 ? " apart from envelope appVersion" : ""}${unusableNote}${versions}`;
  if (mismatches.length > 0) return { verdict: "FAIL", detail, evidence };
  if (unusable.length > 0) return { verdict: "NOT_EVALUATED", detail, evidence };
  return { verdict: "PASS", detail, evidence };
}
