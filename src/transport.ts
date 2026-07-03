/*
 * Transport: bounded in-memory queue (drop-oldest + warn-once on
 * overflow), gzip for large bodies, fetch with a 10 s timeout, and the
 * Sentry-derived retry doctrine — honor 429/Retry-After (bounded requeues),
 * jittered backoff (max 2) for 503/network, drop every other failure
 * immediately, mute on 401/403. All timers are unref'd; nothing holds the
 * event loop open.
 */

import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Warner } from "./warn.js";

/** Async gzip (zlib threadpool — never blocks the loop). */
const gzipAsync = promisify(gzip);

/** Bodies at or above this size are gzip-compressed before POST. */
const GZIP_THRESHOLD_BYTES = 8 * 1024;

/** Per-request timeout. */
const FETCH_TIMEOUT_MS = 10_000;

/** Queue bounds — the documented trust numbers: 100 traces / 20 MiB. */
const MAX_QUEUE_TRACES = 100;
const MAX_QUEUE_BYTES = 20 * 1024 * 1024;

/** Retry attempts allowed after the first send, for 503/network failures only. */
const MAX_RETRIES = 2;

/** Base backoff for 503/network retries (doubled per attempt, plus jitter). */
const BACKOFF_BASE_MS = 500;

/** Pause applied when a 429 arrives without a parseable Retry-After. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/** Upper bound on how long a Retry-After header can pause the sender. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** Pause-requeues allowed per item on 429 before it drops as `rate_limited` — keeps `flush()` bounded. */
const MAX_RATE_LIMIT_REQUEUES = 3;

/** Public lifecycle/statistics shape returned by `glassray.stats()`. */
export type GlassrayStats = {
  sent: number;
  dropped: { byReason: Record<string, number> };
  queued: number;
};

/** Construction options for the transport (test seams included, all defaulted). */
export type TransportOptions = {
  /** Full OTLP traces URL. */
  endpoint: string;
  apiKey: string | undefined;
  fetchImpl: typeof fetch | undefined;
  warn: Warner;
  /** When set, every enqueue is dropped with this reason (sending disabled by config). */
  disabledReason?: string;
  /** Test seams — production uses the documented defaults above. */
  maxQueueTraces?: number;
  maxQueueBytes?: number;
  backoffBaseMs?: number;
  fetchTimeoutMs?: number;
};

/** One queued trace body awaiting send. */
type QueueItem = {
  body: string;
  bytes: number;
  attempts: number;
  /** Times this item was requeued after a 429 (capped at MAX_RATE_LIMIT_REQUEUES). */
  pauses: number;
  /** Gzipped body, compressed once on the first large send and reused across attempts. */
  compressed?: Uint8Array;
};

/** Outcome of a single send attempt, driving the drain loop. */
type SendOutcome = "sent" | "pause" | "retry" | "drop-auth" | "drop-413" | "drop-4xx";

/** Promise-based sleep whose timer never holds the process open. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

/** Parse a Retry-After header (delta-seconds or HTTP-date) into a bounded ms window. */
const parseRetryAfterMs = (raw: string | null): number => {
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return DEFAULT_RETRY_AFTER_MS;
};

/**
 * The bounded, single-in-flight sender. `enqueue` never throws and never
 * blocks; delivery happens on a background drain loop; every failure mode
 * lands in the drop accounting visible via `stats()`.
 */
export class Transport {
  private readonly opts: TransportOptions;
  private readonly maxTraces: number;
  private readonly maxBytes: number;
  private readonly backoffBase: number;
  private readonly queue: QueueItem[] = [];
  private queuedBytes = 0;
  private inFlight = false;
  /** The item currently inside a fetch attempt (out of the queue), for accurate `queued` stats. */
  private currentItem: QueueItem | null = null;
  private muted = false;
  private stopped = false;
  private pausedUntil = 0;
  private sentCount = 0;
  private droppedByReason: Record<string, number> = {};
  private drainPromise: Promise<void> | null = null;

  constructor(opts: TransportOptions) {
    this.opts = opts;
    this.maxTraces = opts.maxQueueTraces ?? MAX_QUEUE_TRACES;
    this.maxBytes = opts.maxQueueBytes ?? MAX_QUEUE_BYTES;
    this.backoffBase = opts.backoffBaseMs ?? BACKOFF_BASE_MS;
  }

  /** Count one dropped trace under `reason` (also used by the client for serialize failures). */
  recordDrop(reason: string): void {
    this.droppedByReason[reason] = (this.droppedByReason[reason] ?? 0) + 1;
  }

  /** Queue one serialized trace body for delivery. Never throws. */
  enqueue(body: string): void {
    try {
      if (this.opts.disabledReason) {
        this.recordDrop(this.opts.disabledReason);
        return;
      }
      if (this.stopped) {
        this.recordDrop("shutdown");
        return;
      }
      if (this.muted) {
        this.recordDrop("auth");
        return;
      }
      const bytes = Buffer.byteLength(body, "utf8");
      this.queue.push({ body, bytes, attempts: 0, pauses: 0 });
      this.queuedBytes += bytes;
      while (
        this.queue.length > 1 &&
        (this.queue.length > this.maxTraces || this.queuedBytes > this.maxBytes)
      ) {
        const oldest = this.queue.shift();
        if (!oldest) break;
        this.queuedBytes -= oldest.bytes;
        this.recordDrop("queue_overflow");
        this.opts.warn(
          "transport.overflow",
          `trace queue full (${this.maxTraces} traces / ${this.maxBytes} bytes) — dropping oldest`,
        );
      }
      this.kick();
    } catch (err) {
      this.opts.warn("transport.enqueue", `enqueue failed: ${String(err)}`);
    }
  }

  /** Awaitable drain — resolves when the queue is empty and nothing is in flight (serverless flush). */
  async flush(): Promise<void> {
    try {
      while (this.queue.length > 0 || this.inFlight) {
        this.kick();
        await (this.drainPromise ?? Promise.resolve());
      }
    } catch (err) {
      this.opts.warn("transport.flush", `flush failed: ${String(err)}`);
    }
  }

  /** Flush then stop accepting new traces. */
  async shutdown(): Promise<void> {
    await this.flush();
    this.stopped = true;
  }

  /** Delivery counters: sent, dropped by reason, and currently queued (incl. in flight). */
  stats(): GlassrayStats {
    return {
      sent: this.sentCount,
      dropped: { byReason: { ...this.droppedByReason } },
      queued: this.queue.length + (this.currentItem ? 1 : 0),
    };
  }

  /** Start the background drain loop if it isn't already running. */
  private kick(): void {
    if (this.inFlight || this.queue.length === 0) return;
    this.inFlight = true;
    this.drainPromise = this.drain()
      .catch((err) => this.opts.warn("transport.drain", `drain loop failed: ${String(err)}`))
      .finally(() => {
        this.inFlight = false;
        this.currentItem = null;
        // An enqueue can land between drain() resolving and this reset — its
        // kick() saw inFlight=true and no-opped, so re-kick to keep the
        // invariant "queue non-empty ⇒ a drain is scheduled".
        if (this.queue.length > 0) this.kick();
      });
  }

  /** Sequential sender: one in-flight request at a time, honoring pauses and backoff. */
  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.muted) {
        // Auth is terminal — everything pending drops.
        while (this.queue.length > 0) {
          const item = this.queue.shift();
          if (item) {
            this.queuedBytes -= item.bytes;
            this.recordDrop("auth");
          }
        }
        return;
      }
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);

      const item = this.queue.shift();
      if (!item) return;
      this.queuedBytes -= item.bytes;

      this.currentItem = item;
      const outcome = await this.sendOnce(item);
      this.currentItem = null;
      switch (outcome) {
        case "sent":
          this.sentCount += 1;
          break;
        case "pause":
          // Rate limited: requeue at the head (bounded — a persistently-429ing
          // endpoint must not hang flush/shutdown); the loop sleeps out the window.
          item.pauses += 1;
          if (item.pauses > MAX_RATE_LIMIT_REQUEUES) {
            this.recordDrop("rate_limited");
            this.opts.warn(
              "transport.429",
              "trace dropped after repeated rate limiting (HTTP 429) — reduce send volume",
            );
          } else {
            this.queue.unshift(item);
            this.queuedBytes += item.bytes;
          }
          break;
        case "retry": {
          item.attempts += 1;
          if (item.attempts > MAX_RETRIES) {
            this.recordDrop("retry_exhausted");
            this.opts.warn(
              "transport.retry",
              "trace dropped after repeated network/503 failures — is the endpoint reachable?",
            );
          } else {
            this.queue.unshift(item);
            this.queuedBytes += item.bytes;
            const backoff = this.backoffBase * 2 ** (item.attempts - 1);
            await sleep(backoff + Math.random() * this.backoffBase);
          }
          break;
        }
        case "drop-auth":
          this.muted = true;
          this.recordDrop("auth");
          this.opts.warn(
            "transport.auth",
            "Glassray rejected the API key (401/403) — sending muted; check GLASSRAY_API_KEY",
          );
          break;
        case "drop-413":
          this.recordDrop("payload_too_large");
          this.opts.warn("transport.413", "trace rejected as too large (HTTP 413) — dropped");
          break;
        case "drop-4xx":
          this.recordDrop("client_error");
          this.opts.warn("transport.4xx", "Glassray rejected a trace (4xx) — dropped");
          break;
      }
    }
  }

  /** One POST attempt: gzip large bodies, 10 s abort, map the response to an outcome. */
  private async sendOnce(item: QueueItem): Promise<SendOutcome> {
    const fetchImpl = this.opts.fetchImpl;
    if (!fetchImpl) return "drop-4xx";

    const controller = new AbortController();
    const timeoutMs = this.opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey ?? ""}`,
      };
      let payload: string | Uint8Array = item.body;
      if (item.bytes >= GZIP_THRESHOLD_BYTES) {
        // Compress once per item; retry/pause attempts reuse the same bytes.
        item.compressed ??= await gzipAsync(item.body);
        payload = item.compressed;
        headers["content-encoding"] = "gzip";
      }
      const res = await fetchImpl(this.opts.endpoint, {
        method: "POST",
        headers,
        body: payload as RequestInit["body"],
        signal: controller.signal,
      });
      // Consume the body so keep-alive sockets are released promptly.
      await res.arrayBuffer().catch(() => undefined);

      if (res.ok) return "sent";
      if (res.status === 429) {
        this.pausedUntil = Date.now() + parseRetryAfterMs(res.headers.get("retry-after"));
        return "pause";
      }
      if (res.status === 401 || res.status === 403) return "drop-auth";
      if (res.status === 413) return "drop-413";
      if (res.status >= 500 || res.status === 408) return "retry";
      return "drop-4xx";
    } catch {
      // Network error / timeout — retryable.
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }
}
