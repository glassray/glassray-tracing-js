/*
 * Best-effort capture helpers: token-usage extraction from the two common
 * provider response shapes, and LLM message shaping into the OTel role+parts
 * schema that `gen_ai.input.messages` / `gen_ai.output.messages` carry.
 */

/**
 * Best-effort token usage extracted from a provider response (or set explicitly
 * via `setUsage`). `cost` is an optional pre-computed USD figure — when present
 * it OVERRIDES the platform's tokens×price estimate at ingest (via the
 * `glassray.usage.cost` attribute); leave it unset to let the platform compute.
 */
export type Usage = { inputTokens?: number; outputTokens?: number; cost?: number };

/** One OTel role+parts chat message — the element shape inside `gen_ai.*.messages` JSON strings. */
export type OtelMessage = { role: string; parts: { type: string; content: unknown }[] };

/** Finite number or `undefined` — tolerant reader for token counts. */
const numOr = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Loose object check used by the shape sniffers below. */
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Extract token usage from a provider response: Anthropic
 * `usage.{input,output}_tokens` or OpenAI `usage.{prompt,completion}_tokens`,
 * plus a best-effort `usage.cost`/`usage.total_cost` (gateways like OpenRouter
 * return one). `undefined` when none of the three is present.
 */
export const extractUsage = (result: unknown): Usage | undefined => {
  if (!isObject(result)) return undefined;
  const usage = result.usage;
  if (!isObject(usage)) return undefined;
  const inputTokens = numOr(usage.input_tokens) ?? numOr(usage.prompt_tokens);
  const outputTokens = numOr(usage.output_tokens) ?? numOr(usage.completion_tokens);
  const cost = numOr(usage.cost) ?? numOr(usage.total_cost);
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return undefined;
  return { inputTokens, outputTokens, cost };
};

/** True when `value` looks like a `{role, content}[]` chat-message array. */
const isMessageArray = (value: unknown): value is { role: string; content: unknown }[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((m) => isObject(m) && typeof m.role === "string" && "content" in m);

/** Wrap one message's content as OTel parts: string content → one text part; anything else carried as-is. */
const toParts = (content: unknown): OtelMessage["parts"] => [{ type: "text", content }];

/**
 * Shape an LLM span's input into OTel role+parts messages: a
 * `{role, content}[]` array maps message-per-message; an object carrying a
 * `messages` array (a raw Anthropic/OpenAI request) uses that; anything else
 * wraps as a single user text part.
 */
export const toInputMessages = (input: unknown): OtelMessage[] => {
  const messages = isMessageArray(input)
    ? input
    : isObject(input) && isMessageArray(input.messages)
      ? input.messages
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
