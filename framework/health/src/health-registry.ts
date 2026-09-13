import { pooled, type Application } from "@mahiframework/core";
import type { CheckOutcome, HealthCheck, HealthReport, HealthResults } from "./health-check.js";
import type { HealthConfig } from "./health-config.js";

/** Group a check reports under when it doesn't name one. */
export const DEFAULT_GROUP = "app";

/** Per-check deadline when neither the check nor `health` config sets one. */
export const DEFAULT_TIMEOUT_SECONDS = 5;

/**
 * The one place checks live and the one place they run. Both frontends,
 * `GET /health` and `./artisan health`, are thin shells over
 * `run()`, so they cannot drift from each other.
 */
export class HealthRegistry {
  /** Keyed `"group\u0000name"`, so a later registration replaces an earlier one. */
  private checks = new Map<string, HealthCheck>();

  constructor(
    private app: Application,
    private config: HealthConfig = {},
  ) {}

  /**
   * Register one or many checks.
   *
   * A later registration with the same group + name **replaces** an
   * earlier one, mirroring `ConsoleKernel.registeredCommands()`. Providers
   * are collected in `config/app.ts` order and framework providers come
   * first, so "later wins" means "the app can override a framework check":
   * an app on a managed database that wants a different query than core's
   * `select 1` registers `{ group: "core", name: "database", run: ... }`
   * and gets it, with no deregistration API to design.
   */
  register(...checks: HealthCheck[]): this {
    for (const check of checks) {
      this.checks.set(keyFor(check), check);
    }

    return this;
  }

  /** Every registered check, in registration order. */
  all(): readonly HealthCheck[] {
    return [...this.checks.values()];
  }

  /**
   * Run every check and build the report. **Never throws**, a check that
   * blows up produces a failure string in its own slot and nothing else is
   * affected. A probe endpoint that 500s because one check author threw a
   * non-`Error` reports "the app is broken" when the truth is "the check
   * is broken".
   */
  async run(): Promise<HealthReport> {
    const checks = this.all();
    const startedAt = Date.now();

    // `pooled()` rather than a `for` loop so `concurrency` is a config
    // value and not a rewrite. It also surfaces a rejection as an Error
    // *value* rather than rejecting the pool, though `runOne()` already
    // guarantees it never rejects, so that is a second belt.
    const outcomes = await pooled(
      checks.map((check) => () => this.runOne(check)),
      { concurrency: this.config.concurrency ?? 1 },
    );

    const results: HealthResults = {};
    let healthy = true;

    checks.forEach((check, index) => {
      const outcome = outcomes[index];
      const value: CheckOutcome =
        outcome instanceof Error ? messageFor(outcome) : (outcome ?? null);
      const group = check.group ?? DEFAULT_GROUP;
      (results[group] ??= {})[check.name] = value;

      if (typeof value === "string") {
        healthy = false;
      }
    });

    return { healthy, results, durationMs: Date.now() - startedAt };
  }

  /**
   * Run one check, converting every way it can end into a `CheckOutcome`.
   * Never throws, and always terminates.
   */
  private async runOne(check: HealthCheck): Promise<CheckOutcome> {
    const seconds = check.timeoutSeconds ?? this.config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    try {
      const outcome = await withTimeout(
        // Inside the `try` on purpose: a check that throws *synchronously*
        // before returning a promise must be caught here too.
        async () => check.run(this.app),
        seconds,
      );

      if (outcome === null) {
        return null;
      }

      if (typeof outcome === "string") {
        return outcome;
      }

      return true;
    } catch (error) {
      return messageFor(error);
    }
  }
}

function keyFor(check: HealthCheck): string {
  return `${check.group ?? DEFAULT_GROUP}\u0000${check.name}`;
}

/**
 * Race `work` against a deadline. Without this, one check on a TCP
 * connection with no socket timeout hangs the request until the load
 * balancer's own timeout fires, at which point the balancer has learned
 * nothing and the app is holding an open request per probe interval,
 * forever.
 *
 * The timer is cleared in a `finally` on both paths. A leaked timer keeps
 * the Node process alive after `./artisan health` returns, which is a
 * hang, not a slow exit.
 */
export async function withTimeout<T>(work: () => Promise<T>, seconds: number): Promise<T | string> {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return work();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`Timed out after ${seconds}s`), seconds * 1000);
    // Deliberately NOT `unref()`ed. An unref'd deadline lets the process
    // exit before it fires, which in the hung-check case means
    // `./artisan health` exits silently having printed nothing, the
    // exact scenario this timer exists to turn into a reported failure.
    // `clearTimeout` in the `finally` below is what prevents the leak.
  });

  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `catch` is `unknown` and a driver may reject with a plain object, so
 * every shape has to produce a usable string.
 */
export function messageFor(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error);
}
