/**
 * Callback deciding whether a hit should be recorded, evaluated against
 * whatever the consumer passes in (an HTTP `Response`, a job result,
 * etc.) — `Limit` itself has no opinion on what that value is, matching
 * Laravel's `Limit::$afterCallback` (a plain `callable`). Used for
 * "only count failed attempts" style limits (e.g. login throttling).
 */
export type AfterCallback = (result: unknown) => boolean | Promise<boolean>;

/**
 * Callback building a custom response when a limit is exceeded, in place
 * of the default. Untyped here (this package has zero knowledge of HTTP)
 * — `@mahiframework/http`'s `throttle()` calls it with `(c: Context,
 * headers: Record<string, string>)` and expects a `Response` back; see
 * that package's `Limit.response()` usage.
 */
export type ResponseCallback = (...args: any[]) => any;

/**
 * A single rate limit — max attempts within a decay window, optionally
 * scoped to a key, with optional `after`/`response` hooks. Laravel's
 * `Illuminate\Cache\RateLimiting\Limit` equivalent; `RateLimiter.for()`
 * callbacks return one (or several, for stacked limits — e.g. "10/minute
 * AND 1000/day") of these.
 *
 *   Limit.perMinute(60).by(userId)
 *   Limit.perMinute(5).by(ip).response((c, headers) => c.json({ error: "slow down" }, 429))
 *   Limit.none()   // Unlimited — skip rate limiting entirely for this request
 *
 * `GlobalLimit`/`Unlimited` are declared in this same file (rather than
 * their own modules) to sidestep a circular-import initialization order
 * problem: `Limit.none()` needs to construct an `Unlimited`, which
 * `extends GlobalLimit`, which `extends Limit` — ESM class `extends`
 * requires the base class binding to already be fully evaluated, so
 * splitting these across files each importing the other would throw at
 * module-load time. `index.ts` still re-exports all three as if they
 * were separate modules.
 */
export class Limit {
  key: string;
  maxAttempts: number;
  decaySeconds: number;
  afterCallback?: AfterCallback;
  responseCallback?: ResponseCallback;

  constructor(key = "", maxAttempts = 60, decaySeconds = 60) {
    this.key = key;
    this.maxAttempts = maxAttempts;
    this.decaySeconds = decaySeconds;
  }

  static perSecond(maxAttempts: number, decaySeconds = 1): Limit {
    return new Limit("", maxAttempts, decaySeconds);
  }

  static perMinute(maxAttempts: number, decayMinutes = 1): Limit {
    return new Limit("", maxAttempts, 60 * decayMinutes);
  }

  /** Same as `perMinute`, with the arguments in decay-then-max order — matches Laravel's `Limit::perMinutes()`. */
  static perMinutes(decayMinutes: number, maxAttempts: number): Limit {
    return new Limit("", maxAttempts, 60 * decayMinutes);
  }

  static perHour(maxAttempts: number, decayHours = 1): Limit {
    return new Limit("", maxAttempts, 60 * 60 * decayHours);
  }

  static perDay(maxAttempts: number, decayDays = 1): Limit {
    return new Limit("", maxAttempts, 60 * 60 * 24 * decayDays);
  }

  /** An explicit "no limit" escape hatch — e.g. `key.plan === "vip" ? Limit.none() : Limit.perMinute(10)`. */
  static none(): Unlimited {
    return new Unlimited();
  }

  /** Sets the signature key this limit applies to (e.g. a user id, IP, API key). */
  by(key: string): this {
    this.key = key;

    return this;
  }

  /** Only record a hit if `callback(result)` returns true — checked after the guarded work runs. */
  after(callback: AfterCallback): this {
    this.afterCallback = callback;

    return this;
  }

  /** Build a custom response when this limit is exceeded, instead of the default 429. */
  response(callback: ResponseCallback): this {
    this.responseCallback = callback;

    return this;
  }

  /**
   * A fallback key derived from this limit's own attributes, used by
   * `RateLimiter.limiter()` to disambiguate two limits from the same
   * named limiter that would otherwise collide on an empty/duplicate
   * `.key` (e.g. two `Limit.perMinute()` calls with no explicit `.by()`).
   */
  fallbackKey(): string {
    const prefix = this.key ? `${this.key}:` : "";

    return `${prefix}attempts:${this.maxAttempts}:decay:${this.decaySeconds}`;
  }
}

/**
 * A limit not split per-key — every caller shares the same counter,
 * rather than each being tracked independently (e.g. "this endpoint may
 * be called 1000 times/minute globally, across all callers combined").
 * Laravel's `Illuminate\Cache\RateLimiting\GlobalLimit`.
 */
export class GlobalLimit extends Limit {
  constructor(maxAttempts: number, decaySeconds = 60) {
    super("", maxAttempts, decaySeconds);
  }
}

/**
 * An explicit "no rate limit" marker — a named limiter callback can
 * return this to skip rate limiting entirely for a given request (e.g.
 * for admin users). Laravel's `Illuminate\Cache\RateLimiting\Unlimited`;
 * consumers (`throttle()`) check `instanceof Unlimited` and bypass rate
 * limiting entirely rather than enforcing a limit of
 * `Number.MAX_SAFE_INTEGER`.
 */
export class Unlimited extends GlobalLimit {
  constructor() {
    super(Number.MAX_SAFE_INTEGER);
  }
}
