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

  // ── Glassray vocabulary ────────────────────────────────────────────────────
  /** Explicit span kind (`agent`/`llm`/`tool`/`retriever`/`workflow`) when not inferable from `gen_ai.operation.name`. */
  GLASSRAY_SPAN_KIND: "glassray.span.kind",
  /** Stamped `true` on spans still open when the root settled (auto-closed by the SDK). */
  GLASSRAY_SPAN_AUTO_CLOSED: "glassray.span.auto_closed",
  // Glassray metadata convention — resource-level defaults, root-span override wins.
  GLASSRAY_CUSTOMER: "glassray.customer",
  /** @deprecated Ignored since 0.1.3 — the ingest key selects the project. Kept only so existing `TRACE_ATTR.GLASSRAY_ENVIRONMENT` references still compile; never emitted. */
  GLASSRAY_ENVIRONMENT: "glassray.environment",
  GLASSRAY_AGENT: "glassray.agent",
  GLASSRAY_FLOW: "glassray.flow",
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
