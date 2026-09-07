/*
 * Serializer coverage: the 32 KiB per-content-attribute cap
 * with its explicit truncation marker, the 4 MiB whole-trace soft cap
 * (largest contents truncated first, structure survives), and ONE golden
 * OTLP JSON snapshot — the wire contract the ingest normalizer reads.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_CONTENT_BYTES,
  MAX_TRACE_BYTES,
  SDK_VERSION,
  serializeTrace,
  type SerializeConfig,
} from "../src/serialize.js";
import type { SettledTrace, SpanRecord } from "../src/trace.js";

/** Serializer config with all switches at their defaults. */
const cfg = (over: Partial<SerializeConfig> = {}): SerializeConfig => ({
  agent: undefined,
  customer: undefined,
  version: undefined,
  attributes: undefined,
  hideInputs: false,
  hideOutputs: false,
  scrubbing: true,
  redact: undefined,
  ...over,
});

/** SpanRecord fixture with fixed ids/timestamps. */
const span = (over: Partial<SpanRecord>): SpanRecord => ({
  spanId: "1111111111111111",
  parentSpanId: undefined,
  isRoot: false,
  name: "step",
  kind: undefined,
  startMs: 1_751_400_000_000,
  endMs: 1_751_400_000_250,
  input: undefined,
  hasInput: false,
  output: undefined,
  hasOutput: false,
  usage: undefined,
  model: undefined,
  provider: undefined,
  response: undefined,
  errorMessage: undefined,
  errorType: undefined,
  autoClosed: false,
  ...over,
});

/** SettledTrace fixture around a span list. */
const trace = (spans: SpanRecord[], over: Partial<SettledTrace> = {}): SettledTrace => ({
  traceId: "0af7651916cd43dd8448eb211c80319c",
  name: spans[0]?.name ?? "trace",
  sessionId: undefined,
  customer: undefined,
  flow: undefined,
  userId: undefined,
  depth: undefined,
  environment: undefined,
  attributes: undefined,
  spans,
  ...over,
});

/** Read every content-attribute stringValue for `key` out of a serialized body. */
const attrValues = (body: string, key: string): string[] => {
  const doc = JSON.parse(body) as {
    resourceSpans: {
      scopeSpans: {
        spans: { attributes: { key: string; value: { stringValue?: string } }[] }[];
      }[];
    }[];
  };
  return doc.resourceSpans
    .flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
    .flatMap((s) => s.attributes.filter((a) => a.key === key))
    .map((a) => a.value.stringValue ?? "");
};

const noWarn = () => {};

describe("truncation caps", () => {
  it("caps each content attribute at 32 KiB with an explicit marker", () => {
    const big = "x".repeat(100_000);
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "agent", input: big, hasInput: true })]),
      cfg(),
      noWarn,
    );
    const [value] = attrValues(body, "input.value");
    expect(value).toBeDefined();
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    expect(value).toMatch(/…\[glassray:truncated \d+ bytes\]$/);
  });

  it("keeps the whole trace under the 4 MiB soft cap, structure surviving", () => {
    const chunk = "y".repeat(33 * 1024);
    const spans: SpanRecord[] = [span({ isRoot: true, kind: "agent", name: "root" })];
    for (let i = 0; i < 70; i++) {
      spans.push(
        span({
          spanId: i.toString(16).padStart(16, "0"),
          parentSpanId: "1111111111111111",
          name: `step-${i}`,
          kind: "tool",
          input: chunk,
          hasInput: true,
          output: chunk,
          hasOutput: true,
        }),
      );
    }
    const body = serializeTrace(trace(spans), cfg(), noWarn);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_TRACE_BYTES);
    // Structure/timing survive: every span still present with its name.
    const doc = JSON.parse(body) as {
      resourceSpans: { scopeSpans: { spans: { name: string; startTimeUnixNano: string }[] }[] }[];
    };
    const wire = doc.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
    expect(wire).toHaveLength(71);
    expect(wire.every((s) => s.name.length > 0 && s.startTimeUnixNano.length > 0)).toBe(true);
  });
});

describe("golden OTLP JSON", () => {
  it("serializes one whole trace exactly as the ingest contract expects", () => {
    const fixture = trace(
      [
        span({
          spanId: "aaaaaaaaaaaaaaaa",
          isRoot: true,
          kind: "agent",
          name: "handle-ticket",
          startMs: 1_751_400_000_000,
          endMs: 1_751_400_001_500,
          input: { ticketId: "T-1" },
          hasInput: true,
          output: "resolved",
          hasOutput: true,
        }),
        span({
          spanId: "bbbbbbbbbbbbbbbb",
          parentSpanId: "aaaaaaaaaaaaaaaa",
          kind: "llm",
          name: "plan",
          startMs: 1_751_400_000_100,
          endMs: 1_751_400_000_900,
          model: "claude-opus-4-8",
          provider: "anthropic",
          usage: { inputTokens: 42, outputTokens: 17 },
          input: [{ role: "user", content: "help" }],
          hasInput: true,
          output: {
            role: "assistant",
            content: [{ type: "text", text: "the plan" }],
            usage: { input_tokens: 42, output_tokens: 17 },
          },
          hasOutput: true,
        }),
        span({
          spanId: "cccccccccccccccc",
          parentSpanId: "aaaaaaaaaaaaaaaa",
          kind: "tool",
          name: "search-kb",
          startMs: 1_751_400_000_950,
          endMs: 1_751_400_001_200,
          input: { q: "refunds" },
          hasInput: true,
          errorMessage: "kb timeout",
          autoClosed: true,
        }),
      ],
      // `environment` is still accepted on the SettledTrace (deprecated) but must
      // never reach the wire — the golden snapshot asserts its absence.
      { sessionId: "sess-9", customer: "acme", flow: "refunds", environment: "staging" },
    );
    const body = serializeTrace(
      fixture,
      cfg({ agent: "support-agent", customer: "default-co" }),
      noWarn,
    );
    expect(body).not.toContain("glassray.environment");
    expect(JSON.parse(body)).toMatchSnapshot();
  });
});

describe("llm usage cost", () => {
  /** Read numeric (int/double) attribute values for `key` out of a serialized body. */
  const attrNumbers = (body: string, key: string): number[] => {
    const doc = JSON.parse(body) as {
      resourceSpans: {
        scopeSpans: {
          spans: { attributes: { key: string; value: { intValue?: string; doubleValue?: number } }[] }[];
        }[];
      }[];
    };
    return doc.resourceSpans
      .flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
      .flatMap((s) => s.attributes.filter((a) => a.key === key))
      .map((a) => a.value.doubleValue ?? Number(a.value.intValue));
  };

  it("emits glassray.usage.cost when cost is set on usage (overrides the platform estimate)", () => {
    const body = serializeTrace(
      trace([
        span({
          isRoot: true,
          kind: "llm",
          model: "gpt-4o",
          usage: { inputTokens: 10, outputTokens: 5, cost: 0.42 },
        }),
      ]),
      cfg(),
      noWarn,
    );
    expect(attrNumbers(body, "glassray.usage.cost")).toEqual([0.42]);
  });

  it("omits glassray.usage.cost when cost is unset (platform computes from tokens×price)", () => {
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "llm", model: "gpt-4o", usage: { inputTokens: 10, outputTokens: 5 } })]),
      cfg(),
      noWarn,
    );
    expect(attrNumbers(body, "glassray.usage.cost")).toEqual([]);
  });

  it("omits an invalid cost (NaN / negative) so it can't override the platform estimate", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      const body = serializeTrace(
        trace([span({ isRoot: true, kind: "llm", model: "gpt-4o", usage: { inputTokens: 10, cost: bad } })]),
        cfg(),
        noWarn,
      );
      expect(attrNumbers(body, "glassray.usage.cost")).toEqual([]);
    }
  });

  it("emits a zero cost (a legitimate free/cached call)", () => {
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "llm", model: "gpt-4o", usage: { inputTokens: 10, cost: 0 } })]),
      cfg(),
      noWarn,
    );
    expect(attrNumbers(body, "glassray.usage.cost")).toEqual([0]);
  });
});

describe("custom attributes (APP-14941)", () => {
  /** Raw resource attributes as `{ key → value-union }` from a serialized body. */
  const resourceAttrs = (body: string): Record<string, string | number | boolean> => {
    const doc = JSON.parse(body) as {
      resourceSpans: {
        resource: {
          attributes: {
            key: string;
            value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
          }[];
        };
      }[];
    };
    const out: Record<string, string | number | boolean> = {};
    for (const { key, value } of doc.resourceSpans[0]?.resource.attributes ?? []) {
      if (value.stringValue !== undefined) out[key] = value.stringValue;
      else if (value.intValue !== undefined) out[key] = Number(value.intValue);
      else if (value.doubleValue !== undefined) out[key] = value.doubleValue;
      else if (value.boolValue !== undefined) out[key] = value.boolValue;
    }
    return out;
  };

  /** Raw attributes of the root span (`isRoot`) as `{ key → value }`. */
  const rootSpanAttrs = (body: string): Record<string, string | number | boolean> => {
    const doc = JSON.parse(body) as {
      resourceSpans: {
        scopeSpans: {
          spans: {
            parentSpanId?: string;
            attributes: {
              key: string;
              value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
            }[];
          }[];
        }[];
      }[];
    };
    const spans = doc.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
    const root = spans.find((s) => s.parentSpanId === undefined);
    const out: Record<string, string | number | boolean> = {};
    for (const { key, value } of root?.attributes ?? []) {
      if (value.stringValue !== undefined) out[key] = value.stringValue;
      else if (value.intValue !== undefined) out[key] = Number(value.intValue);
      else if (value.doubleValue !== undefined) out[key] = value.doubleValue;
      else if (value.boolValue !== undefined) out[key] = value.boolValue;
    }
    return out;
  };

  it("emits constructor-level attributes verbatim as resource attributes", () => {
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "agent" })]),
      cfg({ attributes: { environment: "production", region: "eu", replicas: 3, canary: true } }),
      noWarn,
    );
    const attrs = resourceAttrs(body);
    expect(attrs.environment).toBe("production");
    expect(attrs.region).toBe("eu");
    expect(attrs.replicas).toBe(3);
    expect(attrs.canary).toBe(true);
  });

  it("emits per-trace attributes on the root span (override channel)", () => {
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "agent" })], {
        attributes: { merchantId: "acme-corp", branch: "master" },
      }),
      cfg(),
      noWarn,
    );
    const attrs = rootSpanAttrs(body);
    expect(attrs.merchantId).toBe("acme-corp");
    expect(attrs.branch).toBe("master");
  });

  it("drops a reserved-namespace key and warns rather than shadowing the convention", () => {
    const warnings: string[] = [];
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "agent" })], {
        attributes: { "glassray.customer": "evil", "gen_ai.request.model": "spoof", keep: "yes" },
      }),
      cfg({ customer: "real-co" }),
      (scope, msg) => warnings.push(`${scope}:${msg}`),
    );
    const rootAttrs = rootSpanAttrs(body);
    // The reserved keys never reach the wire from the custom map — and the
    // spoofed customer never lands on the root span (its override channel)…
    expect(rootAttrs["gen_ai.request.model"]).toBeUndefined();
    expect(rootAttrs["glassray.customer"]).toBeUndefined();
    // …so the real convention value (resource level) is untouched.
    expect(resourceAttrs(body)["glassray.customer"]).toBe("real-co");
    expect(rootAttrs.keep).toBe("yes");
    expect(warnings.some((w) => w.includes("glassray.customer"))).toBe(true);
    expect(warnings.some((w) => w.includes("gen_ai.request.model"))).toBe(true);
  });

  it("skips non-scalar values (objects / arrays / null)", () => {
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "agent" })], {
        // Cast through unknown: the public type is scalar-only, but a JS caller
        // can still pass junk — it must be dropped, not serialized.
        attributes: { good: "v", bad: { nested: 1 }, arr: [1, 2], nil: null } as unknown as Record<
          string,
          string | number | boolean
        >,
      }),
      cfg(),
      noWarn,
    );
    const attrs = rootSpanAttrs(body);
    expect(attrs.good).toBe("v");
    expect(attrs.bad).toBeUndefined();
    expect(attrs.arr).toBeUndefined();
    expect(attrs.nil).toBeUndefined();
  });

  it("truncates a long value by code points, never splitting a surrogate pair", () => {
    // 300 emoji (each 1 code point, 2 UTF-16 units) — a naive slice(0,256) would
    // cut mid-pair and emit a lone surrogate.
    const value = "😀".repeat(300);
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "agent" })], { attributes: { emojis: value } }),
      cfg(),
      noWarn,
    );
    const out = String(rootSpanAttrs(body).emojis);
    // Cut cleanly at 256 whole code points — every emoji intact, no lone surrogate.
    expect([...out]).toHaveLength(256);
    expect(out).toBe("😀".repeat(256));
  });

  it("emits an empty-string value rather than silently dropping it", () => {
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "agent" })], { attributes: { blank: "" } }),
      cfg(),
      noWarn,
    );
    expect(rootSpanAttrs(body).blank).toBe("");
  });

  it("adds no attributes when none are set (clean baseline)", () => {
    const body = serializeTrace(trace([span({ isRoot: true, kind: "agent" })]), cfg(), noWarn);
    const attrs = { ...resourceAttrs(body), ...rootSpanAttrs(body) };
    // Every emitted key is a reserved/convention one — no stray custom attr leaks.
    for (const key of Object.keys(attrs)) {
      const reserved =
        key.startsWith("gen_ai.") ||
        key.startsWith("glassray.") ||
        key === "service.name" ||
        key === "session.id";
      expect(reserved).toBe(true);
    }
  });
});

/** Every attribute of the first span whose name matches, as a key → scalar map. */
const spanAttrs = (body: string, name: string): Record<string, unknown> => {
  const doc = JSON.parse(body) as {
    resourceSpans: {
      scopeSpans: { spans: { name: string; attributes: { key: string; value: Record<string, unknown> }[] }[] }[];
    }[];
  };
  const s = doc.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)).find((x) => x.name === name);
  return Object.fromEntries((s?.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
};

/** Resource attributes as a key → scalar map. */
const resourceAttrs = (body: string): Record<string, unknown> => {
  const doc = JSON.parse(body) as {
    resourceSpans: { resource: { attributes: { key: string; value: Record<string, unknown> }[] } }[];
  };
  return Object.fromEntries((doc.resourceSpans[0]?.resource.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
};

describe("usage buckets + response metadata (cost-at-ingestion contract)", () => {
  it("emits Anthropic-convention cache keys for exclusive usage and the OpenAI key for inclusive", () => {
    const exclusive = serializeTrace(
      trace([span({ isRoot: true, kind: "llm", name: "chat", usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, convention: "exclusive" } })]),
      cfg(),
      noWarn,
    );
    const a = spanAttrs(exclusive, "chat");
    expect(a["gen_ai.usage.cache_read_input_tokens"]).toBe("800");
    expect(a["gen_ai.usage.cache_creation_input_tokens"]).toBe("100");
    expect(a["gen_ai.usage.cached_input_tokens"]).toBeUndefined();

    const inclusive = serializeTrace(
      trace([span({ isRoot: true, kind: "llm", name: "chat", usage: { inputTokens: 1000, outputTokens: 60, cacheReadTokens: 800, reasoningTokens: 40, convention: "inclusive" } })]),
      cfg(),
      noWarn,
    );
    const b = spanAttrs(inclusive, "chat");
    expect(b["gen_ai.usage.cached_input_tokens"]).toBe("800");
    expect(b["gen_ai.usage.cache_read_input_tokens"]).toBeUndefined();
    expect(b["gen_ai.usage.reasoning_tokens"]).toBe("40");
  });

  it("keeps the inclusive convention discoverable on a cache-WRITE-only span", () => {
    // A cache-priming first turn reports a write and no read. The convention
    // rides the cache-READ key spelling, so the read bucket is emitted as 0
    // under the inclusive key — otherwise ingest reads the lone Anthropic
    // write key as "exclusive" and never subtracts the cache from fresh input.
    const body = serializeTrace(
      trace([
        span({
          isRoot: true,
          kind: "llm",
          name: "chat",
          usage: { inputTokens: 10_000, outputTokens: 50, cacheWriteTokens: 8_000, convention: "inclusive" },
        }),
      ]),
      cfg(),
      noWarn,
    );
    const a = spanAttrs(body, "chat");
    expect(a["gen_ai.usage.cached_input_tokens"]).toBe("0");
    expect(a["gen_ai.usage.cache_creation_input_tokens"]).toBe("8000");
    expect(a["gen_ai.usage.cache_read_input_tokens"]).toBeUndefined();
  });

  it("emits response metadata, request parameters and system instructions on llm spans", () => {
    const body = serializeTrace(
      trace([
        span({
          isRoot: true,
          kind: "llm",
          name: "chat",
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          input: { model: "claude-sonnet-4-6", system: "be terse", temperature: 0.2, max_tokens: 512, messages: [{ role: "user", content: "hi" }] },
          hasInput: true,
          response: { model: "claude-sonnet-4-6-20260212", id: "msg_01", finishReason: "end_turn" },
        }),
      ]),
      cfg(),
      noWarn,
    );
    const a = spanAttrs(body, "chat");
    expect(a["gen_ai.response.model"]).toBe("claude-sonnet-4-6-20260212");
    expect(a["gen_ai.response.id"]).toBe("msg_01");
    expect(a["gen_ai.response.finish_reason"]).toBe("end_turn");
    expect(a["gen_ai.request.temperature"]).toBe(0.2);
    expect(a["gen_ai.request.max_tokens"]).toBe("512");
    expect(a["gen_ai.system_instructions"]).toBe("be terse");
  });

  it("emits user.id on the root, service.version on the resource, and error.type beside error.message", () => {
    const body = serializeTrace(
      trace([span({ isRoot: true, kind: "agent", name: "run", errorMessage: "boom", errorType: "TypeError" })], { userId: "u-42" }),
      cfg({ agent: "bot", version: "1.4.0" }),
      noWarn,
    );
    expect(spanAttrs(body, "run")["user.id"]).toBe("u-42");
    expect(spanAttrs(body, "run")["error.type"]).toBe("TypeError");
    expect(resourceAttrs(body)["service.version"]).toBe("1.4.0");
  });

  it("stamps the instrumentation scope with the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
