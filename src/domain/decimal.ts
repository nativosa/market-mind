import Big from "big.js";

/** Exact base-10 decimal. Never serialized directly: use `decimalToString`. */
export type Decimal = Big;

// Local constructor so settings never leak into (or from) other big.js users.
const D = Big();
D.strict = true; // reject primitive numbers: every value must come from a string
D.DP = 20; // division precision; only exact halving is used in practice
D.RM = D.roundHalfEven;

// Plain non-negative decimal: digits, optional fraction. Rejects "-1", "1e3", ".5", "1.", " 1", "".
const STRICT_DECIMAL = /^\d+(\.\d+)?$/;

export function isStrictDecimalString(value: unknown): value is string {
  return typeof value === "string" && STRICT_DECIMAL.test(value);
}

/** Parse a strict decimal string; returns null for anything else (never zero by default). */
export function parseDecimal(value: unknown): Decimal | null {
  return isStrictDecimalString(value) ? D(value) : null;
}

export function decimal(value: string): Decimal {
  const parsed = parseDecimal(value);
  if (parsed === null) throw new TypeError(`Not a strict decimal string: ${JSON.stringify(value)}`);
  return parsed;
}

export const ZERO: Decimal = D("0");
const TWO: Decimal = D("2");

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), ZERO);
}

export function half(value: Decimal): Decimal {
  return value.div(TWO);
}

/** Fixed (never exponential) notation, minimal digits: "0.0000001", not "1e-7". */
export function decimalToString(value: Decimal): string {
  return value.toFixed();
}
