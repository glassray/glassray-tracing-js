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
  it("an llm-kind root carries model/provider/depth and explicit usage on the root span", async () => {
    const { glassray, bodies } = clientWithSink();
    const t = glassray.startTrace(
      "judge",
      { customer: "org_1", depth: 2 },
      { kind: "llm", model: "claude-sonnet-4-6", provider: "anthropic" },
    );
    await t.run(async () => {
      t.setUsage({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 400, convention: "inclusive" });
      return { text: "ok" };
    });
    await glassray.flush();
    const root = spansOf(bodies[0]!).find((s) => !s.parentSpanId)!;
    const attr = (key: string) => root.attributes.find((a) => a.key === key)?.value;
    expect(attr("gen_ai.operation.name")).toEqual({ stringValue: "chat" });
    expect(attr("gen_ai.request.model")).toEqual({ stringValue: "claude-sonnet-4-6" });
    expect(attr("gen_ai.provider.name")).toEqual({ stringValue: "anthropic" });
    expect(attr("glassray.customer")).toEqual({ stringValue: "org_1" });
    expect(attr("glassray.depth")).toEqual({ intValue: "2" });
    expect(attr("gen_ai.usage.input_tokens")).toEqual({ intValue: "1000" });
    // Inclusive convention → the OpenAI-style "inside input" cache key.
    expect(attr("gen_ai.usage.cached_input_tokens")).toEqual({ intValue: "400" });
  });

  it("a customer given as an object rides the root span as id + name / email; a string still emits the id alone", async () => {
    const { glassray, bodies } = clientWithSink();
    await glassray.trace(
      "named",
      { customer: { id: "cus_8fa21", name: "Acme Corp", email: "ops@acme.com" } },
      async () => "ok",
    );
    // A string is a grouping key and passes through verbatim, whitespace included.
    await glassray.trace("bare", { customer: " cus_2 " }, async () => "ok");
    // An object without an id names nothing: dropped, not emitted half-formed.
    await glassray.trace(
      "no-id",
      { customer: { name: "Nobody" } as unknown as { id: string } },
      async () => "ok",
    );
    // A customer whose property reads throw must not take the trace down.
    const hostile = new Proxy({} as { id: string }, {
      get: () => {
        throw new Error("no");
      },
    });
    await glassray.trace("hostile", { customer: hostile }, async () => "ok");
    await glassray.flush();
    const rootOf = (i: number) => spansOf(bodies[i]!).find((s) => !s.parentSpanId)!;
    const attr = (s: WireSpan, key: string) => s.attributes.find((a) => a.key === key)?.value;
    expect(attr(rootOf(0), "glassray.customer")).toEqual({ stringValue: "cus_8fa21" });
    expect(attr(rootOf(0), "glassray.customer.name")).toEqual({ stringValue: "Acme Corp" });
    expect(attr(rootOf(0), "glassray.customer.email")).toEqual({ stringValue: "ops@acme.com" });
    expect(attr(rootOf(0), "glassray.customer.domain")).toBeUndefined();
    expect(attr(rootOf(1), "glassray.customer")).toEqual({ stringValue: " cus_2 " });
    expect(attr(rootOf(1), "glassray.customer.name")).toBeUndefined();
    expect(attr(rootOf(2), "glassray.customer")).toBeUndefined();
    expect(attr(rootOf(2), "glassray.customer.name")).toBeUndefined();
    expect(bodies).toHaveLength(4);
    expect(attr(rootOf(3), "glassray.customer")).toBeUndefined();
  });

  it("drops an invalid depth with a warning and warns on cache buckets without a convention", async () => {
    const bodies: string[] = [];
    const warnings: string[] = [];
    const glassray = new Glassray({
      apiKey: "sk_test",
      endpoint: "http://localhost:9999",
      agent: "test-agent",
      fetch: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      onWarn: (m) => warnings.push(m),
    });
    const t = glassray.startTrace("run", { depth: -1 }, { kind: "llm", model: "m" });
    await t.run(async () => {
      // A JS caller can omit the convention the type demands — it must warn, not mis-price silently.
      t.setUsage({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 40 } as never);
      return "ok";
    });
    await glassray.flush();
    const root = spansOf(bodies[0]!).find((s) => !s.parentSpanId)!;
    expect(root.attributes.find((a) => a.key === "glassray.depth")).toBeUndefined();
    expect(warnings.some((w) => w.includes("invalid depth"))).toBe(true);
    expect(warnings.some((w) => w.includes("without a `convention`"))).toBe(true);
  });
});
