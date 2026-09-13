import { app } from "@mahiframework/core";
import { HttpError, type HttpPipe } from "@mahiframework/http";
import { AUTH_TOKEN } from "../tokens.js";
import type { AuthManager } from "../auth-manager.js";

/**
 * Require an authenticated user, else 401.
 *
 * Per-route pipe, not a global provider pipe. Auth is opt-in per route.
 * It populates the ambient auth scope that `AuthServiceProvider`'s global
 * pipe opens for every request.
 *
 *   todos.get("/", listTodos).middleware(authenticate());
 *   admin.get("/", dashboard).middleware(authenticate("session"));
 */
export function authenticate(guardName?: string): HttpPipe {
  return async (request, next) => {
    const manager = app().make<AuthManager>(AUTH_TOKEN);

    const user = await manager.resolve(request, guardName);

    if (user === null) {
      throw HttpError.unauthorized();
    }

    return next(request);
  };
}

/**
 * Resolve the user if credentials are present, but never reject, for
 * routes that serve guests and authenticated users differently.
 *
 * Pair with `Auth.userOrNull()`; `Auth.user()` still throws for guests,
 * by design.
 */
export function authenticateOptional(guardName?: string): HttpPipe {
  return async (request, next) => {
    const manager = app().make<AuthManager>(AUTH_TOKEN);
    await manager.resolve(request, guardName);

    return next(request);
  };
}
