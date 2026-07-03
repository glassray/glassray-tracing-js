/*
 * Transport doctrine: a 429 with Retry-After pauses the
 * sender for exactly the window then requeues (nothing dropped), persistent
 * 429s drop after a bounded number of requeues (flush never hangs), and
 * queue overflow drops the OLDEST trace with warn-once + drop accounting.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Transport } from "../src/transport.js";

/** Transport wired to a mock fetch, with silent warn collection. */
const build = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof Transport>[0]> = {}) => {
  const warns: string[] = [];
  const transport = new Transport({
    endpoint: "http://localhost:9999/api/public/otel/v1/traces",
    apiKey: "sk_test",
    fetchImpl,
    warn: (key) => warns.push(key),
    ...extra,
  });
  return { transport, warns };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("429 rate limiting", () => {
  it("honors Retry-After: pauses the sender for the window, then requeues and sends", async () => {
    vi.useFakeTimers();
    const responses = [
      new Response(null, { status: 429, headers: { "retry-after": "60" } }),
      new Response(null, { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? new Response(null, { status: 200 }));
    const { transport } = build(fetchMock as unknown as typeof fetch);

    transport.enqueue("{}");
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Mid-window: still paused, nothing dropped.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.stats().queued).toBe(1);
    // Window elapses: the same trace is retried and delivered.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transport.stats().sent).toBe(1);
    expect(transport.stats().queued).toBe(0);
    expect(transport.stats().dropped.byReason).toEqual({});
  });

  it("bounds pause-requeues: a persistently-429ing endpoint drops the trace, so flush can't hang", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 429, headers: { "retry-after": "1" } }),
    );
    const { transport, warns } = build(fetchMock as unknown as typeof fetch);

    transport.enqueue("{}");
    await vi.advanceTimersByTimeAsync(10_000);

    // Initial attempt + 3 bounded requeues, then dropped with its own reason.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(transport.stats().queued).toBe(0);
    expect(transport.stats().dropped.byReason["rate_limited"]).toBe(1);
    expect(warns).toContain("transport.429");
  });
});

describe("queue overflow", () => {
  it("drops the oldest queued trace and accounts for it", async () => {
    // A fetch that never settles keeps one trace in flight forever.
    const hangingFetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    const { transport, warns } = build(hangingFetch, { maxQueueTraces: 2 });

    transport.enqueue("a"); // claimed by the drain loop (in flight)
    await Promise.resolve();
    transport.enqueue("b");
    transport.enqueue("c");
    transport.enqueue("d"); // overflow: "b" (oldest queued) is dropped

    const stats = transport.stats();
    expect(stats.dropped.byReason["queue_overflow"]).toBe(1);
    // "c" + "d" queued, "a" still in flight.
    expect(stats.queued).toBe(3);
    expect(warns).toContain("transport.overflow");
  });
});
