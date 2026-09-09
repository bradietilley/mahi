/**
 * The one policy for how a primary/foreign key crosses the DB↔JS type
 * boundary, so every driver and every comparison agrees.
 *
 * Engines disagree about what a big integer column comes back as: SQLite
 * returns a JS number, MySQL's `insertId` is a `bigint`, Postgres `int8`
 * arrives as text. Left alone, the same row's id would be a `number` on
 * one driver and a `string` on another, and a strict `===` between a
 * caller's key and a driver's key would silently miss.
 *
 * Policy: a key is a `number` when that is lossless (within
 * `Number.MAX_SAFE_INTEGER`) and a decimal `string` otherwise, and two
 * keys are the same row when their string spellings match — which is what
 * the database itself does for these columns.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Narrow a key the driver produced to a `number` when lossless, else a
 * decimal string. Accepts the `bigint` MySQL yields for `insertId`, the
 * text Postgres yields for `int8`, or a number already in range.
 *
 * `9007199254740993` cannot survive `Number()` — it becomes
 * `9007199254740992` — which would hand back an id that silently
 * addresses a different row; that is the case the string branch exists
 * for.
 */
export function narrowKey(value: bigint | string | number): number | string {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return value <= MAX_SAFE ? Number(value) : String(value);
  }

  const asNumber = Number(value);

  return Number.isSafeInteger(asNumber) ? asNumber : value;
}

/** Whether two keys address the same row, regardless of JS type. */
export function sameKey(a: unknown, b: unknown): boolean {
  return a === b || String(a) === String(b);
}
