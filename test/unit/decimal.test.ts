import { describe, expect, it } from "vitest";
import {
  decimal,
  decimalToString,
  half,
  isStrictDecimalString,
  parseDecimal,
  sum,
  ZERO,
} from "../../src/domain/decimal.js";

describe("strict decimal parsing", () => {
  it.each(["0", "1", "0.5", "0.001", "10198713.84", "007.10"])("accepts %s", (s) => {
    expect(isStrictDecimalString(s)).toBe(true);
    expect(parseDecimal(s)).not.toBeNull();
  });

  it.each(["", " 1", "1 ", "-1", "+1", "1e3", "1E-3", ".5", "1.", "NaN", "Infinity", "0x10", "1,5", "1.2.3"])(
    "rejects %j",
    (s) => {
      expect(isStrictDecimalString(s)).toBe(false);
      expect(parseDecimal(s)).toBeNull();
    },
  );

  it.each([0.5, null, undefined, {}])("returns null for non-string %j", (v) => {
    expect(parseDecimal(v)).toBeNull();
  });

  it("decimal() throws instead of defaulting to zero", () => {
    expect(() => decimal("abc")).toThrow(TypeError);
  });
});

describe("exact arithmetic", () => {
  it("adds without floating-point error", () => {
    expect(decimalToString(decimal("0.1").plus(decimal("0.2")))).toBe("0.3");
  });

  it("aligns mixed scales", () => {
    expect(decimalToString(decimal("0.037").minus(decimal("0.01")))).toBe("0.027");
  });

  it("halves exactly", () => {
    expect(decimalToString(half(decimal("0.073")))).toBe("0.0365");
    expect(decimalToString(half(decimal("0.001")))).toBe("0.0005");
  });

  it("sums large sizes exactly", () => {
    const total = sum(["10198713.84", "1500", "250.5", "117.97"].map(decimal));
    expect(decimalToString(total)).toBe("10200582.31");
    expect(decimalToString(sum([]))).toBe("0");
    expect(ZERO.eq(sum([]))).toBe(true);
  });

  it("never formats in exponential notation", () => {
    expect(decimalToString(decimal("0.0000001"))).toBe("0.0000001");
    expect(decimalToString(decimal("123456789012345678901234.5"))).toBe("123456789012345678901234.5");
  });

  it("normalizes trailing zeros", () => {
    expect(decimalToString(decimal("0.0360"))).toBe("0.036");
  });
});
