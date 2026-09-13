import { app } from "@mahiframework/core";
import { HttpError, type HttpPipe } from "@mahiframework/http";
import { AUTH_TOKEN } from "../tokens.js";
import type { AuthManager } from "../auth-manager.js";
import { hasVerifiedEmail } from "../verification/email-verification.js";

/**
 * Require the authenticated user to have a verified email, else 403.
 *
 * Per-route opt-in, the same shape as `authenticate()`, place it AFTER
 * `authenticate()` in the pipe list, since it reads the user that
 * middleware resolves into the ambient auth scope. A guest (no user)
 * 401s, matching the "authenticate differently could fix a 401,
 * different credentials won't fix a 403" split the README documents.
 *
 * There is no redirect branch (unlike Laravel's dual API/web
 * `EnsureEmailIsVerified`): this is an API-only framework, so an
 * unverified user is a flat 403, not a redirect to a "please verify"
 * page.
 *
 *   protected.get("/", handler).middleware(authenticate(), ensureEmailVerified());
 */
export function ensureEmailVerified(column?: string): HttpPipe {
  return async (request, next) => {
    const manager = app().make<AuthManager>(AUTH_TOKEN);
    const user = manager.userOrNull<Record<string, unknown>>();

    if (user === null) {
      throw HttpError.unauthorized();
    }

    if (!hasVerifiedEmail(user, column)) {
      throw HttpError.forbidden("Your email address is not verified.");
    }

    return next(request);
  };
}
