/*
 * Privacy pipeline: scrub-by-default of secret-shaped keys and
 * `sk_…` values inside structured I/O, the `scrubbing: false` off switch,
 * and the fail-closed redact hook (a throwing hook withholds the value —
 * never ships raw data).
 */

import { describe, expect, it } from "vitest";
import { REDACTION_FAILED_PLACEHOLDER, scrubValue } from "../src/scrub.js";
import { serializeTrace, type SerializeConfig } from "../src/serialize.js";
import type { SettledTrace } from "../src/trace.js";

/** One-root-span trace fixture carrying `input` as root input. */
const traceWithInput = (input: unknown): SettledTrace => ({
  traceId: "0af7651916cd43dd8448eb211c80319c",
  name: "run",
  sessionId: undefined,
  customer: undefined,
  flow: undefined,
  environment: undefined,
  spans: [
    {
      spanId: "aaaaaaaaaaaaaaaa",
      parentSpanId: undefined,
      isRoot: true,
      name: "run",
      kind: "agent",
      startMs: 1_751_400_000_000,
      endMs: 1_751_400_000_100,
      input,
      hasInput: true,
      output: undefined,
      hasOutput: false,
      usage: undefined,
      model: undefined,
      provider: undefined,
      errorMessage: undefined,
      autoClosed: false,
    },
  ],
});

/** Serializer config fixture. */
const cfg = (over: Partial<SerializeConfig> = {}): SerializeConfig => ({
  agent: undefined,
  customer: undefined,
  hideInputs: false,
  hideOutputs: false,
  scrubbing: true,
  redact: undefined,
  ...over,
});

/** Pull the root `input.value` string out of a serialized body. */
const inputValueOf = (body: string): string => {
  const doc = JSON.parse(body) as {
    resourceSpans: {
      scopeSpans: {
        spans: { attributes: { key: string; value: { stringValue?: string } }[] }[];
      }[];
    }[];
  };
  const attrs = doc.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes ?? [];
  return attrs.find((a) => a.key === "input.value")?.value.stringValue ?? "";
};

describe("scrub-by-default", () => {
  it("replaces secret-shaped keys and sk_ values, naming the matched key", () => {
    const scrubbed = scrubValue(
      {
        password: "hunter2",
        apiKey: "abc",
        nested: { Authorization: "Bearer xyz", note: "fine" },
        list: ["sk_live_abc123"],
        ok: "kept",
      },
      "input.value",
    );
    expect(scrubbed).toEqual({
      password: "[scrubbed: matched 'password']",
      apiKey: "[scrubbed: matched 'apiKey']",
      nested: { Authorization: "[scrubbed: matched 'Authorization']", note: "fine" },
      list: ["[scrubbed: matched 'list']"],
      ok: "kept",
    });
  });

  it("scrubbing: false ships the raw structure", () => {
    const body = serializeTrace(
      traceWithInput({ password: "hunter2" }),
      cfg({ scrubbing: false }),
      () => {},
    );
    expect(inputValueOf(body)).toBe(JSON.stringify({ password: "hunter2" }));
  });
});

describe("redact hook", () => {
  it("is fail-closed: a throwing hook withholds the value", () => {
    const body = serializeTrace(
      traceWithInput({ note: "customer data" }),
      cfg({
        redact: () => {
          throw new Error("hook bug");
        },
      }),
      () => {},
    );
    expect(inputValueOf(body)).toBe(REDACTION_FAILED_PLACEHOLDER);
  });

  it("replaces the value with whatever the hook returns", () => {
    const body = serializeTrace(
      traceWithInput({ note: "secret" }),
      cfg({ redact: (key) => `<redacted ${key}>` }),
      () => {},
    );
    expect(inputValueOf(body)).toBe("<redacted input.value>");
  });
});
