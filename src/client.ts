/*
 * The `Glassray` client: config resolution, the three tracing modes
 * (callback-scoped `trace`, `wrap`, manual `startTrace`), sampling, and
 * lifecycle (`flush` / `shutdown` / best-effort beforeExit flush). Every
 * public method is try/catch-wrapped — SDK failure is lost telemetry, never
 * a broken agent (the never-crash rules).
 */

import type { GlassraySpanKind } from "./attributes.js";
import { resolveConfig, resolveDebug, type GlassrayOptions, type ResolvedConfig } from "./config.js";
import { serializeTrace } from "./serialize.js";
import {
  inertTraceHandle,
  startTraceRecording,
  TraceHandle,
  type SettledTrace,
  type TraceMeta,
} from "./trace.js";
import { Transport, type GlassrayStats } from "./transport.js";
import { createWarner, type Warner } from "./warn.js";

/** Options for `glassray.wrap(fn, …)` — mode 2. */
export type WrapOptions = { name?: string; kind?: GlassraySpanKind };

/** The Glassray tracing client. Construct once per process; all methods are crash-safe. */
export class Glassray {
  private readonly config: ResolvedConfig;
  private readonly warnLog: Warner;
  private readonly transport: Transport;
  private beforeExitHook: (() => void) | undefined;

  constructor(options: GlassrayOptions = {}) {
    // Constructor must never throw — build the safest possible fallbacks.
    let warnLog: Warner = () => {};
    let config: ResolvedConfig | undefined;
    try {
      warnLog = createWarner(options.onWarn, resolveDebug());
    } catch {
      // Keep the silent warner.
    }
    try {
      config = resolveConfig(options, warnLog);
    } catch {
      config = undefined;
    }
    this.warnLog = warnLog;
    this.config = config ?? resolveConfig({ enabled: false }, warnLog);
    this.transport = new Transport({
      endpoint: this.config.endpoint,
      apiKey: this.config.apiKey,
      fetchImpl: this.config.fetchImpl,
      warn: this.warnLog,
      disabledReason: this.config.sendingEnabled ? undefined : "disabled",
    });
    this.registerBeforeExit();
  }

  /** Mode 1 — run `fn` inside a new trace scoped to the callback. */
  trace<T>(name: string, fn: (t: TraceHandle) => T): T;
  trace<T>(name: string, meta: TraceMeta, fn: (t: TraceHandle) => T): T;
  trace<T>(
    name: string,
    metaOrFn: TraceMeta | ((t: TraceHandle) => T),
    maybeFn?: (t: TraceHandle) => T,
  ): T {
    const meta = typeof metaOrFn === "function" ? {} : metaOrFn;
    const fn = typeof metaOrFn === "function" ? metaOrFn : (maybeFn as (t: TraceHandle) => T);
    let handle: TraceHandle;
    try {
      handle = this.begin(name, meta ?? {}, "agent", undefined);
    } catch (err) {
      this.warnLog("client.trace", `failed to start trace "${name}": ${String(err)}`);
      handle = inertTraceHandle();
    }
    return handle.run(fn);
  }

  /** Mode 2 — wrap a function once; every call becomes a trace with root I/O from args/return. */
  wrap<A extends unknown[], R>(fn: (...args: A) => R, opts?: WrapOptions): (...args: A) => R {
    const name = opts?.name ?? (fn.name || "trace");
    const kind = opts?.kind ?? "agent";
    return (...args: A): R => {
      let handle: TraceHandle;
      try {
        const input = args.length === 0 ? undefined : args.length === 1 ? args[0] : args;
        handle = this.begin(name, {}, kind, args.length > 0 ? { value: input } : undefined);
      } catch (err) {
        this.warnLog("client.wrap", `failed to start trace "${name}": ${String(err)}`);
        handle = inertTraceHandle();
      }
      return handle.run(() => fn(...args));
    };
  }

  /** Mode 3 — manual lifecycle: returns a live handle; call `t.end(...)` to settle and flush. */
  startTrace(name: string, meta?: TraceMeta): TraceHandle {
    try {
      return this.begin(name, meta ?? {}, "agent", undefined);
    } catch (err) {
      this.warnLog("client.startTrace", `failed to start trace "${name}": ${String(err)}`);
      return inertTraceHandle();
    }
  }

  /** Awaitable drain of the send queue (serverless: `await glassray.flush()` before return). */
  async flush(): Promise<void> {
    try {
      await this.transport.flush();
    } catch (err) {
      this.warnLog("client.flush", `flush failed: ${String(err)}`);
    }
  }

  /** Flush then stop: no more traces are sent after this resolves. */
  async shutdown(): Promise<void> {
    try {
      if (this.beforeExitHook) {
        process.removeListener("beforeExit", this.beforeExitHook);
        this.beforeExitHook = undefined;
      }
      await this.transport.shutdown();
    } catch (err) {
      this.warnLog("client.shutdown", `shutdown failed: ${String(err)}`);
    }
  }

  /** Delivery counters: `{ sent, dropped: { byReason }, queued }`. */
  stats(): GlassrayStats {
    try {
      return this.transport.stats();
    } catch {
      return { sent: 0, dropped: { byReason: {} }, queued: 0 };
    }
  }

  /** Decide enablement + sampling and start recording (or hand back an inert handle). */
  private begin(
    name: string,
    meta: TraceMeta,
    rootKind: GlassraySpanKind,
    rootInput: { value: unknown } | undefined,
  ): TraceHandle {
    if (!this.config.enabled) return inertTraceHandle();
    // Whole-trace coherent sampling, decided once at trace start.
    if (this.config.sampleRate < 1 && Math.random() >= this.config.sampleRate) {
      return inertTraceHandle();
    }
    return startTraceRecording({
      name,
      meta,
      warn: this.warnLog,
      onSettle: this.handleSettle,
      rootKind,
      rootInput,
    });
  }

  /** Settled-trace sink: privacy pipeline + OTLP serialization, then enqueue for delivery. */
  private handleSettle = (trace: SettledTrace): void => {
    try {
      const body = serializeTrace(trace, this.config, this.warnLog);
      this.transport.enqueue(body);
    } catch (err) {
      this.warnLog("client.serialize", `failed to serialize trace: ${String(err)}`);
      try {
        this.transport.recordDrop("serialize_error");
      } catch {
        // Accounting is best-effort.
      }
    }
  };

  /** Best-effort flush when the event loop is about to drain (long-lived Node processes). */
  private registerBeforeExit(): void {
    try {
      if (!this.config.enabled || typeof process === "undefined" || !process.once) return;
      this.beforeExitHook = () => {
        try {
          void this.transport.flush();
        } catch {
          // Never block or crash exit.
        }
      };
      process.once("beforeExit", this.beforeExitHook);
    } catch {
      // beforeExit is best-effort only.
    }
  }
}
