/*
 * Context/nesting correctness: nesting follows call structure —
 * parallel `t.tool()` calls become siblings; a span opened inside another
 * span's callback becomes its child; root I/O and metadata land where the
 * ingest reads them.
 */

import { describe, expect, it } from "vitest";
import { Glassray } from "../src/index.js";

/** Tiny async delay so parallel tools genuinely interleave. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal OTLP span shape the assertions read back. */
type WireSpan = {
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: { key: string; value: Record<string, unknown> }[];
};

/** Build a Glassray client with a fetch stub that records posted bodies. */
const clientWithSink = () => {
  const bodies: string[] = [];
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const glassray = new Glassray({
    apiKey: "sk_test",
    endpoint: "http://localhost:9999",
    agent: "test-agent",
    fetch: fakeFetch,
    onWarn: () => {},
  });
  return { glassray, bodies };
};

/** Parse the single posted OTLP body into its span list. */
const spansOf = (body: string): WireSpan[] => {
  const doc = JSON.parse(body) as {
    resourceSpans: { scopeSpans: { spans: WireSpan[] }[] }[];
  };
  return doc.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
};

/** Find one span by name or fail loudly. */
const byName = (spans: WireSpan[], name: string): WireSpan => {
  const span = spans.find((s) => s.name === name);
  if (!span) throw new Error(`span ${name} missing`);
  return span;
};

describe("context & nesting", () => {
  it("parallel tools become siblings; spans inside callbacks become children", async () => {
    const { glassray, bodies } = clientWithSink();

    const result = await glassray.trace(
      "handle-ticket",
      { customer: "acme", sessionId: "sess-1" },
      async (t) => {
        const [a, b] = await Promise.all([
          t.tool("tool-a", async () => {
            await delay(5);
            return "a";
          }),
          t.tool("tool-b", async () => {
            await delay(5);
            return "b";
          }),
        ]);
        const inner = await t.span("phase", { kind: "workflow" }, async () =>
          t.tool("inner-tool", async () => "x"),
        );
        return { a, b, inner };
      },
    );

    expect(result).toEqual({ a: "a", b: "b", inner: "x" });
    await glassray.flush();
    expect(bodies).toHaveLength(1);

    const spans = spansOf(bodies[0] as string);
    const root = byName(spans, "handle-ticket");
    const toolA = byName(spans, "tool-a");
    const toolB = byName(spans, "tool-b");
    const phase = byName(spans, "phase");
    const inner = byName(spans, "inner-tool");

    expect(root.parentSpanId).toBeUndefined();
    // Parallel calls from the same context are siblings under the root.
    expect(toolA.parentSpanId).toBe(root.spanId);
    expect(toolB.parentSpanId).toBe(root.spanId);
    expect(phase.parentSpanId).toBe(root.spanId);
    // A span opened inside another callback is that span's child.
    expect(inner.parentSpanId).toBe(phase.spanId);

    // Root return value became the trace output; per-trace meta rides the root span.
    const attr = (s: WireSpan, key: string) => s.attributes.find((a) => a.key === key)?.value;
    expect(attr(root, "output.value")).toEqual({
      stringValue: JSON.stringify({ a: "a", b: "b", inner: "x" }),
    });
    expect(attr(root, "glassray.customer")).toEqual({ stringValue: "acme" });
    expect(attr(toolA, "gen_ai.tool.name")).toEqual({ stringValue: "tool-a" });
  });
});
