/*
 * `@glassray/tracing` — public entry point. The attribute-contract constants
 * are exported for advanced users (and pinned against the Glassray ingest
 * contract by a platform-side test); the tracer API is exported below.
 */
export * from "./attributes.js";

export { Glassray, type WrapOptions } from "./client.js";
export { type GlassrayOptions, DEFAULT_ENDPOINT_BASE } from "./config.js";
export {
  createTraceId,
  SpanHandle,
  TraceHandle,
  type LlmOptions,
  type SpanOptions,
  type TraceMeta,
} from "./trace.js";
export type { Usage } from "./capture.js";
export type { GlassrayStats } from "./transport.js";
