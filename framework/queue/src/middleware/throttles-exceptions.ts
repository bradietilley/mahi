import { type RateLimiter } from "@mahiframework/cache";
import type { JobMiddleware, JobMiddlewarePassable } from "./job-middleware.js";
import { ReleaseJobError } from "./release-job-error.js";

/**
 * Job middleware implementing a circuit breaker: if a job throws more than
 * `maxExceptions` times within `decayMinutes`, the "circuit opens" and
 * subsequent runs are **released** back onto the queue without executing
 * `handle()` at all — until the window elapses — sparing a failing
 * downstream dependency from being hammered by every retry. Ports
 * Laravel's `ThrottlesExceptions`, reusing `@mahiframework/cache`'s
 * `RateLimiter` as the exception counter (keyed on occurrence, not on
 * calls).
 *
 * The `RateLimiter` is passed in **explicitly**, same as `RateLimited`:
 *
 *   middleware() {
 *     return [new ThrottlesExceptions(this.rateLimiter, `orders:${this.order.id}`, { maxExceptions: 10, decayMinutes: 5 })];
 *   }
 *
 * On the happy path a job runs normally; a thrown error is re-thrown (so
 * the worker's own attempts/backoff still apply) *after* being counted —
 * the breaker only affects *future* runs once the threshold is crossed.
 */
export class ThrottlesExceptions implements JobMiddleware {
  constructor(
    private readonly limiter: RateLimiter,
    /** Key isolating this job's exception counter from others'. */
    private readonly key: string,
    private readonly options: {
      /** Exceptions tolerated within `decayMinutes` before the circuit opens. Default `10`. */
      maxExceptions?: number;
      /** Window (minutes) the exception counter decays over. Default `1`. */
      decayMinutes?: number;
      /** Seconds to wait before retrying while the circuit is open. Default: `availableIn()`, floored at `retryAfterSeconds`. */
      retryAfterSeconds?: number;
    } = {},
  ) {}

  async handle(
    passable: JobMiddlewarePassable,
    next: (passable: JobMiddlewarePassable) => Promise<void>,
  ): Promise<void> {
    const maxExceptions = this.options.maxExceptions ?? 10;
    const decaySeconds = (this.options.decayMinutes ?? 1) * 60;
    const retryAfter = this.options.retryAfterSeconds ?? 0;
    const counterKey = `throttle-exceptions:${this.key}`;

    // Circuit open? Release without running.
    if (await this.limiter.tooManyAttempts(counterKey, maxExceptions)) {
      const availableIn = await this.limiter.availableIn(counterKey);
      throw new ReleaseJobError(Math.max(availableIn, retryAfter));
    }

    try {
      await next(passable);
    } catch (error) {
      // Count this failure, then re-throw so the worker's normal
      // attempts/backoff/failed-job handling still runs.
      await this.limiter.hit(counterKey, decaySeconds);
      throw error;
    }
  }
}
