import { sql, type Kysely, type Transaction } from "kysely";
import { app } from "@mahiframework/core";
import {
  DeferredCallbacks,
  findScopeByTransaction,
  getActiveTransactionScope,
  runInTransactionContext,
  type DeferredCallback,
  type TransactionScope,
} from "./transaction-context.js";

/**
 * The savepoint name for a given transaction level. Prefixed so it can't
 * collide with a savepoint an application issued by hand, and suffixed
 * with the level so nesting three deep produces three distinct names
 * (`RELEASE SAVEPOINT` on a duplicate name only releases the innermost,
 * silently leaving the outer one open).
 *
 * Plain identifier characters only — this is interpolated into DDL-ish
 * SQL because no dialect accepts a bound parameter as a savepoint name,
 * and `level` is a framework-generated integer, never user input.
 */
function savepointName(level: number): string {
  return `mahi_sp_${level}`;
}

/**
 * Runs `callback` inside a `SAVEPOINT` on an already-open transaction —
 * the nested-`transaction()` path. Commits by `RELEASE`ing the savepoint
 * and rolls back to it (NOT the whole transaction) on error, so an inner
 * failure the caller catches leaves the outer transaction usable, which
 * is the entire point of nesting.
 *
 * SQLite, MySQL and Postgres all implement `SAVEPOINT` / `RELEASE
 * SAVEPOINT` / `ROLLBACK TO SAVEPOINT` with this exact syntax, so no
 * dialect branch is needed. Kysely 0.29 has no savepoint API of its own,
 * hence the raw `sql` fragments.
 */
async function withSavepoint<T>(
  connection: Kysely<any>,
  scope: TransactionScope,
  callback: (trx: Transaction<any>) => Promise<T>,
): Promise<T> {
  const level = scope.level + 1;
  const name = savepointName(level);
  const trx = scope.trx as Transaction<any>;
  // Shared by reference with the outermost scope, so an `afterCommit()`
  // registered in here runs when the whole transaction commits — not
  // when this savepoint is released, which isn't durable on its own.
  const deferred = scope.deferred;

  await sql.raw(`savepoint ${name}`).execute(trx);

  try {
    const result = await runInTransactionContext(
      connection,
      { trx, level, ...(deferred ? { deferred } : {}) },
      () => callback(trx),
    );
    await sql.raw(`release savepoint ${name}`).execute(trx);

    return result;
  } catch (error) {
    // Best-effort: if the connection itself died, the rollback fails
    // too, and reporting THAT error instead of the original would bury
    // the actual cause. The outer transaction is aborted either way.
    try {
      await sql.raw(`rollback to savepoint ${name}`).execute(trx);
    } catch {
      // ignored — surface the original error below
    }
    // The work this savepoint did is gone, so anything registered to run
    // "after commit" from inside it must go with it. Callbacks from the
    // enclosing levels are untouched — that transaction is still alive.
    deferred?.discardFrom(level);
    throw error;
  }
}

/**
 * Run every deferred callback in registration order, isolating failures.
 *
 * A throwing after-commit callback must not take down the ones after it
 * and must not surface as a transaction error: by the time these run the
 * commit has already happened and cannot be undone, so the only sane
 * behaviour (and Laravel's) is to report and continue.
 */
async function drain(callbacks: DeferredCallback[], phase: string): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      report(`database: a ${phase} callback threw.`, error);
    }
  }
}

/**
 * Log through the running application when there is one, else `console`.
 *
 * `transaction()` is a free function with no `Application` in hand, and
 * the global `app()` throws when nothing is bootstrapped (a unit test
 * driving Kysely directly) — which would turn "a callback threw" into
 * "the framework threw", exactly the swallowing this function exists to
 * avoid.
 */
function report(message: string, error: unknown): void {
  try {
    app().logger.error(message, { error });
  } catch {
    console.error(message, error);
  }
}

/**
 * Wraps Kysely's own `db.transaction().execute(callback)` — the
 * documented, discoverable, framework-blessed way to run a transaction,
 * rather than every consumer needing to know Kysely's transaction API
 * exists and reach past the framework for it.
 *
 * The callback runs inside an AsyncLocalStorage context carrying the
 * transactional Kysely instance (see `transaction-context.ts`), so
 * **static `Model` access automatically participates** — no explicit
 * wiring needed at call sites:
 *
 *   await transaction(db, async () => {
 *     await Todo.create({ id, title, done: 0, created_at: now });
 *     await TodoTag.create({ todo_id: id, tag: "urgent" });
 *     // if this throws, BOTH inserts roll back
 *   });
 *
 * The callback also receives the raw transactional Kysely instance as an
 * argument, for anything reaching past `Model` (raw Kysely queries, a
 * driver that doesn't have a `Model` wired up yet, etc).
 *
 * Rolls back automatically if the callback throws (Kysely's own
 * behavior), and the thrown error propagates to the caller unchanged.
 *
 * ## Nesting
 *
 * Calling `transaction()` again while one is already open **on the same
 * connection** does NOT open a second one. The inner call runs in a
 * `SAVEPOINT` on the existing transaction (Laravel's "transaction
 * level" semantics), which is what makes the ordinary service-layer
 * pattern safe:
 *
 *   // OrderService.place() wraps itself...
 *   await DB.transaction(async () => { ... });
 *   // ...and is also called from a controller that wraps a batch:
 *   await DB.transaction(async () => {
 *     for (const order of orders) await orderService.place(order);
 *   });
 *
 * Without savepoints that inner call either deadlocks (SQLite, whose
 * single connection is already held by the outer transaction) or takes
 * a second pooled connection and commits **independently** of the outer
 * one (MySQL/Postgres) — so an outer rollback would leave the inner
 * writes behind, and deep nesting under load exhausts the pool.
 *
 * Semantics that follow from the savepoint model, and match Laravel:
 *
 * - An inner rollback (the inner callback throws, the *caller* catches)
 *   undoes only the inner work; the outer transaction continues.
 * - An outer rollback undoes everything, including already-"committed"
 *   inner work. A nested `transaction()` resolving is NOT durable on
 *   its own — only the outermost commit is.
 *
 * Nesting is per-connection: a `transaction()` on a *different*
 * connection opens a real, independent transaction (it has to — the two
 * connections can't share a savepoint), and both stay reachable to the
 * models bound to them.
 *
 * ## After-commit callbacks
 *
 * Work that must not happen unless the transaction actually commits —
 * dispatching a job that reads the rows being written, sending mail,
 * notifying an external system — registers itself with `afterCommit()`
 * (see `transaction-context.ts`) and is drained here, once, after the
 * outermost commit resolves:
 *
 *   await DB.transaction(async () => {
 *     const order = await Order.create({ ... });
 *     await Bus.dispatch(new ChargeOrderJob(order), { afterCommit: true });
 *   });
 *
 * Without that flag the job row commits on its own connection
 * immediately (MySQL/Postgres) and a worker can pop it before the order
 * exists. With it, the push happens after the commit, and never at all
 * if the transaction rolls back — in which case `afterRollback()`
 * callbacks run instead.
 *
 * Callbacks run in registration order and each is isolated: one that
 * throws is logged and the rest still run, because the commit has
 * already happened and cannot be undone.
 *
 * ## Footguns worth knowing
 *
 * A promise **created but not awaited** inside the callback
 * inherits the transaction context and can run its query after the
 * transaction has committed and returned its connection to the pool —
 * on MySQL/Postgres that query then executes on a connection now doing
 * someone else's work. Await everything you start inside the callback.
 */
export async function transaction<DB, T>(
  db: Kysely<DB>,
  callback: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  // Already inside a transaction on this connection: nest via savepoint
  // rather than opening a second one.
  const active = getActiveTransactionScope(db);

  if (active) {
    return withSavepoint(db, active, callback as (trx: Transaction<any>) => Promise<T>);
  }

  // The caller passed the *transactional* instance itself (e.g. the
  // `trx` their own callback received). Kysely's `Transaction` extends
  // `Kysely`, so this type-checks; treat it as the same nesting case,
  // keyed by the root connection the scope was registered under.
  const byTrx = findScopeByTransaction(db);

  if (byTrx) {
    return withSavepoint(
      byTrx.connection,
      byTrx.scope,
      callback as (trx: Transaction<any>) => Promise<T>,
    );
  }

  // The outermost transaction — the only one that actually commits, and
  // therefore the only one that drains deferred callbacks.
  const deferred = new DeferredCallbacks();

  let result: T;
  try {
    result = await db
      .transaction()
      .execute((trx) =>
        runInTransactionContext(db, { trx, level: 1, deferred }, () => callback(trx)),
      );
  } catch (error) {
    // Rolled back (by a throwing callback, or by the driver). Whatever
    // was queued for "after commit" must be discarded — `takeRollback`
    // and `takeCommit` both clear, so nothing can run later by accident.
    const rollbackCallbacks = deferred.takeRollback();
    deferred.takeCommit();
    await drain(rollbackCallbacks, "after-rollback");
    throw error;
  }

  // Committed. Drain outside the transaction context (which
  // `runInTransactionContext` has already unwound), so a callback that
  // opens its own transaction gets a real one rather than a savepoint on
  // a connection that has gone back to the pool.
  await drain(deferred.takeCommit(), "after-commit");

  return result;
}
