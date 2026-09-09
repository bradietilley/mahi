import type {
  DatabaseConnection,
  Dialect as KyselyDialect,
  Driver,
  QueryResult,
  CompiledQuery,
} from "kysely";
import type { Dialect } from "../schema/dialect.js";
import { translateDatabaseError } from "../exceptions.js";
import { registerDialect } from "./dialect-registry.js";
import { normalizeBinding } from "../bindings.js";

/**
 * Wrap a Kysely dialect so that every query and DDL statement executed
 * through it has its raw driver errors translated into this framework's
 * standardised `QueryException` hierarchy (see `exceptions.ts`).
 *
 * This is the one true chokepoint: every builder `.execute()`, every
 * `sql\`...\`.execute()`, every schema statement and every transaction
 * funnels through a `DatabaseConnection.executeQuery`, so decorating that
 * catches them all — regardless of whether the caller used `Model`,
 * `QueryBuilder`, `DB`, `Schema`, or a raw Kysely instance. The wrapper is
 * transparent: it only rethrows, so success paths and result shapes are
 * untouched.
 *
 * Being that chokepoint also makes this the right place to record which
 * engine the connection talks to (`registerDialect()`), so the query
 * layer can recover the dialect from a bare `Kysely` instance — see
 * `dialect-registry.ts` for why that's needed and why the adapter is the
 * key.
 */
export function errorTranslatingDialect(inner: KyselyDialect, dialect: Dialect): KyselyDialect {
  return {
    createAdapter: () => {
      const adapter = inner.createAdapter();
      registerDialect(adapter, dialect);

      return adapter;
    },
    createQueryCompiler: () => inner.createQueryCompiler(),
    createIntrospector: (db) => inner.createIntrospector(db),
    createDriver: () => wrapDriver(inner.createDriver(), dialect),
  };
}

function wrapDriver(driver: Driver, dialect: Dialect): Driver {
  return new Proxy(driver, {
    get(target, prop, receiver) {
      if (prop === "acquireConnection") {
        return async (...args: unknown[]) => {
          const connection = await (target.acquireConnection as any)(...args);

          return wrapConnection(connection, dialect);
        };
      }

      const value = Reflect.get(target, prop, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Rewrites a compiled query's parameters into shapes the underlying
 * driver can actually bind. Returns the query untouched (same object,
 * no allocation) when nothing needs rewriting, which is the common case.
 *
 * Two rules apply here.
 *
 * **Booleans, SQLite only.** better-sqlite3 refuses a JS `boolean`
 * outright ("can only bind numbers, strings, bigints, buffers, and
 * null"), because SQLite has no boolean type. Every layer above happily
 * produces one — a `BooleanCast` column, `where("published", true)`
 * straight from a route's query string, a `Blueprint` default — so
 * coercing here, at the one place every statement passes through, is
 * the only fix that covers all of them at once. `true`/`false` become
 * SQLite's own `1`/`0`, which is what the column already stores. MySQL
 * and Postgres bind booleans natively (Postgres has a real `boolean`
 * type; mysql2 maps them to `1`/`0` itself), so they are left alone.
 *
 * **Object bindings, every dialect** — `normalizeBinding()`, which
 * turns a `DateTime`/`Date` into UTC text, a `bigint` into a key, and a
 * model instance into its own key.
 *
 * `QueryBuilder` already normalises at compile time, so for anything
 * built through the query builder this second pass is a no-op that
 * re-checks values already reduced to scalars. It exists for the paths
 * that never touch the builder and would otherwise have no answer at
 * all: a raw ``sql`...` `` template, a migration, and the pivot writes
 * in `relationship-writes.ts` that go straight to Kysely. Being the one
 * true chokepoint is the whole point of this file — a binding rule
 * enforced anywhere else is a rule something can route around.
 */
function normalizeParameters(dialect: Dialect, query: CompiledQuery): CompiledQuery {
  const parameters = query.parameters;
  let changed = false;

  const normalized = parameters.map((value) => {
    if (typeof value === "boolean") {
      if (dialect !== "sqlite") {
        return value;
      }

      changed = true;

      return value ? 1 : 0;
    }

    const bound = normalizeBinding(dialect, value);

    if (bound !== value) {
      changed = true;
    }

    return bound;
  });

  return changed ? { ...query, parameters: normalized } : query;
}

function wrapConnection(connection: DatabaseConnection, dialect: Dialect): DatabaseConnection {
  return new Proxy(connection, {
    get(target, prop, receiver) {
      if (prop === "executeQuery") {
        return async <R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> => {
          const query = normalizeParameters(dialect, compiledQuery);
          try {
            return await target.executeQuery<R>(query);
          } catch (error) {
            throw translateDatabaseError(dialect, error, {
              sql: query.sql,
              bindings: query.parameters,
            });
          }
        };
      }

      if (prop === "streamQuery") {
        return async function* <R>(
          compiledQuery: CompiledQuery,
          chunkSize: number,
        ): AsyncIterableIterator<QueryResult<R>> {
          const query = normalizeParameters(dialect, compiledQuery);
          try {
            yield* target.streamQuery<R>(query, chunkSize);
          } catch (error) {
            throw translateDatabaseError(dialect, error, {
              sql: query.sql,
              bindings: query.parameters,
            });
          }
        };
      }

      const value = Reflect.get(target, prop, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
