/*
 * Deprecation contract for the retired `environment` option (0.1.3): the SDK
 * still accepts it (constructor and per-trace `meta`) for compile
 * compatibility, warns exactly once, and never puts `glassray.environment` on
 * the wire — the ingest key selects the project.
 */

import { describe, expect, it } from "vitest";
import { Glassray } from "../src/index.js";

/** A fetch that records each request body and reports success, so the wire can be inspected. */
const capturingFetch = (bodies: string[]): typeof fetch =>
  (async (_url: unknown, init?: { body?: unknown }) => {
    if (init?.body !== undefined) bodies.push(String(init.body));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

describe("environment option deprecation", () => {
  it("accepts `environment`, warns once, and emits no glassray.environment", async () => {
    const warnings: string[] = [];
    const bodies: string[] = [];
    const glassray = new Glassray({
      apiKey: "sk_test",
      environment: "prod", // deprecated — accepted but ignored
      onWarn: (m) => warnings.push(m),
      fetch: capturingFetch(bodies),
    });

    await glassray.trace("run", { environment: "staging" }, async (t) => {
      await t.tool("step", async () => "ok");
    });
    await glassray.flush();

    // Warned exactly once about the deprecated option.
    const envWarnings = warnings.filter((m) => m.includes("environment"));
    expect(envWarnings).toHaveLength(1);
    // A trace shipped, and nothing on it carries the retired attribute.
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join("\n")).not.toContain("glassray.environment");
  });
});
