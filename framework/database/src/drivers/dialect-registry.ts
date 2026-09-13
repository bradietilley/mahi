import type { Kysely } from "kysely";
import type { Dialect } from "../schema/dialect.js";

/**
 * Which engine a given `Kysely` instance talks to.
 *
 * The query layer needs this constantly. `FOR UPDATE` is a syntax error
 * on SQLite, `strftime()` doesn't exist on MySQL, `"quoted"` identifiers
 * are string literals there, and `RETURNING` is the only way to read a
 * generated key on Postgres. But a `QueryBuilder` is handed a
 * `() => Kysely` thunk, not a `DatabaseDriver`, and that is deliberate
 * (see `QueryBuilder`'s docstring: the connection is resolved fresh at
 * every terminal so a builder created outside a transaction still
 * executes inside one). So the dialect has to be recoverable from the
 * `Kysely` instance alone.
 *
 * Kysely does not expose the dialect it was constructed with, so it is
 * recorded here instead, keyed by the **adapter** object each dialect
 * creates. That key is what makes this survive the case that matters:
 * `db.transaction()` produces a *new* `Transaction` object, so keying by
 * the `Kysely` instance itself would lose the dialect the moment any
 * query ran inside a transaction, and every model write does. The
 * adapter, by contrast, is created once per dialect and shared by the
 * root instance and every `Transaction`/`withoutPlugins()` derivative
 * (verified against Kysely 0.29), so a lookup through it resolves in
 * all of them.
 *
 * A `WeakMap` rather than a `Map` so a discarded connection's entry is
 * collectable, tests build hundreds of throwaway in-memory SQLite
 * connections.
 *
 * Registration happens in `errorTranslatingDialect()`, which every
 * driver already wraps its Kysely dialect in, making it the one
 * chokepoint every connection this framework builds passes through.
 */
const dialects = new WeakMap<object, Dialect>();

/** Records `dialect` as the engine behind every Kysely instance using `adapter`. Called from `errorTranslatingDialect()`. */
export function registerDialect(adapter: object, dialect: Dialect): void {
  dialects.set(adapter, dialect);
}

/**
 * The engine behind `db`, including when `db` is a `Transaction` rather
 * than the root connection.
 *
 * Falls back to `"sqlite"` for a `Kysely` this framework didn't build
 * (a hand-constructed instance in a test, or one from a plugin driver
 * that bypassed `errorTranslatingDialect`). SQLite is the right default
 * for that: it is the framework's own default connection, and the
 * SQLite branch of every grammar is the conservative one (no row locks,
 * no `RETURNING` dependency), so an unrecognised connection degrades to
 * today's behaviour rather than emitting SQL its engine may reject.
 */
export function dialectOf(db: Kysely<any>): Dialect {
  return dialects.get(db.getExecutor().adapter) ?? "sqlite";
}
