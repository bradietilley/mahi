import { type RateLimiter, type Limit, Unlimited } from "@mahiframework/cache";
import type { JobMiddleware, JobMiddlewarePassable } from "./job-middleware.js";
import { ReleaseJobError } from "./release-job-error.js";

/**
 * Job middleware that rate-limits how often a job may run, using a named
 * limiter registered on `@mahiframework/cache`'s `RateLimiter` (the very
 * same primitive the `throttle()` HTTP middleware uses). When the limit is
 * exceeded the job is **released** back onto the queue, via
 * `ReleaseJobError`, to be retried once the window frees up, rather than
 * failed.
 *
 * The `RateLimiter` is passed in **explicitly** by the app (not
 * auto-resolved from the container inside the middleware), keeping
 * `@mahiframework/queue`'s relationship to `@mahiframework/cache` an optional
 * peer rather than a hard dependency:
 *
 *   // once, at boot:
 *   rateLimiter.for("emails", () => Limit.perMinute(30));
 *
 *   // on a job:
 *   middleware() {
 *     return [new RateLimited(this.rateLimiter, "emails")];
 *   }
 *
 * Register the limiter to return a `Limit.by(key)` to rate-limit per some
 * dimension of the job (per-user, per-tenant, ...); the limiter callback
 * receives the job INSTANCE as its argument (read its fields off `this`).
 */
export class RateLimited implements JobMiddleware {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly limiterName: string,
    /**
     * How long (seconds) to wait before retrying when a limit has no
     * computable "available in" window yet. Normally the limiter's own
     * `availableIn()` supplies the delay; this is only the floor/fallback.
     */
    private readonly releaseAfterSeconds = 0,
  ) {}

  async handle(
    passable: JobMiddlewarePassable,
    next: (passable: JobMiddlewarePassable) => Promise<void>,
  ): Promise<void> {
    const resolve = this.limiter.limiter(this.limiterName);

    if (!resolve) {
      // No such limiter registered, treat as unlimited (fail open),
      // matching Laravel's behaviour when a named limiter is absent.
      await next(passable);

      return;
    }

    const limits = await resolve(passable.job);

    for (const limit of limits) {
      if (limit instanceof Unlimited) {
        continue;
      }

      const key = this.keyFor(limit);

      if (await this.limiter.tooManyAttempts(key, limit.maxAttempts)) {
        const availableIn = await this.limiter.availableIn(key);
        throw new ReleaseJobError(Math.max(availableIn, this.releaseAfterSeconds));
      }
    }

    // Under every limit, count this run against each before proceeding.
    for (const limit of limits) {
      if (limit instanceof Unlimited) {
        continue;
      }

      await this.limiter.hit(this.keyFor(limit), limit.decaySeconds);
    }

    await next(passable);
  }

  private keyFor(limit: Limit): string {
    return `${this.limiterName}:${limit.key || limit.fallbackKey()}`;
  }
}
