/**
 * A rich authorization outcome, the equivalent of Laravel's
 * `Auth\Access\Response`. A policy method can return one of these instead
 * of a bare boolean to declare its OWN denial shape: a custom message,
 * and a custom HTTP status (notably 404 instead of 403).
 *
 * Why this exists here specifically: the README's "401 vs 403, and 404"
 * section documents the exact pattern `denyAsNotFound()` solves,
 * surfacing "someone else's private row" as a 404 so an endpoint can't be
 * used to probe which ids exist. Without this, that decision has to be
 * hand-rolled per-controller, OUTSIDE the gate, because a policy method
 * returning `boolean` has no way to say "deny this as a 404".
 *
 * A returned response is normalized to pass/fail everywhere a boolean is
 * (see `GateRegistry.resolve()`); only `authorize()` reads the `status`
 * and `message` to shape the thrown `HttpError`.
 */
export class AuthorizationResponse {
  private constructor(
    readonly allowed: boolean,
    readonly message?: string,
    /** HTTP status to throw on denial. Undefined means "let authorize() pick 403". */
    readonly status?: number,
  ) {}

  /** An allowed outcome, optionally carrying a message. */
  static allow(message?: string): AuthorizationResponse {
    return new AuthorizationResponse(true, message);
  }

  /** A denied outcome with an optional message and status (defaults to 403 at throw time). */
  static deny(message?: string, status?: number): AuthorizationResponse {
    return new AuthorizationResponse(false, message, status);
  }

  /**
   * A denial that surfaces as 404, for "this row exists but isn't yours,
   * and admitting it exists would leak information."
   */
  static denyAsNotFound(message = "Not Found"): AuthorizationResponse {
    return new AuthorizationResponse(false, message, 404);
  }

  denied(): boolean {
    return !this.allowed;
  }
}

export function isAuthorizationResponse(value: unknown): value is AuthorizationResponse {
  return value instanceof AuthorizationResponse;
}
