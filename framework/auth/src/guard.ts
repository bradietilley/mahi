import type { Request } from "@mahi/http";

/**
 * Strategy for turning an inbound request into an authenticated user.
 *
 * STATELESS BY CONTRACT: a Guard is a long-lived singleton shared across
 * every concurrent request (one `Application`, resolved once by
 * `AuthManager`), so it must never memoize per-request state on itself.
 * Everything it needs comes from the `Request` argument, and the resolved
 * user is stored in the AsyncLocalStorage scope — see `auth-context.ts`.
 *
 * Deliberately one method. Laravel's Guard also carries check()/guest()/
 * id(), but those are pure derivations of user() — implementing them
 * per-guard is duplicated boilerplate. They live on `AuthManager` and the
 * `Auth` facade instead.
 */
export interface Guard<TUser = unknown> {
  /** Resolve the user for this request, or null if unauthenticated. */
  user(request: Request): Promise<TUser | null>;
}

/**
 * A guard that can also *establish* and *end* a session, not just read
 * one — the cookie-session shape (Laravel's `StatefulGuard`).
 *
 * Split out rather than folded into `Guard` because the token guard
 * genuinely cannot implement it: a bearer token is minted out-of-band and
 * presented by a client that stores it itself, so there is no "log this
 * request in" step for the server to perform. Widening `Guard` would
 * force a throwing stub onto it.
 *
 * The point of the interface is that callers stop reaching for
 * `as unknown as SessionGuard` to get at `login()` — a cast that would
 * silently survive the guard being swapped for one that has no such
 * method. `AuthManager.statefulGuard()` returns this type and checks.
 */
export interface StatefulGuard<TUser = unknown> extends Guard<TUser> {
  /** Establish a session for `userId` and queue the cookie. */
  login(request: Request, userId: string, options?: { remember?: boolean }): Promise<string>;

  /** Destroy the current session and queue the cookie's deletion. */
  logout(request: Request): Promise<void>;

  /** Invalidate every session belonging to a user. */
  logoutEverywhere(userId: string): Promise<void>;
}

/** Whether `guard` implements the stateful (session-establishing) half. */
export function isStatefulGuard<TUser = unknown>(
  guard: Guard<TUser>,
): guard is StatefulGuard<TUser> {
  const candidate = guard as Partial<StatefulGuard<TUser>>;

  return typeof candidate.login === "function" && typeof candidate.logout === "function";
}
