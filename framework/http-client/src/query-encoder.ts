/**
 * Bracket-notation encoder for query strings, urlencoded form bodies, and
 * multipart fields — the producer side of `@mahiframework/http`'s query parser, and
 * the behaviour PHP's `http_build_query()` (and `qs.stringify`) give you.
 *
 * A plain `String(value)` over every field turns a nested value like
 * `{ a: { b: 1 } }` into the literal `a=[object Object]` — never what the
 * caller meant, and it corrupts the request silently rather than failing.
 *
 * The emitted syntax:
 *
 *   { a: { b: 1 } }          → a[b]=1
 *   { a: [1, 2] }            → a=1&a=2        (repeated key)
 *   { a: { b: [1, 2] } }     → a[b]=1&a[b]=2
 *   { a: 1, b: "x" }         → a=1&b=x
 *
 * Scalar arrays stay repeated keys rather than becoming indexed
 * (`a[0]=…`): that is the shape every server and the paired parser read.
 * Object nesting must be walked explicitly — naive stringification turns
 * `{ a: { b: 1 } }` into the literal `a=[object Object]`.
 *
 * (These packages share a wire format, not code: `@mahiframework/http-client` sits
 * below `@mahiframework/http` in the dependency graph and cannot import from it.)
 */

/** A single flattened `[key, value]` pair, ready for `URLSearchParams`/`FormData`. */
export type EncodedField = [string, string];

/**
 * Flattens a payload object into bracket-notation `[key, value]` pairs.
 *
 * `null`/`undefined` values are skipped rather than serialized as the
 * strings `"null"`/`"undefined"` — matching the query and form code this
 * replaces, and matching Laravel, which drops empty values from a query.
 * Every leaf is coerced with `String()`, so shape (nesting) is decided
 * here while type (string form) stays the caller's, exactly as the inbound
 * parser leaves type to the validator.
 */
export function encodeNested(data: Record<string, unknown>): EncodedField[] {
  const fields: EncodedField[] = [];

  for (const [key, value] of Object.entries(data)) {
    appendField(fields, key, value);
  }

  return fields;
}

function appendField(fields: EncodedField[], key: string, value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    // Repeated key, not `key[index]` — an array item may itself be an
    // object (`{ a: [{ b: 1 }] }` → `a[b]=1`), which recurses under the
    // same key.
    for (const item of value) {
      appendField(fields, key, item);
    }

    return;
  }

  if (isPlainObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      appendField(fields, `${key}[${childKey}]`, childValue);
    }

    return;
  }

  fields.push([key, String(value)]);
}

/**
 * Whether a value should recurse as a nested container rather than be
 * coerced to a string leaf. A `Date`, `Uint8Array`, `Blob`, and the like
 * have meaningful string/serialized forms and must not be walked as if
 * their enumerable properties were form fields.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}
