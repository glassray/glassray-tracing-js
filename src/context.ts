/*
 * AsyncLocalStorage-based current-span tracking. Nesting follows call
 * structure: parallel `t.tool()` calls started from the same context become
 * siblings; a span opened inside another span's callback becomes its child.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SpanHandle } from "./trace.js";

/** Process-wide store of the innermost open SDK span for the current async flow. */
const spanStorage = new AsyncLocalStorage<SpanHandle | undefined>();

/** The innermost open span in the current async context, if any. */
export const currentSpan = (): SpanHandle | undefined => spanStorage.getStore();

/** Run `fn` with `span` as the current context span (children created inside nest under it). */
export const runWithSpan = <T>(span: SpanHandle | undefined, fn: () => T): T =>
  spanStorage.run(span, fn);
