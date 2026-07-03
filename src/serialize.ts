/*
 * SpanRecord[] → OTLP/HTTP JSON for one whole trace per request  * delivery contract). Applies the privacy pipeline (hide → scrub → redact)
 * to content attributes, is cycle-safe and depth-limited, and enforces the
 * client-side payload discipline: 32 KiB per content attribute, 4 MiB soft
 * cap per trace (largest span contents truncated first — structure, timing
 * and tokens always survive).
 */

import { TRACE_ATTR, TRACE_OPERATION } from "./attributes.js";
import { toInputMessages, toOutputMessages } from "./capture.js";
import { applyRedact, scrubValue, HIDDEN_PLACEHOLDER } from "./scrub.js";
import type { SettledTrace, SpanRecord } from "./trace.js";
import type { Warner } from "./warn.js";

/** Instrumentation-scope name stamped on every export. */
export const SCOPE_NAME = "@glassray/tracing";

/** SDK version stamped on the instrumentation scope (kept in step with package.json). */
export const SDK_VERSION = "0.1.0";

/** Per-content-attribute cap: 32 KiB, truncate-don't-drop. */
export const MAX_CONTENT_BYTES = 32 * 1024;

/** Whole-trace soft cap: 4 MiB — over budget truncates largest span contents first. */
export const MAX_TRACE_BYTES = 4 * 1024 * 1024;

/** Floor a content attribute can be squeezed to under the whole-trace budget pass. */
const MIN_CONTENT_BYTES = 256;

/** Depth limit for the safe serializer walk. */
const MAX_DEPTH = 8;

/** The subset of resolved config the serializer needs (metadata defaults + privacy switches). */
export type SerializeConfig = {
  agent: string | undefined;
  environment: string | undefined;
  customer: string | undefined;
  hideInputs: boolean;
  hideOutputs: boolean;
  scrubbing: boolean;
  redact: ((attrKey: string, value: unknown) => unknown) | undefined;
};

/** Byte length of a string in UTF-8 (Buffer.byteLength counts without allocating a copy). */
const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

// ── Safe stringify ───────────────────────────────────────────────────────────

/** Recursive JSON-safe copy: cycle markers, depth cap, everything else stringified. */
const prepare = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint" || t === "function" || t === "symbol") return String(value);
  if (t === "undefined") return "undefined";
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[max depth]";
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((v) => prepare(v, depth + 1, seen));
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof Error) return { name: obj.name, message: obj.message };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = prepare(v, depth + 1, seen);
    return out;
  } finally {
    seen.delete(obj);
  }
};

/**
 * Stringify any value for a content attribute — cycle-safe, depth-limited,
 * never throws (non-JSON values become `String(value)`). Strings pass
 * through unwrapped.
 */
export const safeStringify = (value: unknown): string => {
  try {
    if (typeof value === "string") return value;
    const json = JSON.stringify(prepare(value, 0, new WeakSet()));
    return json === undefined ? String(value) : json;
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
};

// ── Truncation ───────────────────────────────────────────────────────────────

/** The explicit marker appended where content was cut, naming the bytes removed. */
const truncationMarker = (removedBytes: number): string =>
  `…[glassray:truncated ${removedBytes} bytes]`;

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, appending the
 * truncation marker (marker bytes are reserved inside the cap, so the
 * result never exceeds it).
 */
export const truncateContent = (s: string, maxBytes: number): string => {
  const total = byteLength(s);
  if (total <= maxBytes) return s;
  // Reserve room for the marker (removed-count digits included) inside the cap.
  const reserve = 48;
  let end = Math.max(0, Math.min(s.length, maxBytes - reserve));
  while (end > 0 && byteLength(s.slice(0, end)) > maxBytes - reserve) {
    end = Math.floor(end * 0.9);
  }
  const kept = s.slice(0, end);
  return `${kept}${truncationMarker(total - byteLength(kept))}`;
};

// ── OTLP attribute plumbing ──────────────────────────────────────────────────

/** One OTLP `{ key, value }` attribute; value is the OTLP scalar union. */
type OtlpAttr = {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
};

/** Encode a scalar into the OTLP attribute-value union (integers ride `intValue` as strings). */
const attrValue = (v: string | number | boolean): OtlpAttr["value"] => {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: v };
};

/** A content attribute's mutable holder — kept so the 4 MiB pass can re-truncate in place. */
type ContentRef = { holder: { stringValue: string } };

/** Epoch-ms → integer nanoseconds-since-epoch as a string (BigInt — ns overflow Number). */
const msToNano = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString();

// ── Span assembly ────────────────────────────────────────────────────────────

/** Content directions map to the hide switches. */
type Direction = "input" | "output";

/**
 * Run the privacy pipeline over one content attribute and return its
 * final string: hide switch → scrub-by-default → fail-closed redact hook →
 * safe stringify → 32 KiB truncation. `undefined` means "emit nothing"
 * (redact hook returned undefined).
 */
const contentString = (
  key: string,
  raw: unknown,
  direction: Direction,
  cfg: SerializeConfig,
): string | undefined => {
  const hidden = direction === "input" ? cfg.hideInputs : cfg.hideOutputs;
  let value: unknown = raw;
  if (hidden) {
    value = HIDDEN_PLACEHOLDER;
  } else {
    if (cfg.scrubbing) value = scrubValue(value, key);
    value = applyRedact(cfg.redact, key, value);
    if (value === undefined) return undefined;
  }
  return truncateContent(safeStringify(value), MAX_CONTENT_BYTES);
};

/** Push a content attribute through the pipeline onto `attrs`, tracking its holder for the budget pass. */
const pushContent = (
  attrs: OtlpAttr[],
  refs: ContentRef[],
  key: string,
  raw: unknown,
  direction: Direction,
  cfg: SerializeConfig,
): void => {
  const s = contentString(key, raw, direction, cfg);
  if (s === undefined) return;
  const holder = { stringValue: s };
  attrs.push({ key, value: holder });
  refs.push({ holder });
};

/** Build one span's OTLP attribute list per its kind, collecting content refs. */
const buildSpanAttrs = (
  span: SpanRecord,
  trace: SettledTrace,
  cfg: SerializeConfig,
  refs: ContentRef[],
): OtlpAttr[] => {
  const attrs: OtlpAttr[] = [];
  const put = (key: string, v: string | number | boolean | undefined): void => {
    if (v !== undefined) attrs.push({ key, value: attrValue(v) });
  };

  switch (span.kind) {
    case "agent":
      put(TRACE_ATTR.GEN_AI_OPERATION_NAME, TRACE_OPERATION.INVOKE_AGENT);
      // Root agent name comes from config; nested agent spans use their own name.
      put(TRACE_ATTR.GEN_AI_AGENT_NAME, span.isRoot ? cfg.agent : span.name);
      break;
    case "llm":
      put(TRACE_ATTR.GEN_AI_OPERATION_NAME, TRACE_OPERATION.CHAT);
      // Both the current spelling and the deprecated alias, one release.
      put(TRACE_ATTR.GEN_AI_PROVIDER_NAME, span.provider);
      put(TRACE_ATTR.GEN_AI_SYSTEM, span.provider);
      put(TRACE_ATTR.GEN_AI_REQUEST_MODEL, span.model);
      break;
    case "tool":
      put(TRACE_ATTR.GEN_AI_OPERATION_NAME, TRACE_OPERATION.EXECUTE_TOOL);
      put(TRACE_ATTR.GEN_AI_TOOL_NAME, span.name);
      break;
    case "retriever":
    case "workflow":
      // Kind isn't inferable from an operation name — say it explicitly.
      put(TRACE_ATTR.GLASSRAY_SPAN_KIND, span.kind);
      break;
    default:
      break;
  }

  if (span.usage?.inputTokens !== undefined) {
    put(TRACE_ATTR.GEN_AI_USAGE_INPUT_TOKENS, span.usage.inputTokens);
  }
  if (span.usage?.outputTokens !== undefined) {
    put(TRACE_ATTR.GEN_AI_USAGE_OUTPUT_TOKENS, span.usage.outputTokens);
  }

  // Per-trace metadata overrides ride the ROOT span (root wins over resource).
  if (span.isRoot) {
    put(TRACE_ATTR.GLASSRAY_CUSTOMER, trace.customer);
    put(TRACE_ATTR.GLASSRAY_FLOW, trace.flow);
    put(TRACE_ATTR.GLASSRAY_ENVIRONMENT, trace.environment);
  }

  // Content: llm spans carry role+parts messages; everything else generic I/O.
  if (span.kind === "llm") {
    if (span.hasInput) {
      pushContent(attrs, refs, TRACE_ATTR.GEN_AI_INPUT_MESSAGES, toInputMessages(span.input), "input", cfg);
    }
    if (span.hasOutput) {
      const messages = toOutputMessages(span.output);
      if (messages) {
        pushContent(attrs, refs, TRACE_ATTR.GEN_AI_OUTPUT_MESSAGES, messages, "output", cfg);
      } else {
        pushContent(attrs, refs, TRACE_ATTR.OUTPUT_VALUE, span.output, "output", cfg);
      }
    }
  } else {
    if (span.hasInput) pushContent(attrs, refs, TRACE_ATTR.INPUT_VALUE, span.input, "input", cfg);
    if (span.hasOutput) pushContent(attrs, refs, TRACE_ATTR.OUTPUT_VALUE, span.output, "output", cfg);
  }

  if (span.errorMessage !== undefined) {
    put(TRACE_ATTR.ERROR_MESSAGE, truncateContent(span.errorMessage, MAX_CONTENT_BYTES));
  }
  if (span.autoClosed) put(TRACE_ATTR.GLASSRAY_SPAN_AUTO_CLOSED, true);

  return attrs;
};

// ── Trace serialization ──────────────────────────────────────────────────────

/**
 * Serialize one settled trace into the OTLP/HTTP JSON request body the
 * Glassray ingest accepts — one whole trace per request. Applies the privacy
 * pipeline and both payload caps. Returns the JSON string.
 */
export const serializeTrace = (trace: SettledTrace, cfg: SerializeConfig, warn: Warner): string => {
  const refs: ContentRef[] = [];

  const resourceAttrs: OtlpAttr[] = [];
  /** Append one resource attribute when its value is set. */
  const putResource = (key: string, v: string | undefined): void => {
    if (v !== undefined) resourceAttrs.push({ key, value: attrValue(v) });
  };
  putResource("service.name", cfg.agent);
  putResource(TRACE_ATTR.GLASSRAY_AGENT, cfg.agent);
  putResource(TRACE_ATTR.GLASSRAY_ENVIRONMENT, cfg.environment);
  putResource(TRACE_ATTR.GLASSRAY_CUSTOMER, cfg.customer);
  putResource(TRACE_ATTR.SESSION_ID, trace.sessionId);

  const spans = trace.spans.map((span) => ({
    traceId: trace.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: "SPAN_KIND_INTERNAL",
    startTimeUnixNano: msToNano(span.startMs),
    endTimeUnixNano: msToNano(span.endMs ?? span.startMs),
    attributes: buildSpanAttrs(span, trace, cfg, refs),
    ...(span.errorMessage !== undefined ? { status: { code: "STATUS_CODE_ERROR" } } : {}),
  }));

  const document = {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [{ scope: { name: SCOPE_NAME, version: SDK_VERSION }, spans }],
      },
    ],
  };

  let body = JSON.stringify(document);
  let bytes = byteLength(body);
  if (bytes > MAX_TRACE_BYTES) {
    // Greedy pass: shrink the largest content attributes first until the
    // estimated savings cover the overshoot, then re-stringify once.
    let excess = bytes - MAX_TRACE_BYTES;
    const sized = refs
      .map((ref) => ({ ref, size: byteLength(ref.holder.stringValue) }))
      .sort((a, b) => b.size - a.size);
    for (const { ref, size } of sized) {
      if (excess <= 0) break;
      if (size <= MIN_CONTENT_BYTES) continue;
      const target = Math.max(MIN_CONTENT_BYTES, size - excess);
      ref.holder.stringValue = truncateContent(ref.holder.stringValue, target);
      excess -= size - byteLength(ref.holder.stringValue);
    }
    body = JSON.stringify(document);
    bytes = byteLength(body);
    if (bytes > MAX_TRACE_BYTES) {
      warn(
        "serialize.budget",
        `trace ${trace.traceId} still ${bytes} bytes after truncation (soft cap ${MAX_TRACE_BYTES}) — sending anyway`,
      );
    }
  }
  return body;
};
