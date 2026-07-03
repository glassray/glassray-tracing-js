/*
 * Privacy pipeline pieces: the hide placeholder, scrub-by-default of
 * secret-shaped keys/values inside structured I/O, and the fail-closed
 * customer redact hook. Applied by the serializer, content attributes only.
 */

/** Placeholder written in place of hidden content (hide switches). */
export const HIDDEN_PLACEHOLDER = "[hidden]";

/** Placeholder written when the customer's redact hook throws — fail-closed, never the raw value. */
export const REDACTION_FAILED_PLACEHOLDER = "[redaction hook failed — value withheld]";

/** Secret-shaped key patterns scrubbed by default inside structured I/O. */
export const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /api[._-]?key/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /jwt/i,
  /ssn/i,
  /credit[._-]?card/i,
];

/** Secret-shaped value pattern (Glassray/Stripe-style `sk_…` keys) — scrubbed regardless of key. */
export const SECRET_VALUE_PATTERN = /\bsk_[a-zA-Z0-9]+/;

/** Depth limit for the scrub walk — mirrors the serializer's depth cap. */
const MAX_SCRUB_DEPTH = 8;

/** The replacement written where a secret was found, naming the matched key. */
const scrubPlaceholder = (key: string): string => `[scrubbed: matched '${key}']`;

/** True when an object key matches one of the secret-shaped patterns. */
const isSecretKey = (key: string): boolean => SECRET_KEY_PATTERNS.some((re) => re.test(key));

/** Recursive scrub walk — copies containers, never mutates the input. */
const scrubWalk = (value: unknown, keyHint: string, depth: number, seen: WeakSet<object>): unknown => {
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERN.test(value) ? scrubPlaceholder(keyHint) : value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_SCRUB_DEPTH) return value;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => scrubWalk(v, keyHint, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? scrubPlaceholder(k) : scrubWalk(v, k, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
};

/**
 * Scrub-by-default: deep-copy `value`, replacing entries under secret-shaped
 * keys and `sk_…`-shaped string values with `[scrubbed: matched '<key>']`.
 * Cycle-safe and depth-limited; never mutates the original.
 */
export const scrubValue = (value: unknown, attrKey: string): unknown =>
  scrubWalk(value, attrKey, 0, new WeakSet());

/**
 * Apply the customer's redact hook to a content attribute — fail-closed: if
 * the hook throws, the value is withheld (placeholder), never sent raw.
 */
export const applyRedact = (
  redact: ((attrKey: string, value: unknown) => unknown) | undefined,
  attrKey: string,
  value: unknown,
): unknown => {
  if (!redact) return value;
  try {
    return redact(attrKey, value);
  } catch {
    return REDACTION_FAILED_PLACEHOLDER;
  }
};
