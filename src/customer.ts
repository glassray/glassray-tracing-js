/*
 * The customer as one object. `customer` accepts either the bare identifier
 * (`"cus_8fa21"`, what every release so far took) or the identifier with the
 * display name, contact email and company domain beside it, spelled the way
 * OTel spells `user.id` / `user.name` / `user.email`. The identifier is what
 * Glassray filters and groups on; the rest names it in the customer directory
 * so the dashboard shows a company and its logo instead of an opaque id, and
 * nobody has to type every identifier by hand. Normalised once, here, for both
 * the constructor default and the per-trace override.
 */

import type { Warner } from "./warn.js";

/** A customer as an object: the identifier plus what names it in Glassray's customer directory. */
export type CustomerRef = {
  /** The stable identifier — what Glassray filters and groups on (`glassray.customer`). */
  id: string;
  /** Display name, e.g. `"Acme Corp"` (`glassray.customer.name`). */
  name?: string;
  /** A contact email; Glassray derives the company domain from it for the logo and does not store the address (`glassray.customer.email`). */
  email?: string;
  /** The company domain directly, when you have that rather than an email (`glassray.customer.domain`). */
  domain?: string;
};

/** The display fields of a `CustomerRef`, as the serializer emits them beside the identifier. */
export type CustomerProfile = {
  name: string | undefined;
  email: string | undefined;
  domain: string | undefined;
};

/** A `customer` option split into what rides `glassray.customer` and what rides its `.name` / `.email` / `.domain` companions. */
export type NormalizedCustomer = {
  id: string | undefined;
  profile: CustomerProfile | undefined;
};

/** A trimmed non-empty string, else `undefined`. */
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/**
 * Normalise a `customer` option. A string is the identifier alone. An object
 * needs a non-empty `id` — without one there is nothing to name, so the whole
 * value is dropped with a warning rather than emitting a profile that
 * attaches to no customer. Empty or non-string profile fields are dropped
 * quietly (they are optional). Never throws: a malformed value warns and
 * yields nothing, like every other config error.
 */
export const normalizeCustomer = (
  value: string | CustomerRef | undefined,
  warn: Warner,
  scope: string,
): NormalizedCustomer => {
  if (value === undefined) return { id: undefined, profile: undefined };
  if (typeof value === "string") return { id: str(value), profile: undefined };
  if (typeof value !== "object" || value === null) {
    warn(scope, `invalid customer ${String(value)} (need a string id or { id, name?, email?, domain? }) — omitted`);
    return { id: undefined, profile: undefined };
  }
  const id = str(value.id);
  if (id === undefined) {
    warn(scope, "customer object has no `id` — omitted (name / email / domain need an identifier to attach to)");
    return { id: undefined, profile: undefined };
  }
  const profile: CustomerProfile = {
    name: str(value.name),
    email: str(value.email),
    domain: str(value.domain),
  };
  const hasProfile =
    profile.name !== undefined || profile.email !== undefined || profile.domain !== undefined;
  return { id, profile: hasProfile ? profile : undefined };
};
