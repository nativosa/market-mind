import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";
import { MarketMindError } from "../../src/domain/errors.js";

describe("loadConfig", () => {
  it("uses defaults with an empty environment", () => {
    expect(loadConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("applies validated overrides and strips trailing slashes", () => {
    const c = loadConfig({
      MARKETMIND_GAMMA_URL: "https://gamma.example/",
      MARKETMIND_CLOB_URL: "https://clob.example",
      MARKETMIND_TIMEOUT_MS: "2500",
      MARKETMIND_MAX_RETRIES: "0",
    });
    expect(c).toMatchObject({
      gammaBaseUrl: "https://gamma.example",
      clobBaseUrl: "https://clob.example",
      timeoutMs: 2500,
      maxRetries: 0,
    });
  });

  it.each([
    { MARKETMIND_GAMMA_URL: "http://plain.example" },
    { MARKETMIND_CLOB_URL: "not a url" },
    { MARKETMIND_TIMEOUT_MS: "0" },
    { MARKETMIND_TIMEOUT_MS: "abc" },
    { MARKETMIND_MAX_RETRIES: "6" },
  ])("rejects %j", (env) => {
    expect(() => loadConfig(env)).toThrow(MarketMindError);
  });
});
