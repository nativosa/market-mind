import { isMarketMindError, MarketMindError } from "../../domain/errors.js";
import type { Market, ProtocolVersion } from "../../domain/market.js";
import type { Provenance } from "../../domain/provenance.js";
import { GammaKeysetPageSchema, GammaMarketSchema } from "./gammaSchemas.js";
import type { HttpClient } from "./httpClient.js";
import { toMarket, validate } from "./normalize.js";

/** Gamma keyset `order` fields verified live (2026-10-29). `volume_num`, the documented example, is rejected with 422. */
export type DiscoveryOrder = "volume24hr";

export interface ListMarketsQuery {
  limit: number;
  version: ProtocolVersion;
  cursor?: string;
  /** Server-side ordering, always descending. Omitted -> Gamma's default order (Stage 1 URL). */
  order?: DiscoveryOrder;
}

export interface SkippedMarket {
  id: string | null;
  issues: string[];
}

export interface MarketPage {
  markets: Market[];
  /** Records that failed validation. Reported, never silently dropped. */
  skipped: SkippedMarket[];
  nextCursor: string | null;
  provenance: Provenance;
}

export interface GammaClient {
  listOpenMarkets(query: ListMarketsQuery): Promise<MarketPage>;
  getMarket(id: string): Promise<Market>;
}

export function createGammaClient(http: HttpClient, baseUrl: string): GammaClient {
  return {
    async listOpenMarkets({ limit, version, cursor, order }) {
      const params = new URLSearchParams({ closed: "false", limit: String(limit), version });
      if (order) {
        params.set("order", order);
        params.set("ascending", "false");
      }
      if (cursor) params.set("after_cursor", cursor);
      const { body, provenance } = await http.getJson("gamma", "/markets/keyset", `${baseUrl}/markets/keyset?${params.toString()}`);
      const page = validate(GammaKeysetPageSchema, body, "Gamma /markets/keyset response", provenance);

      const markets: Market[] = [];
      const skipped: SkippedMarket[] = [];
      for (const item of page.markets) {
        try {
          markets.push(toMarket(validate(GammaMarketSchema, item, "Gamma market"), provenance));
        } catch (error) {
          if (!isMarketMindError(error)) throw error;
          skipped.push({ id: idOf(item), issues: [error.message, ...(error.details.issues ?? [])] });
        }
      }
      return { markets, skipped, nextCursor: page.next_cursor || null, provenance };
    },

    async getMarket(id) {
      const url = `${baseUrl}/markets/${encodeURIComponent(id)}`;
      try {
        const { body, provenance } = await http.getJson("gamma", "/markets/{id}", url);
        return toMarket(validate(GammaMarketSchema, body, "Gamma market", provenance), provenance);
      } catch (error) {
        // Gamma answers unknown ids with 422 "id is invalid" (observed live).
        if (isMarketMindError(error) && error.kind === "HttpStatus" && error.details.status === 422) {
          throw new MarketMindError("NotFound", `Gamma market ${id} not found (${error.message})`, error.details);
        }
        throw error;
      }
    },
  };
}

function idOf(item: unknown): string | null {
  return item && typeof item === "object" && "id" in item && typeof item.id === "string" ? item.id : null;
}
