import { z } from "zod";

// Raw Gamma shapes. Only fields used by Stage 1 are validated; unknown keys are stripped.
// `outcomes` and `clobTokenIds` are JSON-encoded strings on the wire; `positionIds` is a real array.

export const GammaMarketSchema = z.object({
  id: z.string().min(1),
  question: z.string(),
  conditionId: z.string().min(1),
  questionID: z.string().nullish(),
  slug: z.string(),
  version: z.string(),
  outcomes: z.string().nullish(),
  clobTokenIds: z.string().nullish(),
  positionIds: z.array(z.string()).nullish(),
  active: z.boolean(),
  closed: z.boolean(),
  acceptingOrders: z.boolean().nullish(),
  enableOrderBook: z.boolean().nullish(),
  negRisk: z.boolean().nullish(),
  endDate: z.string().nullish(),
});
export type GammaMarket = z.infer<typeof GammaMarketSchema>;

/** Envelope only; each market is validated individually so one bad record cannot hide the rest. */
export const GammaKeysetPageSchema = z.object({
  markets: z.array(z.unknown()),
  next_cursor: z.string().nullish(),
});
