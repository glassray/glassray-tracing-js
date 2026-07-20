/*
 * Serializer coverage: the 32 KiB per-content-attribute cap
 * with its explicit truncation marker, the 4 MiB whole-trace soft cap
 * (largest contents truncated first, structure survives), and ONE golden
 * OTLP JSON snapshot — the wire contract the ingest normalizer reads.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_BYTES,
  MAX_TRACE_BYTES,
  serializeTrace,
  type SerializeConfig,
} from "../src/serialize.js";
import type { SettledTrace, SpanRecord } from "../src/trace.js";

/** Serializer config with all switches at their defaults. */
const cfg = (over: Partial<SerializeConfig> = {}): SerializeConfig => ({
  agent: undefined,
  customer: undefined,
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
  errorMessage: undefined,
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
