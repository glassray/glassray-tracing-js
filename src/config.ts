/*
 * Config resolution: explicit constructor options > environment variables >
 * defaults. Invalid config never throws — it warns
 * through the rate-limited logger and disables what it must (fail-open
 * extends to misconfiguration).
 */

import type { Warner } from "./warn.js";

/** Constructor options for `new Glassray(...)` — the full public config surface. */
export type GlassrayOptions = {
  /** Glassray ingest API key (`sk_…`, `traces:write`). Default: `GLASSRAY_API_KEY`. */
  apiKey?: string;
  /** App origin (e.g. `https://app.glassray.ai`) or full OTLP traces URL. Default: `GLASSRAY_ENDPOINT` else the baked prod origin. */
  endpoint?: string;
  /** Agent name — resource-level metadata default (`glassray.agent`, `service.name`). */
  agent?: string;
  /** @deprecated Ignored since 0.1.3 — the ingest key selects the project. Still accepted for compile compatibility; setting it warns once and no longer affects routing or emission. */
  environment?: string;
  /** Customer identifier — resource-level metadata default (`glassray.customer`). */
  customer?: string;
  /**
   * Arbitrary custom attributes attached to every trace as **resource-level
   * defaults** (per-process). Emitted verbatim as OTLP resource attributes, so
   * Glassray can filter traces by them (APP-14941) — e.g.
   * `{ environment: "production", region: "eu" }`. Values are scalar
   * (string / number / boolean); a per-trace `meta.attributes` of the same key
   * overrides one here. Keys under a reserved namespace (`glassray.*`,
   * `gen_ai.*`, and the OTel infra prefixes) are dropped with a warning.
   */
  attributes?: Record<string, string | number | boolean>;
  /** Redaction hook applied to every content attribute before send. Fail-closed: a throw withholds the value. */
  redact?: (attrKey: string, value: unknown) => unknown;
  /** Sampling rate 0–1, decided once at trace start (whole-trace coherent). Default 1. */
  sampleRate?: number;
  /** Master switch. Default true; `GLASSRAY_TRACING=false` kills tracing when unset. */
  enabled?: boolean;
  /** Sink for SDK warnings; default `console.warn`. */
  onWarn?: (msg: string) => void;
  /** Scrub-by-default of secret-shaped keys/values inside structured I/O. Default true. */
  scrubbing?: boolean;
  /** Replace all input content with `[hidden]` (structure/timing/tokens still flow). */
  hideInputs?: boolean;
  /** Replace all output content with `[hidden]` (structure/timing/tokens still flow). */
  hideOutputs?: boolean;
  /** Injectable fetch implementation (tests / custom agents). Default: global `fetch`. */
  fetch?: typeof fetch;
};

/** Default Glassray app origin baked into the SDK (overridable via `endpoint` / `GLASSRAY_ENDPOINT`). */
export const DEFAULT_ENDPOINT_BASE = "https://app.glassray.ai";

/** Path of the OTLP traces ingest route on a Glassray app origin. */
const OTLP_TRACES_PATH = "/api/public/otel/v1/traces";

/** Fully resolved, validated runtime configuration consumed by the client/serializer/transport. */
export type ResolvedConfig = {
  /** Tracing at all — false makes every handle inert. */
  enabled: boolean;
  /** Whether the transport may actually POST; false = record-and-drop (missing key / bad endpoint). */
  sendingEnabled: boolean;
  apiKey: string | undefined;
  /** Full OTLP traces URL (endpoint already resolved/appended). */
  endpoint: string;
  agent: string | undefined;
  customer: string | undefined;
  /** Resource-level custom attribute defaults (per-process), emitted verbatim. */
  attributes: Record<string, string | number | boolean> | undefined;
  redact: ((attrKey: string, value: unknown) => unknown) | undefined;
  sampleRate: number;
  scrubbing: boolean;
  hideInputs: boolean;
  hideOutputs: boolean;
  fetchImpl: typeof fetch | undefined;
};

/** Parse common boolean env spellings; `undefined` when unset or unrecognised. */
const envBool = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
};

/** Read one env var, tolerating environments without `process` (never throws). */
const envVar = (name: string): string | undefined => {
  try {
    return typeof process !== "undefined" ? process.env[name] : undefined;
  } catch {
    return undefined;
  }
};

/** The single `GLASSRAY_DEBUG` parse — shared boolean spellings, `false` when unset. Never throws. */
export const resolveDebug = (): boolean => envBool(envVar("GLASSRAY_DEBUG")) ?? false;

/**
 * Resolve an endpoint value (app origin or full OTLP URL) to the full traces
 * URL: values already ending in `/v1/traces` pass through; anything else gets
 * the Glassray ingest path appended.
 */
export const resolveEndpoint = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}${OTLP_TRACES_PATH}`;
};

/**
 * Resolve the full config from constructor options + env + defaults. Never
 * throws: invalid values warn and fall back (sample rate) or disable sending
 * (endpoint, API key). Missing key disables sending, not the agent.
 */
export const resolveConfig = (options: GlassrayOptions, warn: Warner): ResolvedConfig => {
  try {
    const enabled = options.enabled ?? envBool(envVar("GLASSRAY_TRACING")) ?? true;

    // `environment` is deprecated since 0.1.3: the ingest key selects the project.
    // Accept it for compile compatibility but warn once and drop it from routing/emission.
    if (options.environment !== undefined) {
      warn(
        "config.environment",
        "the `environment` option is deprecated and ignored since 0.1.3 — the ingest key selects the project",
      );
    }

    // Sample rate: empty/whitespace env is unset (Number("") is 0, which would
    // silently drop everything); invalid → warn + default 1 (trace everything).
    let sampleRate = 1;
    const rawEnvRate = envVar("GLASSRAY_SAMPLE_RATE");
    const envRate =
      rawEnvRate !== undefined && rawEnvRate.trim() !== "" ? Number(rawEnvRate) : undefined;
    const rawRate = options.sampleRate ?? envRate;
    if (rawRate !== undefined) {
      if (typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate >= 0 && rawRate <= 1) {
        sampleRate = rawRate;
      } else {
        warn("config.sampleRate", `invalid sampleRate ${String(rawRate)} — using 1`);
      }
    }

    const apiKey = options.apiKey ?? envVar("GLASSRAY_API_KEY");
    let sendingEnabled = true;
    if (!apiKey) {
      sendingEnabled = false;
      if (enabled) {
        warn(
          "config.apiKey",
          "no API key (set GLASSRAY_API_KEY or pass apiKey) — traces will be recorded but not sent",
        );
      }
    }

    // Endpoint: unparseable / non-http(s) → warn + disable sending.
    const rawEndpoint = options.endpoint ?? envVar("GLASSRAY_ENDPOINT") ?? DEFAULT_ENDPOINT_BASE;
    let endpoint = resolveEndpoint(rawEndpoint);
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad protocol");
    } catch {
      warn("config.endpoint", `invalid endpoint ${JSON.stringify(rawEndpoint)} — sending disabled`);
      endpoint = resolveEndpoint(DEFAULT_ENDPOINT_BASE);
      sendingEnabled = false;
    }

    const fetchImpl =
      options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch : undefined);
    if (!fetchImpl && sendingEnabled) {
      warn("config.fetch", "global fetch is unavailable (Node >= 18 required) — sending disabled");
      sendingEnabled = false;
    }

    return {
      enabled,
      sendingEnabled,
      apiKey,
      endpoint,
      agent: options.agent,
      customer: options.customer,
      attributes: options.attributes,
      redact: options.redact,
      sampleRate,
      scrubbing: options.scrubbing ?? true,
      hideInputs: options.hideInputs ?? envBool(envVar("GLASSRAY_HIDE_INPUTS")) ?? false,
      hideOutputs: options.hideOutputs ?? envBool(envVar("GLASSRAY_HIDE_OUTPUTS")) ?? false,
      fetchImpl,
    };
  } catch (err) {
    // Unexpected resolution failure: fail open — tracing off, agent untouched.
    warn("config.resolve", `config resolution failed (${String(err)}) — tracing disabled`);
    return {
      enabled: false,
      sendingEnabled: false,
      apiKey: undefined,
      endpoint: resolveEndpoint(DEFAULT_ENDPOINT_BASE),
      agent: undefined,
      customer: undefined,
      attributes: undefined,
      redact: undefined,
      sampleRate: 1,
      scrubbing: true,
      hideInputs: false,
      hideOutputs: false,
      fetchImpl: undefined,
    };
  }
};
