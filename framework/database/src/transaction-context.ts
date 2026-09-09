import { AsyncLocalStorage } from "node:async_hooks";
import type { Kysely } from "kysely";

/**
 * One connection's active transaction, as seen from inside a
 * `transaction()` callback.
 *
 * `level` is Laravel's "transaction level": 1 for the outermost
 * `BEGIN`, 2 for the first nested call, and so on. It names the
 * savepoint a nested call issues (`mahi_sp_2`), which is why it has to
 * be tracked rather than recomputed — a nested call needs to know how
 * deep it already is before it can pick a name that doesn't collide
 * with an enclosing one.
 */
export interface TransactionScope {
  /** The transactional Kysely instance — every query in this scope runs on it. */
  trx: Kysely<any>;
  /** 1 = outermost `BEGIN`; each nested `transaction()` adds one savepoint level. */
  level: number;
  /**
   * Deferred callbacks for the whole transaction, shared by reference
   * with every nested scope (see `DeferredCallbacks`). Present only on
   * scopes created by `transaction()`.
   */
  deferred?: DeferredCallbacks;
}

/** A callback registered to run after a transaction commits or rolls back. */
export type DeferredCallback = () => void | Promise<void>;

interface DeferredEntry {
  /** The transaction level the callback was registered at — what a savepoint rollback discards by. */
  level: number;
  callback: DeferredCallback;
}

/**
 * The after-commit/after-rollback registry for ONE physical transaction.
 *
 * Created by the outermost `transaction()` and passed by reference into
 * every nested (savepoint) scope, which is what makes Laravel's hoisting
 * rule fall out for free: a callback registered three levels deep lands
 * in the same list as one registered at the top, so it runs when the
 * *outermost* transaction commits — not when its own savepoint is
 * released, which isn't durable on its own.
 *
 * `level` is recorded per entry so a savepoint rollback can discard
 * exactly the callbacks registered at or below it (`discardFrom`) while
 * leaving the enclosing transaction's callbacks intact.
 */
export class DeferredCallbacks {
  private commit: DeferredEntry[] = [];
  private rollback: DeferredEntry[] = [];

  onCommit(level: number, callback: DeferredCallback): void {
    this.commit.push({ level, callback });
  }

  onRollback(level: number, callback: DeferredCallback): void {
    this.rollback.push({ level, callback });
  }

  /**
   * Drop every callback registered at `level` or deeper — a savepoint
   * rolled back, so the work those callbacks were paired with never
   * happened.
   */
  discardFrom(level: number): void {
    this.commit = this.commit.filter((entry) => entry.level < level);
    this.rollback = this.rollback.filter((entry) => entry.level < level);
  }

  /** Take (and clear) the after-commit callbacks, in registration order. */
  takeCommit(): DeferredCallback[] {
    const callbacks = this.commit.map((entry) => entry.callback);
    this.commit = [];

    return callbacks;
  }

  /** Take (and clear) the after-rollback callbacks, in registration order. */
  takeRollback(): DeferredCallback[] {
    const callbacks = this.rollback.map((entry) => entry.callback);
    this.rollback = [];

    return callbacks;
  }
}

/**
 * Tracks the active transaction **per connection** via
 * AsyncLocalStorage, so static `Model` access (`Todo.find(id)`,
 * `Todo.create(...)`, etc.) automatically participates in an enclosing
 * `transaction()`/`DatabaseManager.transaction()` call with zero
 * call-site changes — no `.withConnection(trx)` ceremony needed.
 *
 * ## Why the map is keyed by the ROOT Kysely instance
 *
 * The store is a `Map` from a connection's **root** (non-transactional)
 * Kysely instance to the transaction currently open on it. The root
 * instance is the only identity every participant already has in hand:
 * `Model.resolveConnection()` resolves it from the `DatabaseManager`,
 * `DB.table(name)` resolves it from the named driver, and
 * `transaction(db, ...)` is handed it directly. Keying by it means
 * nobody has to thread a connection *name* around, and it fixes the
 * bug the previous "one global slot" design had:
 *
 *   await DB.transaction(async () => {
 *     await Post.create(...);        // default connection — NOT this trx
 *   }, "analytics");
 *
 * Under a single global slot, `Post.create()` (a default-connection
 * model) picked up the analytics transaction and wrote to the wrong
 * connection. Now it looks itself up by its own root and correctly
 * finds nothing.
 *
 * The converse also works: `DB.table("events", "analytics")` inside
 * `DB.transaction(cb, "analytics")` now *does* join that transaction,
 * where before naming a connection meant opting out of the context
 * entirely.
 *
 * ## Lifetime caveat (fire-and-forget)
 *
 * ALS propagation follows the async stack, so a promise *created*
 * inside a transaction callback but not awaited by it inherits this
 * context and will still resolve `trx` after the transaction has
 * committed and released its connection. On MySQL/Postgres that means
 * running a query on a pooled connection that has moved on to someone
 * else's work. Always `await` (or explicitly detach from) work started
 * inside a `transaction()` callback — see `transaction()`'s docstring.
 */
const storage = new AsyncLocalStorage<Map<Kysely<any>, TransactionScope>>();

/**
 * Runs `callback` with `scope` registered as `connection`'s active
 * transaction. Any scope already registered for a *different*
 * connection stays visible (a transaction on the analytics connection
 * opened inside one on the default connection leaves both reachable),
 * but the map itself is copied rather than mutated so the registration
 * disappears when `callback` returns.
 */
export function runInTransactionContext<T>(
  connection: Kysely<any>,
  scope: TransactionScope,
  callback: () => Promise<T>,
): Promise<T> {
  const next = new Map(storage.getStore() ?? []);
  next.set(connection, scope);

  return storage.run(next, callback);
}

/** The active transaction scope for `connection`, or `undefined` outside of one. */
export function getActiveTransactionScope(connection: Kysely<any>): TransactionScope | undefined {
  return storage.getStore()?.get(connection);
}

/**
 * The active transaction's Kysely instance for `connection`, or
 * `undefined` outside of one. This is what `Model.resolveConnection()`
 * and `DatabaseManager`'s builder connection thunks call to decide
 * whether a query joins an enclosing transaction.
 */
export function getActiveTransaction(connection: Kysely<any>): Kysely<any> | undefined {
  return getActiveTransactionScope(connection)?.trx;
}

/**
 * Finds the scope whose `trx` **is** `db` — the "already inside this
 * transaction" check for `transaction(trx, ...)`, where a caller passes
 * the transactional instance their callback received rather than the
 * root. Kysely's `Transaction` extends `Kysely`, so that call is
 * type-correct but would otherwise try to `BEGIN` a second time on a
 * connection that is already in a transaction.
 */
export function findScopeByTransaction(
  db: Kysely<any>,
): { connection: Kysely<any>; scope: TransactionScope } | undefined {
  const store = storage.getStore();

  if (!store) {
    return undefined;
  }

  for (const [connection, scope] of store) {
    if (scope.trx === db) {
      return { connection, scope };
    }
  }

  return undefined;
}

/**
 * The innermost transaction scope currently open on ANY connection, or
 * `undefined` outside a transaction.
 *
 * "Innermost" is defined as the deepest `level` across the store. In the
 * overwhelmingly common case exactly one connection has a transaction
 * open and this is simply that one. When a transaction on a second
 * connection is opened *inside* one on the first, the deeper level is the
 * one the calling code is lexically inside, and that is the transaction a
 * producer with no connection of its own (`Bus.dispatch()`, an event, a
 * mailable) should defer against.
 *
 * Producers that DO know their connection — a model's events, the
 * database queue driver writing to its own `jobs` table — should use
 * `afterCommitOn(connection, cb)` instead, which is unambiguous.
 */
export function getInnermostTransactionScope(): TransactionScope | undefined {
  const store = storage.getStore();

  if (!store) {
    return undefined;
  }

  let deepest: TransactionScope | undefined;

  for (const scope of store.values()) {
    if (!deepest || scope.level > deepest.level) {
      deepest = scope;
    }
  }

  return deepest;
}

/** Whether a transaction is open on any connection (or on `connection` specifically). */
export function inTransaction(connection?: Kysely<any>): boolean {
  if (connection) {
    return getActiveTransactionScope(connection) !== undefined;
  }

  return getInnermostTransactionScope() !== undefined;
}

/**
 * Run `callback` once the enclosing transaction **commits**, or
 * immediately (awaited) when there is no transaction open.
 *
 * This is the primitive behind every "after commit" feature — deferred
 * job dispatch (`Bus.dispatch(job, { afterCommit: true })`), deferred
 * events, deferred mail. It exists because the canonical pattern
 *
 *   await DB.transaction(async () => {
 *     const order = await Order.create({ ... });
 *     await Bus.dispatch(new ChargeOrderJob(order));
 *   });
 *
 * is a race without it: on MySQL/Postgres the job row commits on its own
 * connection immediately, a worker pops it before the outer transaction
 * commits, and `Order.find(id)` in the worker finds nothing. Deferring
 * the push until after the commit removes the race entirely — and if the
 * transaction rolls back, the job is never pushed at all.
 *
 * Callbacks registered inside a nested (savepoint) `transaction()` are
 * hoisted to the outermost one: they run when the whole transaction
 * commits, because a released savepoint is not durable on its own. A
 * savepoint that *rolls back* discards the callbacks registered inside
 * it.
 *
 * Ordering is registration order, and a throwing callback is logged by
 * `transaction()` and does not stop the ones after it — the data is
 * already committed, so there is nothing left to abort.
 *
 * With no transaction open the callback runs immediately and this
 * function awaits it, so `await afterCommit(cb)` has the same "the work
 * has happened" meaning in both cases.
 */
export async function afterCommit(callback: DeferredCallback): Promise<void> {
  const scope = getInnermostTransactionScope();

  if (!scope?.deferred) {
    await callback();

    return;
  }

  scope.deferred.onCommit(scope.level, callback);
}

/**
 * `afterCommit()` scoped to one specific connection — for producers that
 * know which connection their work is on (a model, the database queue
 * driver). A transaction open on some *other* connection is correctly
 * ignored: it has nothing to do with this write.
 */
export async function afterCommitOn(
  connection: Kysely<any>,
  callback: DeferredCallback,
): Promise<void> {
  const scope = getActiveTransactionScope(connection);

  if (!scope?.deferred) {
    await callback();

    return;
  }

  scope.deferred.onCommit(scope.level, callback);
}

/**
 * Run `callback` if the enclosing transaction **rolls back** — a no-op
 * (never called) when there is no transaction, since nothing can roll
 * back. The mirror of `afterCommit()`: use it to undo an external side
 * effect the transaction can't take back itself.
 */
export function afterRollback(callback: DeferredCallback): void {
  const scope = getInnermostTransactionScope();
  scope?.deferred?.onRollback(scope.level, callback);
}

/** `afterRollback()` scoped to one connection — see `afterCommitOn()`. */
export function afterRollbackOn(connection: Kysely<any>, callback: DeferredCallback): void {
  const scope = getActiveTransactionScope(connection);
  scope?.deferred?.onRollback(scope.level, callback);
}
