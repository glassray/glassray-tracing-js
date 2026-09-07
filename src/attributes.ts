/*
 * The Glassray trace-attribute contract — the attribute names this SDK
 * emits on the wire. The canonical copy lives in the Glassray platform
 * beside the ingest normalizer that reads these names back; a platform-side
 * pinning test asserts this vendored copy never drifts from it. Vendored
 * (not imported) so the published package keeps zero dependencies.
 */

/** Every attribute name in the contract, by symbolic name. */
export const TRACE_ATTR = {
  // ── OTel GenAI semconv (current generation) ────────────────────────────────
  /** Operation discriminator: `invoke_agent` / `chat` / `execute_tool` (see TRACE_OPERATION). */
  GEN_AI_OPERATION_NAME: "gen_ai.operation.name",
  /** Human-readable agent name on the root/agent span. */
  GEN_AI_AGENT_NAME: "gen_ai.agent.name",
  /** LLM provider (current spelling). */
  GEN_AI_PROVIDER_NAME: "gen_ai.provider.name",
  /** LLM provider (deprecated alias — SDK emits both for one release; ingest reads both). */
  GEN_AI_SYSTEM: "gen_ai.system",
  /** Requested model id on an `llm` span. */
  GEN_AI_REQUEST_MODEL: "gen_ai.request.model",
  GEN_AI_USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  GEN_AI_USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  /** Prompt-cache HIT tokens, Anthropic convention — counted BESIDE `input_tokens` (exclusive). */
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read_input_tokens",
  /** Prompt-cache WRITE tokens, Anthropic convention (exclusive). */
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS: "gen_ai.usage.cache_creation_input_tokens",
  /** Prompt-cache HIT tokens, OpenAI convention — counted INSIDE `input_tokens` (inclusive). */
  GEN_AI_USAGE_CACHED_INPUT_TOKENS: "gen_ai.usage.cached_input_tokens",
  /** Reasoning / thinking tokens (counted inside `output_tokens` on OpenAI). */
  GEN_AI_USAGE_REASONING_TOKENS: "gen_ai.usage.reasoning_tokens",
  /** The model that actually served the call (may differ from the requested alias). */
  GEN_AI_RESPONSE_MODEL: "gen_ai.response.model",
  /** Provider response id — the handle for a support ticket / provider-side lookup. */
  GEN_AI_RESPONSE_ID: "gen_ai.response.id",
  /** Why generation stopped (`end_turn` / `stop` / `max_tokens` / `tool_use` …); `error` marks a failed generation. */
  GEN_AI_RESPONSE_FINISH_REASON: "gen_ai.response.finish_reason",
  /** Sampling parameters read off the request (Langfuse "model parameters"). */
  GEN_AI_REQUEST_TEMPERATURE: "gen_ai.request.temperature",
  GEN_AI_REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  GEN_AI_REQUEST_TOP_P: "gen_ai.request.top_p",
  /** Chat input as a JSON string of OTel role+parts messages. */
  GEN_AI_INPUT_MESSAGES: "gen_ai.input.messages",
  /** Chat output as a JSON string of OTel role+parts messages. */
  GEN_AI_OUTPUT_MESSAGES: "gen_ai.output.messages",
  /** System/instructions content accompanying `gen_ai.input.messages`. */
  GEN_AI_SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  /** Tool/function name on an `execute_tool` span. */
  GEN_AI_TOOL_NAME: "gen_ai.tool.name",
  /** Older spelling of the session/conversation grouping id. */
  GEN_AI_CONVERSATION_ID: "gen_ai.conversation.id",

  // ── OpenInference generic I/O (any span kind) ──────────────────────────────
  INPUT_VALUE: "input.value",
  OUTPUT_VALUE: "output.value",

  // ── Cross-cutting OTel names ───────────────────────────────────────────────
  /** Session/conversation grouping id (emerging OTel convention; resource-level preferred). */
  SESSION_ID: "session.id",
  /** Error detail set beside an OTLP error status code. */
  ERROR_MESSAGE: "error.message",
  /** Error class name (`TypeError`, `APIError`, …) beside `error.message`. */
  ERROR_TYPE: "error.type",
  /** End-user id (OTel semconv) — the per-user cost / behaviour dimension; root-span override, resource default. */
  USER_ID: "user.id",
  /** Release / build version of the traced service (OTel semconv) — compare cost and behaviour across releases. */
  SERVICE_VERSION: "service.version",

  // ── Glassray vocabulary ────────────────────────────────────────────────────
  /** Explicit span kind (`agent`/`llm`/`tool`/`retriever`/`workflow`) when not inferable from `gen_ai.operation.name`. */
  GLASSRAY_SPAN_KIND: "glassray.span.kind",
  /** Stamped `true` on spans still open when the root settled (auto-closed by the SDK). */
  GLASSRAY_SPAN_AUTO_CLOSED: "glassray.span.auto_closed",
  /** Pre-computed USD cost on an `llm` span; overrides the platform's tokens×price estimate at ingest. */
  GLASSRAY_USAGE_COST: "glassray.usage.cost",
  // Glassray metadata convention — resource-level defaults, root-span override wins.
  GLASSRAY_CUSTOMER: "glassray.customer",
  /** @deprecated Ignored since 0.1.3 — the ingest key selects the project. Kept only so existing `TRACE_ATTR.GLASSRAY_ENVIRONMENT` references still compile; never emitted. */
  GLASSRAY_ENVIRONMENT: "glassray.environment",
  GLASSRAY_AGENT: "glassray.agent",
  GLASSRAY_FLOW: "glassray.flow",
  /** Recursion depth of a trace Glassray itself produced while evaluating another trace (`0`/absent for an ordinary trace) — lets a workspace that ingests Glassray's own traces cap trace-of-a-trace recursion. */
  GLASSRAY_DEPTH: "glassray.depth",
  /** @deprecated Ignored since 0.1.3 — the ingest key selects the project. Kept only so existing `TRACE_ATTR.DEPLOYMENT_ENVIRONMENT_NAME` references still compile; never emitted. */
  DEPLOYMENT_ENVIRONMENT_NAME: "deployment.environment.name",
} as const;

/** `gen_ai.operation.name` values the SDK emits, per span kind. */
export const TRACE_OPERATION = {
  INVOKE_AGENT: "invoke_agent",
  CHAT: "chat",
  EXECUTE_TOOL: "execute_tool",
} as const;

/** Values `glassray.span.kind` may carry. */
export const GLASSRAY_SPAN_KINDS = ["agent", "llm", "tool", "retriever", "workflow"] as const;
export type GlassraySpanKind = (typeof GLASSRAY_SPAN_KINDS)[number];
