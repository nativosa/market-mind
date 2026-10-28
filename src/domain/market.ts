import type { Provenance } from "./provenance.js";

export type ProtocolVersion = "v1" | "v2";
export const PROTOCOL_VERSIONS: readonly ProtocolVersion[] = ["v1", "v2"];

/** Normalized Gamma market. Identifiers are preserved verbatim as strings. */
export interface Market {
  gammaId: string;
  conditionId: string;
  questionId: string | null;
  slug: string;
  question: string;
  version: ProtocolVersion;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean | null;
  enableOrderBook: boolean | null;
  negRisk: boolean | null;
  outcomeLabels: string[];
  /** Parsed from Gamma `clobTokenIds` (a JSON-encoded string). CLOB asset IDs for v1 (CTF) markets. */
  clobTokenIds: string[] | null;
  /** Gamma `positionIds`. CLOB asset IDs for v2 (Protocol V2) markets only. */
  positionIds: string[] | null;
  endDate: string | null;
  provenance: Provenance;
}

export type OutcomeRole = "YES" | "NO";
export type AssetIdKind = "tokenId" | "positionId";

export interface Outcome {
  index: number;
  label: string;
  /** Set only when the label is exactly "Yes"/"No" (case-insensitive, trimmed). */
  role: OutcomeRole | null;
  /** Unified CLOB trading identifier (`token_id` / `asset_id` on the wire). */
  assetId: string;
  assetIdKind: AssetIdKind;
  raw: { clobTokenId: string | null; positionId: string | null };
}

export interface OutcomeAssociation {
  method: "clob-markets-explicit";
  gammaIndexCrossCheck: "match";
}

export interface Eligibility {
  eligible: boolean;
  /** Why the market cannot be inspected. */
  reasons: string[];
  /** Inspectable, but worth flagging. */
  warnings: string[];
}

export function isBinary(market: Market): boolean {
  return market.outcomeLabels.length === 2;
}

export function roleForLabel(label: string): OutcomeRole | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === "yes") return "YES";
  if (normalized === "no") return "NO";
  return null;
}

/** Asset IDs that the CLOB uses for this market's outcomes, chosen by protocol version. */
export function assetIdsFor(market: Market): { ids: string[] | null; kind: AssetIdKind } {
  return market.version === "v2"
    ? { ids: market.positionIds, kind: "positionId" }
    : { ids: market.clobTokenIds, kind: "tokenId" };
}

export function inspectEligibility(market: Market): Eligibility {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (market.enableOrderBook === null) reasons.push("enableOrderBook is missing");
  else if (!market.enableOrderBook) reasons.push("order book is not enabled");
  if (!isBinary(market)) reasons.push(`expected 2 outcomes, found ${market.outcomeLabels.length}`);
  const { ids, kind } = assetIdsFor(market);
  if (ids === null) reasons.push(`no ${kind === "tokenId" ? "clobTokenIds" : "positionIds"} for ${market.version} market`);
  else if (ids.length !== 2) reasons.push(`expected 2 asset IDs, found ${ids.length}`);
  else if (ids[0] === ids[1]) reasons.push("asset IDs are not unique");
  if (market.closed) warnings.push("market is closed");
  if (!market.active) warnings.push("market is not active");
  if (market.acceptingOrders === null) warnings.push("acceptingOrders is missing");
  else if (!market.acceptingOrders) warnings.push("market is not accepting orders");
  return { eligible: reasons.length === 0, reasons, warnings };
}
