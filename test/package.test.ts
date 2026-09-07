/*
 * Consumers load the built artifacts, not `src/` — so a wrong artifact name,
 * module format or `exports` mapping would ship unnoticed if only source were
 * tested. This loads both the ESM and CJS builds and checks the published
 * `exports` map against what tsup emitted. `npm test` builds first (`pretest`).
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

/** The API surface every consumer relies on. */
const EXPECTED = ["Glassray", "createTraceId", "currentSpan", "TRACE_ATTR", "TRACE_OPERATION", "GLASSRAY_SPAN_KINDS"];

describe("built package", () => {
  it("ESM and CJS artifacts load and expose the same public surface", async () => {
    const esm = (await import(resolve(root, "dist/index.js"))) as Record<string, unknown>;
    const cjs = require(resolve(root, "dist/index.cjs")) as Record<string, unknown>;
    for (const name of EXPECTED) {
      expect(esm[name], `ESM export ${name}`).toBeDefined();
      expect(cjs[name], `CJS export ${name}`).toBeDefined();
    }
    expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).sort());
    // Sanity: the class actually works from the CJS build.
    const Client = cjs.Glassray as new (o: object) => { stats(): { sent: number } };
    expect(new Client({ enabled: false }).stats().sent).toBe(0);
  });

  it("every path in the published exports map exists after a build", () => {
    const published = (pkg as { publishConfig: { exports: Record<string, Record<string, string>> } }).publishConfig.exports["."]!;
    for (const [condition, rel] of Object.entries(published)) {
      expect(existsSync(resolve(root, rel)), `${condition} → ${rel}`).toBe(true);
    }
    expect((pkg as { files: string[] }).files).toContain("dist");
  });
});
