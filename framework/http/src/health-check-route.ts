import type { Application } from "@mahi/core";
import type { Request } from "./request.js";
import type { HttpHealthCheckConfig } from "./http-config.js";
import { secretMatches } from "./secret-compare.js";

/**
 * Container token for `@mahi/health`'s `HealthRegistry`.
 *
 * Resolved here by string rather than imported, so `@mahi/http` keeps no
 * dependency on `@mahi/health` — the same one-way arrangement this package
 * already has with `MAINTENANCE_MODE_TOKEN` and `BROADCAST_TOKEN`. The
 * readiness route is simply not registered when nothing has bound it.
 */
export const HEALTH_TOKEN = "health";

/** What this package needs from `@mahi/health`'s registry: one method. */
export interface HealthRegistryLike {
  run(): Promise<{
    healthy: boolean;
    results: Record<string, Record<string, true | string | null>>;
  }>;
}

/** The message a redacted failure is replaced with. */
export const REDACTED_MESSAGE = "Check failed";

/**
 * Whether failure messages must be stripped before they leave the process.
 *
 * Redacted in production unless the request carries the configured
 * `X-Health-Secret`. Never redacted outside production — a developer
 * needs the real error, and `isProduction()` is the same gate the rest of
 * the framework uses for safety defaults.
 */
export function shouldRedact(
  app: Application,
  request: Request,
  config: HttpHealthCheckConfig,
): boolean {
  if (!app.isProduction()) {
    return false;
  }

  if (config.secret && secretMatches(request.header("x-health-secret"), config.secret)) {
    return false;
  }

  return true;
}

/**
 * Replace every failure message with a constant, leaving `true` and
 * `null` — and the shape of the object — untouched. Which checks exist and
 * which failed stays visible; only the message goes.
 *
 * This exists because the failure strings are, by construction, driver
 * errors: `connect ECONNREFUSED 10.0.1.4:5432`, `getaddrinfo ENOTFOUND
 * prod-redis.internal`, `SQLITE_CANTOPEN: unable to open database file
 * /srv/app/storage/prod.sqlite`. That is internal topology, and `/health`
 * is by definition reachable from whatever is probing it — often a load
 * balancer, sometimes the internet, and always before anyone remembers to
 * put an ACL on it.
 */
export function redactFailures<T extends Record<string, Record<string, true | string | null>>>(
  results: T,
): T {
  const redacted: Record<string, Record<string, true | string | null>> = {};

  for (const [group, checks] of Object.entries(results)) {
    redacted[group] = {};

    for (const [name, outcome] of Object.entries(checks)) {
      redacted[group][name] = typeof outcome === "string" ? REDACTED_MESSAGE : outcome;
    }
  }

  return redacted as T;
}
