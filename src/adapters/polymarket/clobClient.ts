import type { OrderBook } from "../../domain/orderbook.js";
import type { Provenance } from "../../domain/provenance.js";
import { ClobBookSchema, ClobMarketInfoSchema, type ClobMarketInfo } from "./clobSchemas.js";
import type { HttpClient } from "./httpClient.js";
import { toOrderBook, validate } from "./normalize.js";

export interface ClobClient {
  getMarketInfo(conditionId: string): Promise<{ info: ClobMarketInfo; provenance: Provenance }>;
  getBook(assetId: string): Promise<OrderBook>;
}

export function createClobClient(http: HttpClient, baseUrl: string): ClobClient {
  return {
    async getMarketInfo(conditionId) {
      const url = `${baseUrl}/clob-markets/${encodeURIComponent(conditionId)}`;
      const { body, provenance } = await http.getJson("clob", "/clob-markets/{condition_id}", url);
      return { info: validate(ClobMarketInfoSchema, body, "CLOB market info", provenance), provenance };
    },

    async getBook(assetId) {
      const url = `${baseUrl}/book?${new URLSearchParams({ token_id: assetId }).toString()}`;
      const { body, provenance } = await http.getJson("clob", "/book", url);
      return toOrderBook(validate(ClobBookSchema, body, "CLOB order book", provenance), assetId, provenance);
    },
  };
}
