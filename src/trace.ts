/*
 * TraceHandle / SpanHandle: the in-memory span buffer for one trace, timing
 * (monotonic-adjusted so children never precede parents), and settle logic —
 * a trace ships when it settles (success OR throw), spans still open at
 * settle are auto-closed. Unsampled/disabled traces get inert handles with
 * the same types so call sites never branch.
 */

import { createHash, randomBytes } from "node:crypto";
import type { GlassraySpanKind } from "./attributes.js";
import {
  extractResponseMeta,
  extractUsage,
  type ResponseMeta,
  type Usage,
  type UsageConvention,
} from "./capture.js";

/** Structural view of `Usage` for the runtime convention check (the public type is a union). */
type UsageCounts = { inputTokens?: number; outputTokens?: number; cost?: number };
/** The optional buckets, viewed structurally for the runtime convention check. */
type UsageBuckets = { cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number };
import { currentSpan, runWithSpan } from "./context.js";
import type { Warner } from "./warn.js";

// ── Public option types ──────────────────────────────────────────────────────

/** Per-trace metadata accepted by `glassray.trace` / `glassray.startTrace` (emitted as root-span attribute overrides). */
export type TraceMeta = {
  customer?: string;
  sessionId?: string;
  flow?: string;
  /** End-user id for this run (emitted as `user.id`) — the per-user cost / behaviour dimension, distinct from the per-customer one. */
  userId?: string;
  /** 32-char hex trace id (e.g. from `createTraceId`); invalid values warn and fall back to random. */
  traceId?: string;
  /**
   * Recursion depth for a trace produced while evaluating another trace
   * (emitted as `glassray.depth`). Only meaningful for platforms that trace
   * their own evaluation of ingested traces; ordinary agents leave it unset.
   */
  depth?: number;
  environment?: string;
  /**
   * Arbitrary custom attributes for THIS trace, emitted verbatim as root-span
   * attributes (overriding any resource-level default of the same key). Lets
   * Glassray filter traces by them (APP-14941) — e.g.
   * `{ merchantId: "acme", branch: "master" }`. Scalar values only; reserved
   * (`glassray.*` / `gen_ai.*` / OTel infra) keys are dropped with a warning.
   */
  attributes?: Record<string, string | number | boolean>;
};

/** Options accepted by the span helpers (`t.span`, `t.tool`, `t.startSpan`). */
export type SpanOptions = {
  kind?: GlassraySpanKind;
  /** Explicit input for the span (helpers can't see the callback's closure). */
  input?: unknown;
  /** LLM model id (meaningful on `llm`-kind spans). */
  model?: string;
  /** LLM provider name (meaningful on `llm`-kind spans). */
  provider?: string;
  /** `false` blocks automatic input capture for this span. */
  captureInput?: boolean;
  /** `false` blocks automatic output capture for this span. */
  captureOutput?: boolean;
};

/** Options for `t.llm(...)` — span options minus `kind` (it is always `llm`). */
export type LlmOptions = Omit<SpanOptions, "kind">;

/** Root-span options for `glassray.startTrace(name, meta, root)`: the root's kind (default `agent`) plus model/provider for an `llm` root. */
export type RootSpanOptions = Pick<SpanOptions, "kind" | "model" | "provider">;

// ── Internal records ─────────────────────────────────────────────────────────

/** One buffered span — everything the serializer needs to emit an OTLP span. */
export type SpanRecord = {
  spanId: string;
  parentSpanId: string | undefined;
  isRoot: boolean;
  name: string;
  kind: GlassraySpanKind | undefined;
  startMs: number;
  endMs: number | undefined;
  input: unknown;
  hasInput: boolean;
  output: unknown;
  hasOutput: boolean;
  usage: Usage | undefined;
  model: string | undefined;
  provider: string | undefined;
  /** Provider response metadata captured off an `llm` span's return value (model served, response id, finish reason). */
  response: ResponseMeta | undefined;
  errorMessage: string | undefined;
  /** Error class name (`err.name`) captured beside the message. */
  errorType: string | undefined;
  autoClosed: boolean;
};

/** A whole settled trace, handed to the serialize → transport pipeline. */
export type SettledTrace = {
  traceId: string;
  name: string;
  sessionId: string | undefined;
  customer: string | undefined;
  flow: string | undefined;
  userId: string | undefined;
  /** Recursion depth → `glassray.depth` on the root span (see `TraceMeta.depth`). */
  depth: number | undefined;
  environment: string | undefined;
  /** Per-trace custom attributes → root-span attribute overrides (APP-14941). */
  attributes: Record<string, string | number | boolean> | undefined;
  spans: SpanRecord[];
};

// ── IDs ──────────────────────────────────────────────────────────────────────

/** 16 random bytes as 32 hex chars — a W3C-compatible OTLP trace id. */
export const newTraceId = (): string => randomBytes(16).toString("hex");

/** 8 random bytes as 16 hex chars — a W3C-compatible OTLP span id. */
export const newSpanId = (): string => randomBytes(8).toString("hex");

/**
 * Deterministic trace id from a seed — first 16 bytes of sha256(seed) as
 * 32-char hex. Correlate Glassray traces with external ids (tickets,
 * requests) before any span exists.
 */
export const createTraceId = (seed: string): string =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);

/** Shape check for a caller-supplied trace id (32 hex chars). */
const VALID_TRACE_ID = /^[0-9a-f]{32}$/i;

// ── Buffer ───────────────────────────────────────────────────────────────────

/** True for promise-like values — used to pass sync results through synchronously. */
const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";

/** The thrown value's class name for `error.type` (`Error` subclasses only). */
const errorType = (err: unknown): string | undefined =>
  err instanceof Error && err.name ? err.name : undefined;

/** Normalize a thrown value into the `error.message` attribute string. */
const errorText = (err: unknown): string => {
  if (err instanceof Error) return err.message || err.name;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
};

/**
 * @internal The per-trace span buffer: creates spans (monotonic-clamped to
 * their parent), tracks settlement, and hands the finished trace to
 * `onSettle` exactly once. Exported only so the handles' declarations emit.
 */
export class TraceBuffer {
  readonly traceId: string;
  readonly spans: SpanRecord[] = [];
  settled = false;
  readonly warn: Warner;
  /** Validated `meta.depth` (see the constructor). */
  private readonly depth: number | undefined;
  private readonly meta: TraceMeta;
  private readonly name: string;
  private readonly onSettle: (trace: SettledTrace) => void;

  constructor(args: {
    name: string;
    meta: TraceMeta;
    warn: Warner;
    onSettle: (trace: SettledTrace) => void;
  }) {
    this.name = args.name;
    this.meta = args.meta;
    this.warn = args.warn;
    this.onSettle = args.onSettle;
    // `environment` supplied per-trace (not just on the constructor) is equally
    // deprecated + ignored since 0.1.3 — warn here too so the per-trace path
    // isn't silently dropped without the migration signal.
    if (args.meta.environment !== undefined) {
      this.warn(
        "trace.environment",
        "the `environment` trace metadata is deprecated and ignored since 0.1.3 — the ingest key selects the project",
      );
    }
    // `depth` is a recursion level: a finite, non-negative integer or nothing.
    // Anything else would serialise as a bogus level (or `null`) and defeat the
    // cap it exists for, so it is dropped with a warning.
    const depth = args.meta.depth;
    if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0)) {
      this.warn("trace.depth", `invalid depth ${String(depth)} (need a non-negative integer) — omitted`);
    }
    this.depth = depth !== undefined && Number.isInteger(depth) && depth >= 0 ? depth : undefined;
    const requested = args.meta.traceId;
    if (requested !== undefined && !VALID_TRACE_ID.test(requested)) {
      this.warn(
        "trace.traceId",
        `invalid traceId ${JSON.stringify(requested)} (need 32 hex chars, see createTraceId) — using a random id`,
      );
    }
    this.traceId = requested && VALID_TRACE_ID.test(requested) ? requested.toLowerCase() : newTraceId();
  }

  /** Open a span under `parent` (or as root). Returns `null` after settle — late spans can't ship. */
  createSpan(name: string, opts: SpanOptions, parent: SpanRecord | null): SpanRecord | null {
    if (this.settled) {
      this.warn("trace.late-span", `span "${name}" opened after its trace settled — ignored`);
      return null;
    }
    const record: SpanRecord = {
      spanId: newSpanId(),
      parentSpanId: parent?.spanId,
      isRoot: parent === null,
      name,
      kind: opts.kind,
      // Children never precede parents, even under clock adjustment.
      startMs: Math.max(Date.now(), parent?.startMs ?? 0),
      endMs: undefined,
      input: undefined,
      hasInput: false,
      output: undefined,
      hasOutput: false,
      usage: undefined,
      model: opts.model,
      provider: opts.provider,
      response: undefined,
      errorMessage: undefined,
      errorType: undefined,
      autoClosed: false,
    };
    // Explicit input always applies — captureInput gates automatic capture only.
    if (opts.input !== undefined) {
      record.input = opts.input;
      record.hasInput = true;
    }
    this.spans.push(record);
    return record;
  }

  /** Close `record` if still open, clamping end to start (monotonic). */
  endSpan(record: SpanRecord): void {
    if (record.endMs !== undefined) return;
    record.endMs = Math.max(Date.now(), record.startMs);
  }

  /** Settle the trace once: auto-close stragglers, then flush via `onSettle`. */
  settle(): void {
    if (this.settled) return;
    this.settled = true;
    const now = Date.now();
    for (const s of this.spans) {
      if (s.endMs === undefined) {
        s.endMs = Math.max(now, s.startMs);
        if (!s.isRoot) s.autoClosed = true;
      }
    }
    this.onSettle({
      traceId: this.traceId,
      name: this.name,
      sessionId: this.meta.sessionId,
      customer: this.meta.customer,
      flow: this.meta.flow,
      userId: this.meta.userId,
      depth: this.depth,
      environment: this.meta.environment,
      attributes: this.meta.attributes,
      spans: this.spans,
    });
  }
}

// ── Handles ──────────────────────────────────────────────────────────────────

/** Split the optional-options helper call forms: `(name, fn)` vs `(name, opts, fn)`. */
const splitArgs = <T>(
  optsOrFn: SpanOptions | (() => T),
  maybeFn?: () => T,
): { opts: SpanOptions; fn: () => T } =>
  typeof optsOrFn === "function"
    ? { opts: {}, fn: optsOrFn }
    : { opts: optsOrFn ?? {}, fn: maybeFn as () => T };

/**
 * Handle for one span. Inert when `record` is null (unsampled/disabled
 * trace, or SDK-internal failure) — every method no-ops but callbacks still
 * run and results pass through untouched.
 */
export class SpanHandle {
  /** @internal */ readonly record: SpanRecord | null;
  /** @internal */ readonly buffer: TraceBuffer | null;

  /** @internal */
  constructor(buffer: TraceBuffer | null, record: SpanRecord | null) {
    this.buffer = buffer;
    this.record = record;
  }

  /** Explicitly set this span's input — wins over any captured value. */
  setInput(value: unknown): void {
    try {
      if (!this.record) return;
      this.record.input = value;
      this.record.hasInput = true;
    } catch (err) {
      this.buffer?.warn("span.setInput", `setInput failed: ${String(err)}`);
    }
  }

  /** Explicitly set this span's output — wins over any captured value. */
  setOutput(value: unknown): void {
    try {
      if (!this.record) return;
      this.record.output = value;
      this.record.hasOutput = true;
    } catch (err) {
      this.buffer?.warn("span.setOutput", `setOutput failed: ${String(err)}`);
    }
  }

  /** Explicitly set token usage — wins over usage extracted from the return value. */
  setUsage(usage: Usage): void {
    try {
      if (!this.record) return;
      // The type requires `convention` beside any bucket; a JS caller can still
      // omit it, and the wrong guess mis-prices the call — say so once.
      const u = usage as UsageCounts & UsageBuckets & { convention?: UsageConvention };
      if (
        u.convention === undefined &&
        (u.cacheReadTokens !== undefined || u.cacheWriteTokens !== undefined || u.reasoningTokens !== undefined)
      ) {
        this.buffer?.warn(
          "span.setUsage.convention",
          "setUsage received cache/reasoning buckets without a `convention` — treated as exclusive (Anthropic-style); pass convention: \"inclusive\" if inputTokens contains the cached tokens",
        );
      }
      this.record.usage = usage;
    } catch (err) {
      this.buffer?.warn("span.setUsage", `setUsage failed: ${String(err)}`);
    }
  }

  /** Mark this span errored (OTLP error status + `error.message`). */
  setError(err: unknown): void {
    try {
      if (!this.record) return;
      this.record.errorMessage = errorText(err);
      this.record.errorType = errorType(err);
    } catch (e) {
      this.buffer?.warn("span.setError", `setError failed: ${String(e)}`);
    }
  }

  /** Close the span (idempotent). `{ output }` is an explicit output set. */
  end(opts?: { output?: unknown }): void {
    try {
      if (!this.record || !this.buffer) return;
      if (opts && "output" in opts) {
        this.record.output = opts.output;
        this.record.hasOutput = true;
      }
      this.buffer.endSpan(this.record);
    } catch (err) {
      this.buffer?.warn("span.end", `end failed: ${String(err)}`);
    }
  }

  /** Open a manual child span (parent = current context span, else this span). */
  startSpan(name: string, opts?: SpanOptions): SpanHandle {
    try {
      if (!this.buffer) return INERT_SPAN;
      const parent = resolveParent(this.buffer, this.record);
      return new SpanHandle(this.buffer, this.buffer.createSpan(name, opts ?? {}, parent));
    } catch (err) {
      this.buffer?.warn("span.startSpan", `startSpan failed: ${String(err)}`);
      return INERT_SPAN;
    }
  }

  /** Run `fn` inside a generic child span; the return value is captured as output. */
  span<T>(name: string, optsOrFn: SpanOptions | (() => T), maybeFn?: () => T): T {
    const { opts, fn } = splitArgs(optsOrFn, maybeFn);
    return this.runChild(name, opts.kind, opts, fn);
  }

  /** Run `fn` inside an `llm` span; input/output/usage are captured best-effort. */
  llm<T>(name: string, optsOrFn: LlmOptions | (() => T), maybeFn?: () => T): T {
    const { opts, fn } = splitArgs(optsOrFn as SpanOptions | (() => T), maybeFn);
    return this.runChild(name, "llm", opts, fn);
  }

  /** Run `fn` inside a `tool` span; the return value is captured as output. */
  tool<T>(name: string, optsOrFn: SpanOptions | (() => T), maybeFn?: () => T): T {
    const { opts, fn } = splitArgs(optsOrFn, maybeFn);
    return this.runChild(name, "tool", opts, fn);
  }

  /** Shared callback-scoped child runner: open span, bind context, settle on result/throw. */
  private runChild<T>(
    name: string,
    kind: GlassraySpanKind | undefined,
    opts: SpanOptions,
    fn: () => T,
  ): T {
    let handle: SpanHandle = INERT_SPAN;
    try {
      if (this.buffer) {
        const parent = resolveParent(this.buffer, this.record);
        handle = new SpanHandle(this.buffer, this.buffer.createSpan(name, { ...opts, kind }, parent));
      }
    } catch (err) {
      this.buffer?.warn("span.open", `failed to open span "${name}": ${String(err)}`);
    }
    return executeInSpan(handle, opts, fn);
  }
}

/** Parent resolution for new spans: innermost context span of the same trace, else the receiver. */
const resolveParent = (buffer: TraceBuffer, self: SpanRecord | null): SpanRecord | null => {
  const ctx = currentSpan();
  if (ctx && ctx.buffer === buffer && ctx.record && ctx.record.endMs === undefined) return ctx.record;
  return self;
};

/** Run `fn` bound to `handle`'s context; record output/usage/error and close the span; pass the outcome through untouched. */
const executeInSpan = <T>(handle: SpanHandle, opts: SpanOptions, fn: () => T): T => {
  /** Success path: capture output (+ usage on llm spans) unless explicitly set/opted out, then close. */
  const settleOk = (value: unknown): void => {
    try {
      const record = handle.record;
      if (!record || !handle.buffer) return;
      if (opts.captureOutput !== false && !record.hasOutput && value !== undefined) {
        record.output = value;
        record.hasOutput = true;
      }
      if (record.kind === "llm") {
        if (record.usage === undefined) record.usage = extractUsage(value);
        // Response metadata rides the return value too — model served, id, finish reason.
        if (record.response === undefined) record.response = extractResponseMeta(value);
      }
      handle.buffer.endSpan(record);
    } catch (err) {
      handle.buffer?.warn("span.settle", `failed to settle span: ${String(err)}`);
    }
  };
  /** Failure path: record the error and close; the throw itself is the caller's. */
  const settleErr = (err: unknown): void => {
    try {
      handle.setError(err);
      handle.end();
    } catch {
      // Already best-effort inside setError/end.
    }
  };

  let result: T;
  try {
    result = handle.record ? runWithSpan(handle, fn) : fn();
  } catch (err) {
    settleErr(err);
    throw err;
  }
  if (isThenable(result)) {
    return (result as PromiseLike<unknown>).then(
      (value) => {
        settleOk(value);
        return value;
      },
      (err) => {
        settleErr(err);
        throw err;
      },
    ) as T;
  }
  settleOk(result);
  return result;
};

/**
 * Handle for one trace. Extends the root span's surface (setters + child
 * helpers) with the trace lifecycle: `end()` settles and flushes. Inert when
 * the trace is unsampled or tracing is disabled.
 */
export class TraceHandle extends SpanHandle {
  /** @internal */
  constructor(buffer: TraceBuffer | null) {
    super(buffer, buffer?.spans[0] ?? null);
  }

  /** Settle the trace: close open spans (auto-close markers on stragglers) and flush. Idempotent. */
  override end(opts?: { output?: unknown }): void {
    try {
      if (!this.buffer || this.buffer.settled) return;
      if (this.record) {
        if (opts && "output" in opts) {
          this.record.output = opts.output;
          this.record.hasOutput = true;
        }
        this.buffer.endSpan(this.record);
      }
      this.buffer.settle();
    } catch (err) {
      this.buffer?.warn("trace.end", `end failed: ${String(err)}`);
    }
  }

  /**
   * @internal Mode-1/2 execution: run `fn` in this trace's context, capture
   * the return as root output (explicit setOutput wins), record a throw on
   * the root span — and always pass the customer's outcome through untouched.
   */
  run<T>(fn: (t: TraceHandle) => T): T {
    /** Success settle: root output from the return value unless explicitly set; an `llm` root also captures usage/response like a child llm span. */
    const settleOk = (value: unknown): void => {
      try {
        if (this.record && !this.record.hasOutput && value !== undefined) {
          this.record.output = value;
          this.record.hasOutput = true;
        }
        if (this.record?.kind === "llm") {
          if (this.record.usage === undefined) this.record.usage = extractUsage(value);
          if (this.record.response === undefined) this.record.response = extractResponseMeta(value);
        }
        this.end();
      } catch {
        // end() already warns.
      }
    };
    /** Error settle: record on the root span, then flush (errored runs are the interesting ones). */
    const settleErr = (err: unknown): void => {
      try {
        this.setError(err);
        this.end();
      } catch {
        // Best-effort.
      }
    };

    let result: T;
    try {
      result = this.record ? runWithSpan(this, () => fn(this)) : fn(this);
    } catch (err) {
      settleErr(err);
      throw err;
    }
    if (isThenable(result)) {
      return (result as PromiseLike<unknown>).then(
        (value) => {
          settleOk(value);
          return value;
        },
        (err) => {
          settleErr(err);
          throw err;
        },
      ) as T;
    }
    settleOk(result);
    return result;
  }
}

/** Shared inert span handle — returned wherever recording is off so call sites never branch. */
const INERT_SPAN = new SpanHandle(null, null);

/** Shared inert trace handle (all methods no-op; `run` still executes the callback). */
const INERT_TRACE = new TraceHandle(null);

/** An inert TraceHandle for unsampled/disabled traces. */
export const inertTraceHandle = (): TraceHandle => INERT_TRACE;

/**
 * Start recording a trace: creates the buffer + root span and returns the
 * live handle. `rootInput` (mode-2 args capture) pre-populates root input;
 * explicit `setInput` still wins.
 */
export const startTraceRecording = (args: {
  name: string;
  meta: TraceMeta;
  warn: Warner;
  onSettle: (trace: SettledTrace) => void;
  /** Root span kind (default `agent`) and, for an `llm` root, its model/provider. */
  root?: RootSpanOptions;
  rootInput?: { value: unknown };
}): TraceHandle => {
  const buffer = new TraceBuffer({
    name: args.name,
    meta: args.meta,
    warn: args.warn,
    onSettle: args.onSettle,
  });
  const root = buffer.createSpan(args.name, { ...args.root, kind: args.root?.kind ?? "agent" }, null);
  if (root && args.rootInput) {
    root.input = args.rootInput.value;
    root.hasInput = true;
  }
  return new TraceHandle(buffer);
};
