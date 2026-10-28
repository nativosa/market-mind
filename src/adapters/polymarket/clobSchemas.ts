import { z } from "zod";

// Raw CLOB shapes. Prices and sizes must be strings; their numeric validity is judged by the
// book quality assessment, not here.

const BookLevelSchema = z.object({ price: z.string(), size: z.string() });

export const ClobBookSchema = z.object({
  market: z.string(),
  asset_id: z.string(),
  timestamp: z.string().nullish(),
  hash: z.string().nullish(),
  bids: z.array(BookLevelSchema),
  asks: z.array(BookLevelSchema),
  min_order_size: z.string().nullish(),
  tick_size: z.string().nullish(),
  neg_risk: z.boolean().nullish(),
  last_trade_price: z.string().nullish(),
});
export type ClobBook = z.infer<typeof ClobBookSchema>;

/** GET /clob-markets/{condition_id}: `t` lists tokens as { t: token id, o: outcome label }. */
export const ClobMarketInfoSchema = z.object({
  t: z.array(z.object({ t: z.string().min(1), o: z.string() })),
});
export type ClobMarketInfo = z.infer<typeof ClobMarketInfoSchema>;
