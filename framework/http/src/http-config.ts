/**
 * Optional `"http"` config namespace, read by HttpKernel at construction
 * time via `app.config.get<HttpConfig>("http")`. Nothing is applied if the
 * app never sets this namespace — CORS is opt-in, matching the framework's
 * explicit-registration philosophy (no magic defaults for cross-origin
 * access).
 */
export interface HttpCorsConfig {
  /** Value of the `Access-Control-Allow-Origin` header. Defaults to hono/cors's own default ("*") if omitted. */
  origin?: string | string[];
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/**
 * Opt-in **liveness** endpoint (Laravel's `/up`). Present-but-empty (`{}`)
 * enables it at the default `/up` path; nothing is registered unless this
 * key is set — matching the framework's no-implicit-defaults stance. The
 * route responds `200 {"status":"ok"}`, does **no I/O**, and is exempt
 * from maintenance mode (orchestrators must still reach it while the app
 * is down).
 *
 * Answers "is the process alive?" — a Kubernetes `livenessProbe`, whose
 * failure means *restart the pod*. For "should this instance receive
 * traffic?" see `HttpHealthCheckConfig` below.
 */
export interface HttpLivenessConfig {
  /** Route path. Defaults to `/up`. */
  path?: string;
}

/**
 * Opt-in **readiness** endpoint (`GET /health`), registered only when
 * `@mahiframework/health` is installed and its `HEALTH_TOKEN` is bound.
 * Present-but-empty (`{}`) enables it at the default `/health` path.
 *
 * Runs every registered health check and responds with the terse result
 * object — `200` if all passed, `failureStatus` (503) if any failed:
 *
 *     {"core":{"cache":true,"database":true},"app":{"stripe":"Failed to connect"}}
 *
 * Answers "should this instance receive traffic?" — a Kubernetes
 * `readinessProbe`, whose failure means *drain it, leave it running*.
 *
 * Unlike `/up`, this route is **not** maintenance-exempt: a readiness
 * probe answering "ready" while an operator has explicitly taken the app
 * down would put traffic straight back on it.
 */
export interface HttpHealthCheckConfig {
  /** Route path. Defaults to `/health`. */
  path?: string;
  /**
   * Status returned when any check fails. Defaults to **503**, not 500: a
   * load balancer drains a 503 and pages on a 500. A failing dependency
   * is the former.
   */
  failureStatus?: number;
  /**
   * Shared secret that un-redacts failure messages in production, sent as
   * the `X-Health-Secret` header — mirroring `X-Maintenance-Secret`, so an
   * operator who has configured one already knows this.
   *
   * Deliberately header-only. The maintenance middleware also accepts its
   * secret as the first path segment, which is right for a browser being
   * pointed at a downed site and wrong for a machine probe.
   */
  secret?: string;
}

/**
 * Inbound request body size limits, enforced before the body is read
 * into memory.
 *
 * Unlike CORS and the probe routes, this has **defaults and is on**. The
 * framework parses the body of every request eagerly, in a global pipe,
 * before any route or handler decision — so with no limit a single
 * unauthenticated `POST` of an arbitrarily large JSON document is a
 * memory-exhaustion DoS against any app, including on paths that do not
 * exist. "Opt in to not being trivially killable" is not a defensible
 * default; an app that genuinely accepts huge uploads raises the number.
 */
export interface HttpBodyLimitConfig {
  /**
   * Maximum size in bytes for a non-multipart body (JSON, urlencoded,
   * text). Defaults to 1 MiB — comfortably above any realistic API
   * payload, far below anything that threatens a process.
   */
  maxBytes?: number;
  /**
   * Maximum size in bytes for a `multipart/form-data` body, which is the
   * file-upload path and legitimately larger. Defaults to 10 MiB.
   *
   * Note that uploads are buffered in memory today, so this bounds
   * memory per in-flight request, not disk.
   */
  maxMultipartBytes?: number;
}

/**
 * Response security headers, applied to every response.
 *
 * On by default with a conservative API-shaped set: `nosniff`,
 * `no-referrer`, `X-Frame-Options: DENY`, and HSTS **only** on requests
 * the app already knows are secure. These cost nothing, break nothing
 * for a JSON API, and are the sort of thing that otherwise gets added
 * after a pen test rather than before one.
 */
export interface HttpSecurityHeadersConfig {
  /** Set `false` to install no headers at all. */
  enabled?: boolean;
  /**
   * `Strict-Transport-Security` value, or `false` to omit it. Defaults
   * to `max-age=15552000; includeSubDomains` (180 days).
   *
   * Only ever sent on a request whose scheme is already `https` (see
   * `Request.secure()`, which requires `trustProxies()` to be correct
   * behind a TLS terminator). Sending HSTS over plain HTTP is ignored by
   * browsers per spec, and sending it from an app that is not actually
   * reachable over TLS would lock clients out of it.
   */
  strictTransportSecurity?: string | false;
  /** `Referrer-Policy` value, or `false` to omit. Defaults to `no-referrer`. */
  referrerPolicy?: string | false;
  /** `X-Frame-Options` value, or `false` to omit. Defaults to `DENY`. */
  frameOptions?: string | false;
  /** Extra headers merged over the computed set. */
  extra?: Record<string, string>;
}

export interface HttpConfig {
  /** If set, CORS middleware is installed on every route via hono/cors. */
  cors?: HttpCorsConfig;
  /**
   * Request body size limits. Defaults apply when omitted; set
   * `{ maxBytes: 0 }` to disable the non-multipart limit entirely (not
   * recommended — see `HttpBodyLimitConfig`).
   */
  bodyLimit?: HttpBodyLimitConfig;
  /**
   * Response security headers. Defaults apply when omitted; set
   * `{ enabled: false }` to install none.
   */
  securityHeaders?: HttpSecurityHeadersConfig;
  /**
   * If set, a zero-I/O liveness route (default `GET /up`) is registered.
   */
  liveness?: HttpLivenessConfig;
  /**
   * If set, a readiness route (default `GET /health`) running every
   * registered health check is mounted — requires `@mahiframework/health`.
   */
  healthCheck?: HttpHealthCheckConfig;
  /**
   * The application's canonical root URL (scheme + host, e.g.
   * `"http://localhost:8000"`), used by the URL generator to build
   * absolute URLs when there is no in-flight request to borrow the host
   * from (queue jobs, CLI, scheduled tasks). Laravel's `app.url`. A
   * live request's own scheme/host takes precedence over this.
   */
  url?: string;
}
