import { Facade } from "@mahiframework/facades";
import type { Request } from "@mahiframework/http";
import type { AuthManager } from "./auth-manager.js";
import type { Guard, StatefulGuard } from "./guard.js";
import type { Credentials } from "./user-provider.js";
import type { PasswordBroker } from "./passwords/password-broker.js";
import type { EmailVerificationBroker } from "./verification/email-verification-broker.js";
import { AUTH_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `AuthManager` singleton bound at `AUTH_TOKEN`.
 * Matches Laravel's `Illuminate\Support\Facades\Auth`.
 *
 *   const user = Auth.user();          // throws for guests
 *   const maybe = Auth.userOrNull();   // null for guests
 *   if (Auth.check()) { ... }
 *
 * All of the above read the ambient AsyncLocalStorage scope, so they take
 * no `Context` and are safe to call from anywhere inside a request. For
 * queue jobs and CLI commands, which have no request, establish a scope
 * explicitly:
 *
 *   await Auth.runAs(user, async () => { ... });
 */
export class Auth extends Facade<AuthManager>(() => AUTH_TOKEN) {
  /** The authenticated user. Throws for guests, use `userOrNull()` if that's expected. */
  static user<TUser = unknown>(): TUser {
    return this.instance().user<TUser>();
  }

  static userOrNull<TUser = unknown>(): TUser | null {
    return this.instance().userOrNull<TUser>();
  }

  static check(): boolean {
    return this.instance().check();
  }

  static id(): string {
    return this.instance().id();
  }

  /** The guard that authenticated the current request, or null. */
  static currentGuard(): string | null {
    return this.instance().currentGuard();
  }

  /** Verify credentials. Returns the user or null; does NOT log anyone in. */
  static attempt<TUser = unknown>(
    credentials: Credentials,
    providerName?: string,
  ): Promise<TUser | null> {
    return this.instance().attempt<TUser>(credentials, providerName);
  }

  static guard<TUser = unknown>(name?: string): Guard<TUser> {
    return this.instance().guard<TUser>(name);
  }

  /**
   * A guard that can establish sessions, typed as such, the supported
   * replacement for `Auth.guard("session") as unknown as SessionGuard`,
   * a cast that compiles even when the guard has no `login()`.
   */
  static statefulGuard<TUser = unknown>(name?: string): StatefulGuard<TUser> {
    return this.instance().statefulGuard<TUser>(name);
  }

  /**
   * Log a user in. Queues the session cookie on `request`; the HTTP
   * boundary writes it onto whatever response the handler returns.
   */
  static login(
    request: Request,
    userId: string,
    options?: { remember?: boolean; guard?: string },
  ): Promise<string> {
    return this.instance().login(request, userId, options);
  }

  /**
   * Verify credentials AND log in, Laravel's `Auth::attempt()`. Distinct
   * from this framework's `attempt()`, which only verifies.
   */
  static attemptLogin<TUser = unknown>(
    request: Request,
    credentials: Credentials,
    options?: { remember?: boolean; guard?: string },
  ): Promise<TUser | null> {
    return this.instance().attemptLogin<TUser>(request, credentials, options);
  }

  /** End the current session. */
  static logout(request: Request, guardName?: string): Promise<void> {
    return this.instance().logout(request, guardName);
  }

  /** The password-reset broker, `sendResetLink()` / `reset()`. */
  static passwordBroker(): PasswordBroker {
    return this.instance().passwordBroker();
  }

  /** The email-verification broker, `sendVerificationLink()` / `verify()`. */
  static verificationBroker(): EmailVerificationBroker {
    return this.instance().verificationBroker();
  }

  static runAs<T>(user: unknown, fn: () => T | Promise<T>): Promise<T> {
    return this.instance().runAs(user, fn);
  }
}
