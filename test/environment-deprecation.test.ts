/*
 * Deprecation contract for the retired `environment` option (0.1.3): the SDK
 * still accepts it — on the constructor AND per-trace `meta` — for compile
 * compatibility, warns once on EACH surface, and never puts
 * `glassray.environment` on the wire (the ingest key selects the project).
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
  it("warns once for the CONSTRUCTOR option and emits no glassray.environment", async () => {
    const warnings: string[] = [];
    const bodies: string[] = [];
    const glassray = new Glassray({
      apiKey: "sk_test",
      environment: "prod", // deprecated — accepted but ignored
      onWarn: (m) => warnings.push(m),
      fetch: capturingFetch(bodies),
    });

    // No per-trace environment here — only the constructor path should warn.
    await glassray.trace("run", {}, async (t) => {
      await t.tool("step", async () => "ok");
    });
    await glassray.flush();

    expect(warnings.filter((m) => m.includes("environment"))).toHaveLength(1);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join("\n")).not.toContain("glassray.environment");
  });

  it("warns once for PER-TRACE meta.environment (no constructor option) and emits nothing", async () => {
    const warnings: string[] = [];
    const bodies: string[] = [];
    const glassray = new Glassray({
      apiKey: "sk_test",
      onWarn: (m) => warnings.push(m),
      fetch: capturingFetch(bodies),
    });

    // `environment` ONLY on the per-trace meta — the constructor never sets it,
    // so the per-trace warning is the one under test (greptile PR #1).
    await glassray.trace("run", { environment: "staging" }, async (t) => {
      await t.tool("step", async () => "ok");
    });
    await glassray.flush();

    expect(warnings.filter((m) => m.includes("environment"))).toHaveLength(1);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join("\n")).not.toContain("glassray.environment");
  });
});
