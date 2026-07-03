/*
 * Fail-open: a transport whose fetch always throws must leave the
 * agent's return value and exceptions completely untouched — the only
 * evidence of failure is drop accounting in `stats()`.
 */

import { describe, expect, it } from "vitest";
import { Glassray } from "../src/index.js";

/** A fetch that always fails, simulating Glassray being unreachable. */
const brokenFetch = (async () => {
  throw new TypeError("network down");
}) as unknown as typeof fetch;

describe("fail-open", () => {
  it(
    "agent results and exceptions pass through untouched; drops are accounted",
    { timeout: 15_000 },
    async () => {
      const glassray = new Glassray({
        apiKey: "sk_test",
        endpoint: "http://localhost:9999",
        fetch: brokenFetch,
        onWarn: () => {},
      });

      // Return value unaffected.
      const out = await glassray.trace("run", async (t) => {
        await t.tool("step", async () => 1);
        return "ok";
      });
      expect(out).toBe("ok");

      // Customer exception passes through unchanged.
      await expect(
        glassray.trace("boom", async () => {
          throw new Error("agent broke");
        }),
      ).rejects.toThrow("agent broke");

      // Sync wrap stays sync even while sending fails.
      const double = glassray.wrap((x: number) => x * 2, { name: "double" });
      expect(double(21)).toBe(42);

      await glassray.flush();
      const stats = glassray.stats();
      expect(stats.sent).toBe(0);
      expect(stats.queued).toBe(0);
      // All three traces exhausted their retries and were dropped.
      expect(stats.dropped.byReason["retry_exhausted"]).toBe(3);
    },
  );
});
