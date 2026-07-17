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
});
