/**
 * The per-request "who is logged in" scope, backed by AsyncLocalStorage —
 * the same mechanism `@mahiframework/database`'s `transaction-context.ts`
 * uses to make static `Model` calls join an enclosing transaction.
 *
 * WHY THIS EXISTS AT ALL: Laravel's `Guard` is request-scoped and
 * stateful — `Auth::user()` works because PHP rebuilds the container per
 * request. This framework boots ONE long-lived `Application` and serves
 * every request from it (`bin/server.ts` → `serve({ fetch: kernel.raw().fetch })`),
 * so a singleton holding "the current user" would leak one request's user
 * into another. That is a critical security bug, not a stylistic
 * difference. AsyncLocalStorage gives per-request isolation without
 * per-request container rebuilds, and propagates across `await`
 * boundaries.
 *
 * THREE DISTINCT FAILURE MODES, deliberately not collapsed into one:
 *
 *   | Situation                          | user()                   | userOrNull()             |
 *   |------------------------------------|--------------------------|--------------------------|
 *   | No scope (queue job, CLI, forgot   | MissingAuthContextError  | MissingAuthContextError  |
 *   |   the middleware)                  |                          |                          |
 *   | In scope, nobody authenticated     | UnauthenticatedError     | null                     |
 *   | In scope, authenticated            | the user                 | the user                 |
 *
 * `userOrNull()` throwing on a MISSING SCOPE is the important one, and the
 * easiest thing to "helpfully" soften into returning null. Don't: a route
 * that forgot `authenticate()` must fail loudly rather than silently
 * behaving as an anonymous request, because "silently anonymous" is
 * exactly how authorization checks get bypassed. Only "we're in a request
 * and nobody is logged in" is a legitimate null.
 *
 * The scope is opened for EVERY request by `AuthServiceProvider`'s global
 * pipe, so public routes can call `userOrNull()` freely and
 * `MissingAuthContextError` stays reserved for genuinely non-HTTP callers
 * (which should use `Auth.runAs()`).
 *
 * ONE ASYMMETRY WORTH KNOWING, because it makes a job look like it works
 * and then fail in production. AsyncLocalStorage propagates into
 * synchronous callees, so a job dispatched on the `sync` queue driver
 * INHERITS the dispatching request's auth scope and `Auth.user()` inside
 * it just works. The same job on the `database` or `redis` driver runs
 * later, in a worker process with no scope at all, and throws
 * `MissingAuthContextError`.
 *
 * That is not a leak between requests — the scope belongs to the caller
 * that is still awaiting the work — but it does mean a job tested against
 * `sync` can break the first time it runs for real. Jobs that need an
 * identity should carry the user id in their payload and re-establish the
 * scope themselves with `Auth.runAs()`, rather than reading an ambient
 * one they only sometimes have.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthState {
  /**
   * Mutable: `authenticate()` writes into the state object opened by the
   * global pipe rather than nesting a second scope, so a single request
   * has exactly one identity for its whole lifetime.
   */
  user: unknown | null;
  guard: string | null;
}

const storage = new AsyncLocalStorage<AuthState>();

/**
 * A process-wide "act as this user" override for tests and impersonation
 * (Laravel's `Auth::actingAs()`). When set, every auth scope opened by the
 * request pipe is seeded with this user, and `AuthManager.resolve()` short-
 * circuits to it instead of consulting a guard.
 *
 * This lives beside the AsyncLocalStorage rather than inside a resolved
 * guard on the singleton `AuthManager`: seeding the per-request scope keeps
 * each request's identity isolated in its own `AuthState`, whereas swapping
 * a fake guard into the shared resolved-guard cache leaked the acting user
 * into concurrent real requests and corrupted guard resolution for every
 * other caller. It is `null` in a normally-running server; only test setup
 * (`TestClient.actingAs()`) or an explicit impersonation flow sets it.
 */
let actingAsOverride: { user: unknown; guard: string | null } | null = null;

/** Set (or clear, with `null`) the process-wide acting-as override. */
export function setActingAs(user: unknown | null, guard: string | null = null): void {
  actingAsOverride = user === null ? null : { user, guard };
}

/** The current acting-as override, or `null` when none is set. */
export function actingAs(): { user: unknown; guard: string | null } | null {
  return actingAsOverride;
}

export class MissingAuthContextError extends Error {
  constructor() {
    super(
      "No auth context is active. Inside an HTTP request this means " +
        "AuthServiceProvider is not registered in config/app.ts's providers[]. " +
        "Outside one (queue job, CLI command, test), wrap the call in " +
        "Auth.runAs(user, () => ...) to establish a scope explicitly.",
    );
    this.name = "MissingAuthContextError";
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("No authenticated user. Use Auth.userOrNull() if this route permits guests.");
    this.name = "UnauthenticatedError";
  }
}

/** Establish an auth scope for the duration of `fn`. */
export function runWithAuth<T>(state: AuthState, fn: () => T): T {
  return storage.run(state, fn);
}

/**
 * The mutable state for the current scope, or undefined outside one.
 * Prefer `user()`/`userOrNull()`; this is for `authenticate()` and
 * `AuthManager`, which need to write to it.
 */
export function currentAuthState(): AuthState | undefined {
  return storage.getStore();
}

/** The state for the current scope, throwing if there isn't one. */
export function requireAuthState(): AuthState {
  const state = storage.getStore();

  if (state === undefined) {
    throw new MissingAuthContextError();
  }

  return state;
}

/**
 * The authenticated user. Throws `UnauthenticatedError` if nobody is
 * logged in, `MissingAuthContextError` if there's no scope at all.
 */
export function user<TUser>(): TUser {
  const state = requireAuthState();

  if (state.user === null) {
    throw new UnauthenticatedError();
  }

  return state.user as TUser;
}

/**
 * The authenticated user, or null if this request is anonymous. Still
 * throws `MissingAuthContextError` outside a scope — see the module
 * docblock for why that distinction is load-bearing.
 */
export function userOrNull<TUser>(): TUser | null {
  return requireAuthState().user as TUser | null;
}

/** Whether anyone is authenticated in the current scope. */
export function check(): boolean {
  return requireAuthState().user !== null;
}

/** The guard that resolved the current user, or null if anonymous. */
export function currentGuard(): string | null {
  return requireAuthState().guard;
}
