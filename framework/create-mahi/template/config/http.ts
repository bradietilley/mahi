import type { HttpConfig } from "@mahiframework/http";
import type { Env } from "./env.js";

/**
 * Allows a cross-origin client (a separate frontend, a mobile app, another
 * service) to call this API. `CORS_ORIGIN` is a comma-separated list of
 * allowed origins; see config/env.ts.
 */
export function httpConfig(env: Env): HttpConfig {
  return {
    url: env.APP_URL,
    cors: {
      origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    },

    /**
     * Maximum inbound request body. The framework parses every request
     * body eagerly, before any route decision, so without a ceiling a
     * single large unauthenticated POST is a memory-exhaustion DoS, on
     * paths that don't even exist.
     *
     * Defaults (1 MiB / 10 MiB multipart) suit a JSON API. Raise
     * `BODY_LIMIT_MULTIPART_BYTES` if you accept large uploads; note
     * uploads are buffered in memory, so the number is per in-flight
     * request.
     */
    bodyLimit: {
      ...(env.BODY_LIMIT_BYTES === undefined ? {} : { maxBytes: env.BODY_LIMIT_BYTES }),
      ...(env.BODY_LIMIT_MULTIPART_BYTES === undefined
        ? {}
        : { maxMultipartBytes: env.BODY_LIMIT_MULTIPART_BYTES }),
    },

    /**
     * Response security headers: `nosniff`, `Referrer-Policy`,
     * `X-Frame-Options`, and HSTS on requests already known to be
     * secure. On by default; the object is here so the knobs are
     * discoverable.
     *
     * For a browser-facing app you'd usually also want a
     * Content-Security-Policy, which is app-specific and so not
     * defaulted, add it via `extra`.
     */
    securityHeaders: {},

    /**
     * `GET /up`, liveness. Answers "is this process alive?" with no I/O
     * at all. Kubernetes' `livenessProbe`; a failure here means *restart
     * the pod*, so it must never touch a dependency: one Redis blip would
     * otherwise restart every pod in the deployment at once.
     */
    liveness: {},

    /**
     * `GET /health`, readiness. Runs every check registered through a
     * provider's `checks()` hook and returns `200`, or `503` if any
     * failed. Kubernetes' `readinessProbe`; a failure means *drain this
     * instance but leave it running*.
     *
     * Failure messages are driver errors (`connect ECONNREFUSED
     * 10.0.1.4:5432`), so they're replaced with "Check failed" in
     * production unless the request carries `X-Health-Secret`. Leave
     * `HEALTH_SECRET` unset and they're simply always redacted there.
     */
    healthCheck: {
      secret: env.HEALTH_SECRET,
    },
  };
}
