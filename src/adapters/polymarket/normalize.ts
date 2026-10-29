import type { z } from "zod";
import { MarketMindError } from "../../domain/errors.js";
import {
  assetIdsFor,
  PROTOCOL_VERSIONS,
  roleForLabel,
  type Market,
  type Outcome,
  type OutcomeAssociation,
  type ProtocolVersion,
} from "../../domain/market.js";
import type { OrderBook } from "../../domain/orderbook.js";
import type { Provenance, ServerTimestamp } from "../../domain/provenance.js";
import type { ClobBook, ClobMarketInfo } from "./clobSchemas.js";
import type { GammaMarket } from "./gammaSchemas.js";

/** Validate with Zod, converting failures into a typed Validation error. */
export function validate<T>(schema: z.ZodType<T>, value: unknown, what: string, provenance?: Provenance): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new MarketMindError("Validation", `Malformed ${what}`, {
    ...(provenance ? { url: provenance.url, status: provenance.httpStatus, timing: provenance.timing } : {}),
    issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  });
}

/** Parse a JSON-encoded string array such as Gamma `outcomes` / `clobTokenIds`. */
export function parseJsonStringArray(value: string | null | undefined, field: string): string[] | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MarketMindError("Validation", `${field} is not valid JSON`, { issues: [`${field}: ${value.slice(0, 120)}`] });
  }
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === "string")) {
    throw new MarketMindError("Validation", `${field} is not a JSON array of strings`, {
      issues: [`${field}: ${value.slice(0, 120)}`],
    });
  }
  return parsed;
}

export function parseVersion(value: string): ProtocolVersion {
  const version = PROTOCOL_VERSIONS.find((v) => v === value);
  if (!version) throw new MarketMindError("Validation", `Unknown protocol version ${JSON.stringify(value)}`);
  return version;
}

export function toMarket(raw: GammaMarket, provenance: Provenance): Market {
  const outcomeLabels = parseJsonStringArray(raw.outcomes, "outcomes");
  if (outcomeLabels === null) {
    throw new MarketMindError("Validation", `Market ${raw.id} has no outcomes`);
  }
  return {
    gammaId: raw.id,
    conditionId: raw.conditionId,
    questionId: raw.questionID ?? null,
    slug: raw.slug,
    question: raw.question,
    version: parseVersion(raw.version),
    active: raw.active,
    closed: raw.closed,
    acceptingOrders: raw.acceptingOrders ?? null,
    enableOrderBook: raw.enableOrderBook ?? null,
    negRisk: raw.negRisk ?? null,
    outcomeLabels,
    clobTokenIds: parseJsonStringArray(raw.clobTokenIds, "clobTokenIds"),
    positionIds: raw.positionIds ?? null,
    endDate: raw.endDate ?? null,
    volume24hr: raw.volume24hr ?? null,
    provenance,
  };
}

/**
 * Build outcomes from Gamma data, selecting the asset ID by protocol version:
 * v1 (CTF) -> clobTokenIds[i] (tokenId), v2 -> positionIds[i] (positionId).
 * Pairing label[i] with id[i] is only provisional until `associateOutcomes` confirms it.
 */
export function selectOutcomes(market: Market): Outcome[] {
  const { ids, kind } = assetIdsFor(market);
  if (ids === null) {
    throw new MarketMindError("Validation", `${market.version} market ${market.gammaId} has no ${kind === "tokenId" ? "clobTokenIds" : "positionIds"}`);
  }
  if (ids.length !== market.outcomeLabels.length) {
    throw new MarketMindError(
      "Validation",
      `Market ${market.gammaId}: ${market.outcomeLabels.length} outcomes but ${ids.length} asset IDs`,
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new MarketMindError("Validation", `Market ${market.gammaId}: duplicate asset IDs`);
  }
  return market.outcomeLabels.map((label, index) => {
    const assetId = ids[index]!;
    return {
      index,
      label,
      role: roleForLabel(label),
      assetId,
      assetIdKind: kind,
      raw: { clobTokenId: market.clobTokenIds?.[index] ?? null, positionId: market.positionIds?.[index] ?? null },
    };
  });
}

/**
 * Confirm outcome<->asset pairing against the CLOB's explicit token list.
 * Every selected asset ID must appear exactly once with the same label as Gamma's outcome at that index,
 * and the CLOB must not list extra tokens. Any disagreement is an AssociationMismatch error.
 */
export function associateOutcomes(outcomes: readonly Outcome[], info: ClobMarketInfo): OutcomeAssociation {
  const problems: string[] = [];
  const byId = new Map<string, string[]>();
  for (const token of info.t) byId.set(token.t, [...(byId.get(token.t) ?? []), token.o]);

  for (const outcome of outcomes) {
    const labels = byId.get(outcome.assetId);
    if (!labels) problems.push(`asset ${outcome.assetId} (${outcome.label}) not listed by CLOB`);
    else if (labels.length > 1) problems.push(`asset ${outcome.assetId} listed ${labels.length} times by CLOB`);
    else if (labels[0] !== outcome.label) {
      problems.push(`asset ${outcome.assetId}: Gamma label ${JSON.stringify(outcome.label)} vs CLOB ${JSON.stringify(labels[0])}`);
    }
  }
  const expected = new Set(outcomes.map((o) => o.assetId));
  for (const id of byId.keys()) if (!expected.has(id)) problems.push(`CLOB lists unexpected asset ${id}`);

  if (problems.length > 0) {
    throw new MarketMindError("AssociationMismatch", "Outcome-to-asset association could not be confirmed", {
      issues: problems,
    });
  }
  return { method: "clob-markets-explicit", gammaIndexCrossCheck: "match" };
}

/** CLOB `timestamp` is epoch milliseconds as a string. Anything else yields nulls, never a guess. */
export function parseServerTimestamp(raw: string | null | undefined): ServerTimestamp {
  if (raw === null || raw === undefined) return { raw: null, epochMs: null, iso: null };
  if (!/^\d{1,15}$/.test(raw)) return { raw, epochMs: null, iso: null };
  const epochMs = Number(raw);
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? { raw, epochMs: null, iso: null } : { raw, epochMs, iso: date.toISOString() };
}

export function toOrderBook(raw: ClobBook, requestedAssetId: string, provenance: Provenance): OrderBook {
  return {
    requestedAssetId,
    assetId: raw.asset_id,
    conditionId: raw.market,
    bids: raw.bids.map((l) => ({ price: l.price, size: l.size })),
    asks: raw.asks.map((l) => ({ price: l.price, size: l.size })),
    tickSize: raw.tick_size ?? null,
    minOrderSize: raw.min_order_size ?? null,
    lastTradePrice: raw.last_trade_price ?? null,
    negRisk: raw.neg_risk ?? null,
    hash: raw.hash ?? null,
    serverTimestamp: parseServerTimestamp(raw.timestamp),
    provenance,
  };
}
