/**
 * The cross-package seam for "run this after the enclosing database
 * transaction commits".
 *
 * The real implementation lives in `@mahiframework/database`'s
 * `transaction-context.ts` (`afterCommit()`/`inTransaction()`), which
 * knows about the AsyncLocalStorage transaction registry. But the
 * *producers* that want to defer work, `@mahiframework/events` (deferred event
 * dispatch), `@mahiframework/mail`, `@mahiframework/broadcasting`, sit BELOW `@mahiframework/database`
 * in the dependency graph (`database` depends on `events`), so they can't
 * import that primitive directly without creating a cycle.
 *
 * This module is the inversion: `@mahiframework/core` (which everything depends on)
 * holds a mutable resolver, `@mahiframework/database`'s service provider registers
 * the real one on boot via `setAfterCommitResolver()`, and the producers
 * call `afterCommit()` here. Before the resolver is set, a unit test that
 * never bootstrapped the database, an app with no `@mahiframework/database` at all.
 * The callback simply runs immediately, which is exactly the "no
 * transaction open" behaviour anyway.
 */

/** A callback registered to run after a transaction commits. */
export type DeferredCallback = () => void | Promise<void>;

/**
 * The shape `@mahiframework/database` supplies: `run` is its `afterCommit()` (defer
 * until commit, or run now outside a transaction), `active` is its
 * `inTransaction()` (is any transaction open right now).
 */
export interface AfterCommitResolver {
  run(callback: DeferredCallback): Promise<void>;
  active(): boolean;
}

let resolver: AfterCommitResolver | undefined;

/**
 * Install the after-commit implementation. Called once by
 * `@mahiframework/database`'s `DatabaseServiceProvider` on register/boot; a second
 * call replaces the first (harmless. The implementation is stateless, the
 * per-transaction state lives in the database package's ALS).
 */
export function setAfterCommitResolver(next: AfterCommitResolver): void {
  resolver = next;
}

/**
 * Remove the installed resolver, for tests that tear down an application
 * and want the "no database" fallback (immediate execution) restored.
 */
export function clearAfterCommitResolver(): void {
  resolver = undefined;
}

/**
 * Run `callback` once the enclosing database transaction commits, or
 * immediately (awaited) when there is no transaction open, or when no
 * database is wired up at all.
 *
 * This is the seam producers below `@mahiframework/database` use so they don't have
 * to depend on it. See the module docstring; the real deferral logic
 * (nesting, savepoint rollback discarding, registration-order draining)
 * lives in `@mahiframework/database`'s `afterCommit()`.
 */
export async function afterCommit(callback: DeferredCallback): Promise<void> {
  if (!resolver) {
    await callback();

    return;
  }

  await resolver.run(callback);
}

/**
 * Whether a database transaction is currently open on any connection.
 * `false` when no database is wired up. Producers use this to decide
 * whether a deferral will actually defer (vs. run immediately), e.g. a
 * testing recorder marking an item as "would defer".
 */
export function inTransaction(): boolean {
  return resolver?.active() ?? false;
}
