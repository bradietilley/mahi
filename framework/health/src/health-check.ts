import type { Application } from "@mahiframework/core";

/**
 * What one check reported.
 *
 * - `true`   — passed.
 * - `string` — failed, and this is why (a driver error message, or a
 *   message the check returned itself).
 * - `null`   — skipped: this application does not use the dependency, so
 *   nothing was verified. Deliberately distinct from `true`; reporting a
 *   pass for something never contacted is a lie that eventually gets
 *   believed.
 */
export type CheckOutcome = true | string | null;

/**
 * Outcomes keyed by group, then by check name:
 *
 *     { core: { cache: true }, app: { stripe: "Failed to connect" } }
 *
 * This object IS the `/health` response body and the `--json` payload —
 * both frontends serialize the same value, so a load balancer and CI can
 * never be looking at different shapes.
 */
export type HealthResults = Record<string, Record<string, CheckOutcome>>;

export interface HealthReport {
  /**
   * True when no check returned a failure string. Computed once, in the
   * registry, from the same data `results` is built from — so the HTTP
   * status and the payload can never disagree. Neither frontend
   * re-derives it.
   *
   * Skipped checks do NOT fail the report: a skip describes the app, not
   * a fault. If a skip should have been a failure, the check was wrong to
   * skip.
   */
  healthy: boolean;
  results: HealthResults;
  /** Wall-clock duration of the whole run, for the CLI table. Not serialized. */
  durationMs: number;
}

/**
 * One readiness probe: a name and a function. Deliberately a plain object
 * rather than a base class — `Command` is a class because it carries
 * seven `Tui` forwarding methods, a `configure()` hook, and per-invocation
 * construction; a check has none of that, and a base class would only add
 * a "which members must I implement?" question and a file per check.
 *
 *     checks(): HealthCheck[] {
 *       return [{ name: "stripe", run: () => stripe.ping() }];
 *     }
 */
export interface HealthCheck {
  /** Result-object key within the group. Lowercase, stable — it goes in the JSON. */
  name: string;
  /** Result-object group. Defaults to `"app"`; the framework's own checks use `"core"`. */
  group?: string;
  /** Per-check deadline. Defaults to `health.timeoutSeconds` (5). */
  timeoutSeconds?: number;
  /**
   * Three return channels, which look like three ways to say one thing
   * and are not:
   *
   * - **throw** is what a real dependency failure does on its own. A
   *   `cache.put()` rejecting with `ECONNREFUSED` should not require
   *   every check author to write a `try/catch` to convert it into a
   *   return value.
   * - **return a string** is for a check that completes normally but
   *   disagrees with the result — `"Stripe returned 403"`, `"disk 94%
   *   full"`. No exception exists to catch.
   * - **return `null`** is skip — a dependency this app doesn't use.
   *
   * Returning `void`/`true` passes.
   *
   * Receives the `Application` rather than closing over it, so a check
   * declared as a module-level `const` (the natural form for a
   * framework-supplied check) needs no factory wrapper.
   */
  run(app: Application): void | true | string | null | Promise<void | true | string | null>;
}
