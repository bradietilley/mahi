import { app } from "@mahi/core";
import { RateLimiter, Limit, Unlimited, RATE_LIMITER_TOKEN } from "@mahi/cache";
import type { Request } from "../request.js";
import type { HttpPipeFn } from "./pipeline-middleware.js";
import { HttpResponse } from "../response.js";

/**
 * Options for the inline (non-named) form of `throttle()`:
 *
 *   throttle({ max: 20, windowSeconds: 60 })
 *   throttle({ max: 20, windowSeconds: 60, key: (request) => request.ip() ?? "unknown" })
 */
export interface ThrottleOptions {
  /** Max requests allowed per window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * How to key the limiter — defaults to the client IP (`request.ip()`,
   * i.e. the socket peer unless `trustProxies()` says otherwise).
   *
   * Note the default cannot distinguish clients that share an address
   * (NAT, a corporate egress), and reports `unknown` when there is no
   * peer to name. For anything protecting a specific account, key on the
   * identity too — see `AppServiceProvider`'s `login` limiter, which
   * combines email + IP.
   */
  key?: (request: Request) => string;
}

const defaultKey = (request: Request): string => request.ip() ?? "unknown";

/**
 * Rate-limiting pipe, backed by `@mahi/cache`'s `RateLimiter`.
 * Two forms:
 *
 * 1. **Inline** — a plain `{ max, windowSeconds }` object:
 *
 *      router.post("/todos", createTodo).middleware(throttle({ max: 20, windowSeconds: 60 }))
 *
 * 2. **Named** — a string referencing a limiter registered via
 *    `RateLimiter.for(name, callback)`:
 *
 *      limiter.for("uploads", (request) => Limit.perMinute(5).by(request.user()?.id ?? request.ip() ?? "unknown"));
 *      router.post("/uploads", uploadHandler).middleware(throttle("uploads"));
 */
export function throttle(nameOrOptions: string | ThrottleOptions): HttpPipeFn {
  return async (request, next) => {
    const limiter = app().make<RateLimiter>(RATE_LIMITER_TOKEN);

    const limits = await resolveLimits(limiter, nameOrOptions, request);

    for (const limit of limits) {
      if (limit instanceof Unlimited) {
        continue;
      }

      // A limit that only counts *after* the response (a conditional
      // `afterCallback`) can't be incremented up front, so it still reads
      // the current count and hits later. A normal limit increments
      // atomically HERE and decides on the returned count — see
      // `RateLimiter.hitAndCheck()` — so concurrent requests can't all slip
      // under the limit in the read-then-write gap.
      const exceeded = limit.afterCallback
        ? await limiter.tooManyAttempts(limit.key, limit.maxAttempts)
        : (await limiter.hitAndCheck(limit.key, limit.maxAttempts, limit.decaySeconds)).exceeded;

      if (exceeded) {
        const headers = await buildHeaders(limiter, limit);

        if (limit.responseCallback) {
          return limit.responseCallback(request, headers);
        }

        return HttpResponse.json({ message: "Too Many Requests" }, 429, headers);
      }
    }

    const response = await next(request);

    for (const limit of limits) {
      if (limit instanceof Unlimited) {
        continue;
      }

      if (limit.afterCallback && (await limit.afterCallback(response))) {
        await limiter.hit(limit.key, limit.decaySeconds);
      }

      const headers = await buildHeaders(limiter, limit);

      for (const [key, value] of Object.entries(headers)) {
        response.headers.set(key, value);
      }
    }

    return response;
  };
}

async function resolveLimits(
  limiter: RateLimiter,
  nameOrOptions: string | ThrottleOptions,
  request: Request,
): Promise<Limit[]> {
  if (typeof nameOrOptions !== "string") {
    const keyFn = nameOrOptions.key ?? defaultKey;
    // Keyed on the route PATTERN (`/posts/{post}`), not the concrete
    // path. Using the concrete path gives every id its own bucket, so an
    // attacker multiplies their quota simply by walking ids —
    // `/posts/1`, `/posts/2`, … — and a limit of 5/min on `/posts/{post}`
    // becomes 5/min *per post*, which for an enumerable id is no limit.
    // Falls back to the concrete path only before the router has
    // matched, where there is no pattern to use.
    const scope = request.routePattern() ?? request.path();
    const key = `throttle:${keyFn(request)}:${scope}`;

    return [new Limit(key, nameOrOptions.max, nameOrOptions.windowSeconds)];
  }

  const resolved = limiter.limiter(nameOrOptions);

  if (!resolved) {
    throw new Error(
      `Rate limiter "${nameOrOptions}" is not defined. Register it via RateLimiter.for().`,
    );
  }

  const limits = await resolved(request);

  for (const limit of limits) {
    limit.key = `throttle:${nameOrOptions}:${limit.key}`;
  }

  return limits;
}

async function buildHeaders(limiter: RateLimiter, limit: Limit): Promise<Record<string, string>> {
  const remaining = await limiter.remaining(limit.key, limit.maxAttempts);
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(limit.maxAttempts),
    "X-RateLimit-Remaining": String(remaining),
  };

  const retryAfterSeconds = await limiter.availableIn(limit.key);

  if (remaining === 0) {
    headers["Retry-After"] = String(retryAfterSeconds);
    headers["X-RateLimit-Reset"] = String(Math.ceil(Date.now() / 1000) + retryAfterSeconds);
  }

  return headers;
}
