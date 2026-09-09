/**
 * Primary-key generation strategies — the `keyType` config replacing the
 * old `incrementing` boolean + `newUniqueId()` override pair.
 *
 * Three built-ins are named by string:
 *
 * - `"increment"` — the DB generates the key (auto-increment / identity).
 *   The insert path reads it back (`RETURNING` on PG/SQLite, `insertId`
 *   on MySQL). Requires the primary-key column to be a `number`.
 * - `"uuid"` — a client-generated `randomUUID()` string, assigned before
 *   insert. Requires a `string` primary-key column.
 * - a `KeyStrategy` object — anything else, e.g. `@mahi/snowflake`'s
 *   `snowflake()`.
 *
 * A `KeyStrategy` runs after the `saving` hook (so that hook can still
 * supply an explicit key) and before `creating` (so both `creating` and
 * the insert see the value).
 */

import { randomUUID } from "node:crypto";

/**
 * Context handed to a `KeyStrategy.generate()` call — the model class
 * name, which `@mahi/snowflake` uses as its per-model sequence group.
 */
export interface KeyStrategyContext {
  modelName: string;
}

/**
 * A client-side primary-key generator. `type` declares whether the key is
 * a string or a number (used to validate against the column type);
 * `generate` produces the value, sync or async.
 */
export interface KeyStrategy<T extends string | number = string | number> {
  type: T extends string ? "string" : "number";
  generate(context: KeyStrategyContext): T | Promise<T>;
}

/** How a resolved `keyType` behaves at runtime. */
export interface ResolvedKeyType {
  /** `true` when the DB generates the key (read it back after insert). */
  incrementing: boolean;
  /** Generates a client-side key when `incrementing` is false, or `undefined` for none. */
  generate?: KeyStrategy["generate"];
}

/** The built-in `"uuid"` strategy. */
export function uuidKeyStrategy(): KeyStrategy<string> {
  return {
    type: "string",
    generate() {
      return randomUUID();
    },
  };
}

/**
 * Normalises a `keyType` config value into its runtime behaviour.
 * `"increment"` (the default) → DB-generated; `"uuid"` → client UUID;
 * a `KeyStrategy` object → its own `generate`.
 */
export function resolveKeyType(
  keyType: "increment" | "uuid" | KeyStrategy | undefined,
): ResolvedKeyType {
  if (keyType === undefined || keyType === "increment") {
    return { incrementing: true };
  }

  if (keyType === "uuid") {
    return { incrementing: false, generate: uuidKeyStrategy().generate };
  }

  return { incrementing: false, generate: keyType.generate };
}
