/*
 * Rate-limited warn-once logger. The SDK must never crash or spam the host
 * process: each distinct problem is reported once (per message key), routed
 * to the customer's `onWarn` when provided, else `console.warn`. With
 * `GLASSRAY_DEBUG` on, repeat occurrences are logged too.
 */

/** Function shape used across the SDK to report internal problems: `key` dedupes, `message` is human-readable. */
export type Warner = (key: string, message: string) => void;

/** Cap on distinct warning keys remembered, guarding against unbounded key sets leaking memory. */
const MAX_TRACKED_KEYS = 1000;

/**
 * Create the SDK's internal warner. Logs each distinct `key` once; repeats
 * only when `debug` is on. Never throws — a failing log sink is swallowed.
 */
export const createWarner = (onWarn?: (msg: string) => void, debug = false): Warner => {
  const seen = new Set<string>();
  return (key, message) => {
    try {
      const first = !seen.has(key);
      if (first && seen.size < MAX_TRACKED_KEYS) seen.add(key);
      if (!first && !debug) return;
      const line = `[glassray] ${message}`;
      if (onWarn) onWarn(line);
      else console.warn(line);
    } catch {
      // Never let logging crash the host.
    }
  };
};
