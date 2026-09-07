/*
 * `extractUsage` — best-effort token + cost pull from a provider response.
 * Covers the new `usage.cost` / `usage.total_cost` extraction (gateways like
 * OpenRouter return one) alongside the existing token shapes.
 */
import { describe, expect, it } from "vitest";
import { extractRequestParams, extractResponseMeta, extractUsage } from "../src/capture.js";

describe("extractUsage", () => {
  it("reads the OpenAI Responses API shape as inclusive with its detail buckets", () => {
    // Responses reuses Anthropic's top-level names but counts the cache INSIDE
    // input_tokens; the detail objects are what tell the two apart.
    expect(
      extractUsage({
        usage: {
          input_tokens: 1200,
          output_tokens: 300,
          input_tokens_details: { cached_tokens: 800 },
          output_tokens_details: { reasoning_tokens: 120 },
        },
      }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cost: undefined,
      cacheReadTokens: 800,
      reasoningTokens: 120,
      convention: "inclusive",
    });
  });

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

describe("extractUsage — cache and reasoning buckets", () => {
  it("reads Anthropic cache buckets and marks the convention exclusive", () => {
    expect(
      extractUsage({ usage: { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 } }),
    ).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cost: undefined,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      convention: "exclusive",
    });
  });

  it("reads OpenAI cached + reasoning details and marks the convention inclusive", () => {
    expect(
      extractUsage({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 60,
          prompt_tokens_details: { cached_tokens: 800 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 60,
      cost: undefined,
      cacheReadTokens: 800,
      reasoningTokens: 40,
      convention: "inclusive",
    });
  });

  it("stamps no convention when there are no buckets", () => {
    expect(extractUsage({ usage: { input_tokens: 1, output_tokens: 2 } })).not.toHaveProperty("convention");
  });
});

describe("extractResponseMeta / extractRequestParams", () => {
  it("reads model, id and the finish reason from Anthropic and OpenAI responses", () => {
    expect(extractResponseMeta({ id: "msg_1", model: "claude-sonnet-4-6-20260212", stop_reason: "end_turn" })).toEqual({
      id: "msg_1",
      model: "claude-sonnet-4-6-20260212",
      finishReason: "end_turn",
    });
    expect(extractResponseMeta({ id: "chatcmpl-1", model: "gpt-5.6", choices: [{ finish_reason: "stop" }] })).toEqual({
      id: "chatcmpl-1",
      model: "gpt-5.6",
      finishReason: "stop",
    });
    expect(extractResponseMeta({ usage: {} })).toBeUndefined();
  });

  it("reads sampling parameters and system instructions off a raw request", () => {
    expect(extractRequestParams({ temperature: 0.2, max_tokens: 512, top_p: 0.9, system: "be terse", messages: [] })).toEqual({
      temperature: 0.2,
      maxTokens: 512,
      topP: 0.9,
      systemInstructions: "be terse",
    });
    expect(extractRequestParams([{ role: "user", content: "hi" }])).toBeUndefined();
  });
});

describe("extractRequestParams on a wrapped argument list", () => {
  it("reads the request object out of `[request, options]` (what wrap() records)", () => {
    expect(
      extractRequestParams([
        { model: "claude-opus-4-8", temperature: 0.3, max_tokens: 256, system: "be terse", messages: [] },
        { signal: undefined },
      ]),
    ).toEqual({ temperature: 0.3, maxTokens: 256, topP: undefined, systemInstructions: "be terse" });
  });
});
