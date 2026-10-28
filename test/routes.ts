import { fixture, json, type Reply } from "./helpers.js";

export const V1_YES = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
export const V1_NO = "52114319501245915516055106046884209969926127482827954674443846427813813222426";
export const V2_A = "600000000000000000000000000000000000000000000000000000000000000000000000168";
export const V2_B = "600000000000000000000000000000000000000000000000000000000000000000000000169";

/** Fake routes for a complete V1 (CTF, Yes/No) inspection. */
export const V1_ROUTES: Record<string, Reply> = {
  "/markets/100001": json(fixture("gamma/v1-market.json")),
  "/clob-markets/": json(fixture("clob/v1-market-info.json")),
  [`token_id=${V1_YES}`]: json(fixture("clob/v1-yes-book.json")),
  [`token_id=${V1_NO}`]: json(fixture("clob/v1-no-book.json")),
};

/** Fake routes for a complete V2 (team-name outcomes, one empty book) inspection. */
export const V2_ROUTES: Record<string, Reply> = {
  "/markets/200002": json(fixture("gamma/v2-market.json")),
  "/clob-markets/": json(fixture("clob/v2-market-info.json")),
  [`token_id=${V2_A}`]: json(fixture("clob/v2-alpha-book.json")),
  [`token_id=${V2_B}`]: json(fixture("clob/v2-beta-book.json")),
};
