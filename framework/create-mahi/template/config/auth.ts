import type { AuthConfig } from "@mahiframework/auth";
import { User } from "../src/models/user.model.js";
import type { Env } from "./env.js";

/**
 * Two guards ship; this app defaults to `token`.
 *
 * WHICH GUARD TO USE, since this is the decision the config makes for
 * you and it's topology-dependent rather than a preference:
 *
 * - `token` — bearer tokens in an `Authorization` header. Correct for a
 *   detached frontend (a SPA on another origin) and for any third-party
 *   API consumer. Needs no CSRF protection, because browsers never
 *   attach an `Authorization` header automatically.
 *
 * - `session` — signed cookie plus a server-side session. Correct when
 *   the frontend is served from the SAME origin as the API. Cross-origin
 *   cookies require `sameSite: "None"` + `secure: true`, and `secure`
 *   means they will NOT work over plain HTTP — so a cross-origin SPA in
 *   local development silently gets no session at all. That's a browser
 *   rule, not a framework limitation. Pair this guard with the `csrf()`
 *   middleware.
 */
export function authConfig(env: Env): AuthConfig {
  return {
    default: "token",

    guards: {
      token: {
        provider: "users",
        // null = never expires, matching Sanctum. `expires_at` is on the
        // table already, so switching to a finite lifetime is a config
        // change and nothing more.
        expiresInMinutes: null,
      },
      session: {
        provider: "users",
        store: "database",
        cookie: "session",
        lifetimeMinutes: 120,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
        path: "/",
      },
    },

    providers: {
      users: {
        driver: "database",
        model: User,
        identifierColumn: "email",
        passwordColumn: "password",
      },
    },

    passwords: {
      // How long a reset link stays valid, and how often one address may
      // request another. The throttle is per-MAILBOX and complements the
      // per-IP `throttle()` middleware on the route — an attacker rotating
      // IPs to flood a victim's inbox defeats the middleware, not this.
      expiresInMinutes: 60,
      throttleSeconds: 60,
    },

    verification: {
      // The broker stamps `email_verified_at` on this model, which a
      // UserProvider cannot do (it reads users; it does not write
      // arbitrary columns).
      model: User,
      expiresInMinutes: 60,
      // Must match the route registered in `auth.routes.ts`.
      path: "/auth/verify-email",
    },

    /**
     * Whether the scaffolded auth controllers send their emails.
     *
     * The framework never reads these — `@mahiframework/auth` sends no mail at all.
     * The controllers in `src/http/controllers/` check them, so turning
     * one off hands delivery back to you (a listener, SMS, an ESP API)
     * without deleting the controller. The broker still mints the token or
     * link and the endpoint still responds normally; only the send stops.
     */
    notifications: {
      resetPassword: env.AUTH_SEND_RESET_EMAIL,
      verifyEmail: env.AUTH_SEND_VERIFY_EMAIL,
    },
  };
}
