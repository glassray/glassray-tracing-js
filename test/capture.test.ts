/*
 * `extractUsage` — best-effort token + cost pull from a provider response.
 * Covers the new `usage.cost` / `usage.total_cost` extraction (gateways like
 * OpenRouter return one) alongside the existing token shapes.
 */
import { describe, expect, it } from "vitest";
import { extractUsage } from "../src/capture.js";

describe("extractUsage", () => {
  it("pulls Anthropic-style tokens", () => {
    expect(extractUsage({ usage: { input_tokens: 12, output_tokens: 7 } })).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cost: undefined,
    });
  });

  it("pulls a gateway-provided usage.cost", () => {
    expect(extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.0012 } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cost: 0.0012,
    });
  });

  it("accepts usage.total_cost as the cost alias", () => {
    expect(extractUsage({ usage: { total_cost: 0.5 } })).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      cost: 0.5,
    });
  });

  it("returns undefined when neither tokens nor cost are present", () => {
    expect(extractUsage({ usage: { foo: 1 } })).toBeUndefined();
    expect(extractUsage({})).toBeUndefined();
    expect(extractUsage("nope")).toBeUndefined();
  });
});
