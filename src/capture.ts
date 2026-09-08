/*
 * Best-effort capture helpers: token-usage + response-metadata extraction
 * from the two common provider response shapes, request-parameter extraction
 * from a raw request object, and LLM message shaping into the OTel role+parts
 * schema that `gen_ai.input.messages` / `gen_ai.output.messages` carry.
 */

/**
 * How a provider counts its cache / reasoning buckets relative to the
 * input/output totals. `exclusive` — the totals are already the fresh
 * remainder (Anthropic: `input_tokens` sits BESIDE `cache_read_input_tokens`).
 * `inclusive` — the totals CONTAIN the buckets (OpenAI: `prompt_tokens`
 * includes `prompt_tokens_details.cached_tokens`). The SDK emits the
 * convention-specific attribute spelling so Glassray never has to guess.
 */
export type UsageConvention = "inclusive" | "exclusive";

/**
 * Best-effort token usage extracted from a provider response (or set explicitly
 * via `setUsage`). `cost` is an optional pre-computed USD figure — when present
 * it OVERRIDES the platform's tokens×price estimate at ingest (via the
 * `glassray.usage.cost` attribute); leave it unset to let the platform compute.
 * The cache / reasoning buckets are what make that estimate right for prompt
 * caching and thinking models; `convention` says how the provider counted them
 * (`extractUsage` sets it; set it yourself when passing buckets to `setUsage`).
 */
/** The counts every usage carries; cost is an optional override of the platform estimate. */
type UsageCounts = {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
};

/** The cache / reasoning buckets — meaningful only together with the convention that says how they were counted. */
type UsageBuckets = {
  /** Prompt-cache HIT tokens (Anthropic `cache_read_input_tokens`, OpenAI `cached_tokens`). */
  cacheReadTokens?: number;
  /** Prompt-cache WRITE tokens (Anthropic `cache_creation_input_tokens`). */
  cacheWriteTokens?: number;
  /** Reasoning / thinking tokens (OpenAI `completion_tokens_details.reasoning_tokens`). */
  reasoningTokens?: number;
};

/**
 * Token usage for one LLM call. Supplying ANY cache / reasoning bucket requires
 * `convention`: without it Glassray cannot know whether `inputTokens` already
 * excludes the cache (Anthropic) or contains it (OpenAI), and the wrong guess
 * mis-prices the call. The type makes the omission a compile error; at runtime
 * a missing convention warns and is treated as `exclusive`.
 */
export type Usage = UsageCounts &
  (
    | (UsageBuckets & { convention: UsageConvention })
    | { cacheReadTokens?: undefined; cacheWriteTokens?: undefined; reasoningTokens?: undefined; convention?: UsageConvention }
  );

/**
 * Provider response metadata worth keeping beside the usage: the model that
 * actually served the call (may differ from the requested alias), the
 * provider's response id (support-ticket correlation), and why generation
 * stopped (`end_turn` / `stop` / `max_tokens` / `tool_use` …).
 */
export type ResponseMeta = { model?: string; id?: string; finishReason?: string };

/** Sampling parameters read off a raw request object — Langfuse's "model parameters". */
export type RequestParams = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Anthropic `system` (string or content blocks) — emitted as `gen_ai.system_instructions`. */
  systemInstructions?: unknown;
};

/** One OTel role+parts chat message — the element shape inside `gen_ai.*.messages` JSON strings. */
export type OtelMessage = { role: string; parts: { type: string; content: unknown }[] };

/** Finite number or `undefined` — tolerant reader for token counts. */
const numOr = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Non-empty string or `undefined`. */
const strOr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** Loose object check used by the shape sniffers below. */
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Extract token usage from a provider response. Anthropic
 * (`usage.{input,output}_tokens` beside `cache_read/creation_input_tokens` —
 * exclusive), OpenAI Chat Completions (`usage.{prompt,completion}_tokens`
 * containing `prompt_tokens_details.cached_tokens` /
 * `completion_tokens_details.reasoning_tokens` — inclusive) and OpenAI
 * Responses (`usage.{input,output}_tokens` containing
 * `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens`
 * — inclusive) are recognised, plus a best-effort `usage.cost`/`usage.total_cost`
 * (gateways like OpenRouter return one). `undefined` when nothing usable is
 * present.
 */
export const extractUsage = (result: unknown): Usage | undefined => {
  if (!isObject(result)) return undefined;
  const usage = result.usage;
  if (!isObject(usage)) return undefined;
  // OpenAI Responses API: `input_tokens` / `output_tokens` (inclusive) with
  // `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens`.
  // Only it carries those detail objects, which is how it is told apart from
  // Anthropic's identically named, exclusive top-level counts.
  const inputDetails = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  const responsesApi = inputDetails !== undefined || outputDetails !== undefined;
  const anthropic =
    !responsesApi && (numOr(usage.input_tokens) !== undefined || numOr(usage.output_tokens) !== undefined);
  const inputTokens = numOr(usage.input_tokens) ?? numOr(usage.prompt_tokens);
  const outputTokens = numOr(usage.output_tokens) ?? numOr(usage.completion_tokens);
  const cost = numOr(usage.cost) ?? numOr(usage.total_cost);
  const promptDetails = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const completionDetails = isObject(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : undefined;
  const cacheReadTokens =
    numOr(usage.cache_read_input_tokens) ??
    numOr(promptDetails?.cached_tokens) ??
    numOr(inputDetails?.cached_tokens);
  const cacheWriteTokens = numOr(usage.cache_creation_input_tokens);
  const reasoningTokens =
    numOr(completionDetails?.reasoning_tokens) ?? numOr(outputDetails?.reasoning_tokens);
  const hasBuckets =
    cacheReadTokens !== undefined || cacheWriteTokens !== undefined || reasoningTokens !== undefined;
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined && !hasBuckets) {
    return undefined;
  }
  if (!hasBuckets) return { inputTokens, outputTokens, cost };
  // Anthropic's `input_tokens` is the fresh remainder; OpenAI's totals (Chat
  // Completions `prompt_tokens`, Responses `input_tokens`) contain the cache.
  return {
    inputTokens,
    outputTokens,
    cost,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    convention: anthropic ? "exclusive" : "inclusive",
  };
};

/**
 * Extract response metadata from a provider response: `model` and `id` are
 * top-level on both Anthropic and OpenAI responses; the finish reason is
 * Anthropic `stop_reason` or OpenAI `choices[0].finish_reason`. `undefined`
 * when none is present.
 */
export const extractResponseMeta = (result: unknown): ResponseMeta | undefined => {
  if (!isObject(result)) return undefined;
  const first = Array.isArray(result.choices) ? result.choices[0] : undefined;
  const meta: ResponseMeta = {
    model: strOr(result.model),
    id: strOr(result.id),
    finishReason: strOr(result.stop_reason) ?? (isObject(first) ? strOr(first.finish_reason) : undefined),
  };
  return meta.model === undefined && meta.id === undefined && meta.finishReason === undefined
    ? undefined
    : meta;
};

/** True when `value` looks like a `{role, content}[]` chat-message array. */
const isMessageArray = (value: unknown): value is { role: string; content: unknown }[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((m) => isObject(m) && typeof m.role === "string" && "content" in m);

/**
 * The request object inside a span's input: the input itself when it is a
 * plain object, else — for a `wrap`ped call recorded as its argument list,
 * e.g. `create(request, options)` — the first plain-object argument. Message
 * arrays are not request objects.
 */
export const requestObjectOf = (input: unknown): Record<string, unknown> | undefined => {
  if (isObject(input)) return input;
  if (Array.isArray(input) && !isMessageArray(input)) return input.find(isObject);
  return undefined;
};

/**
 * Read sampling parameters + system instructions off a raw request object
 * (the Anthropic / OpenAI `create(...)` argument, when that is what a span's
 * input is — directly, or as the first object of a wrapped argument list).
 * Anything else yields `undefined`.
 */
export const extractRequestParams = (rawInput: unknown): RequestParams | undefined => {
  const input = requestObjectOf(rawInput);
  if (!input) return undefined;
  const params: RequestParams = {
    temperature: numOr(input.temperature),
    maxTokens: numOr(input.max_tokens) ?? numOr(input.max_output_tokens) ?? numOr(input.max_completion_tokens),
    topP: numOr(input.top_p),
    systemInstructions: input.system !== undefined && input.system !== null ? input.system : undefined,
  };
  return params.temperature === undefined &&
    params.maxTokens === undefined &&
    params.topP === undefined &&
    params.systemInstructions === undefined
    ? undefined
    : params;
};


/** Wrap one message's content as OTel parts: string content → one text part; anything else carried as-is. */
const toParts = (content: unknown): OtelMessage["parts"] => [{ type: "text", content }];

/**
 * Shape an LLM span's input into OTel role+parts messages: a
 * `{role, content}[]` array maps message-per-message; an object carrying a
 * `messages` array (a raw Anthropic/OpenAI request) uses that; anything else
 * wraps as a single user text part.
 */
export const toInputMessages = (input: unknown): OtelMessage[] => {
  const request = requestObjectOf(input);
  const messages = isMessageArray(input)
    ? input
    : request && isMessageArray(request.messages)
      ? request.messages
      : undefined;
  if (messages) return messages.map((m) => ({ role: m.role, parts: toParts(m.content) }));
  return [{ role: "user", parts: toParts(input) }];
};

/**
 * Shape a known LLM response into OTel role+parts output messages: Anthropic
 * (`content` block array) and OpenAI chat completions (`choices[0].message`)
 * are recognised; anything else returns `undefined` so the caller falls back
 * to `output.value`.
 */
export const toOutputMessages = (output: unknown): OtelMessage[] | undefined => {
  if (!isObject(output)) return undefined;

  // Anthropic Messages API: { role: "assistant", content: [{type:"text",text}, {type:"tool_use",…}] }
  if (Array.isArray(output.content) && output.content.length > 0) {
    const role = typeof output.role === "string" ? output.role : "assistant";
    const parts = output.content.map((block: unknown): OtelMessage["parts"][number] => {
      if (isObject(block) && block.type === "text" && typeof block.text === "string") {
        return { type: "text", content: block.text };
      }
      if (isObject(block) && block.type === "tool_use") {
        return { type: "tool_call", content: block };
      }
      return { type: "text", content: block };
    });
    return [{ role, parts }];
  }

  // OpenAI chat completions: { choices: [{ message: { role, content, tool_calls? } }] }
  if (Array.isArray(output.choices) && output.choices.length > 0) {
    const first: unknown = output.choices[0];
    const message = isObject(first) ? first.message : undefined;
    if (isObject(message) && typeof message.role === "string") {
      const parts: OtelMessage["parts"] = [];
      if (message.content !== undefined && message.content !== null) {
        parts.push({ type: "text", content: message.content });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) parts.push({ type: "tool_call", content: call });
      }
      if (parts.length > 0) return [{ role: message.role, parts }];
    }
  }

  return undefined;
};
