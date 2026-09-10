import type { Context, MiddlewareHandler } from "hono";
import type { HttpSecurityHeadersConfig } from "../http-config.js";
import { REQUEST_CONTEXT_KEY, type Request } from "../request.js";

/** 180 days, the value the major header-hardening middlewares settled on. */
const DEFAULT_HSTS = "max-age=15552000; includeSubDomains";

/**
 * Apply response security headers.
 *
 * Written by hand rather than delegating to `hono/secure-headers` for one
 * reason that matters and one that follows from it:
 *
 *  - **HSTS must be conditional on the request actually being secure.**
 *    `hono/secure-headers` sets `Strict-Transport-Security`
 *    unconditionally. An app served over plain HTTP in development would
 *    then emit it on every response; browsers ignore it over HTTP today,
 *    but the header is a *commitment*, and emitting one the deployment
 *    cannot keep is how a staging box becomes unreachable for six
 *    months. This checks the scheme first — which, behind a TLS
 *    terminator, is only correct because `trustProxies()` applies
 *    `X-Forwarded-Proto`.
 *  - The remaining defaults there are browser-document defaults (COEP,
 *    COOP, Origin-Agent-Cluster, `X-XSS-Protection`) that mean nothing
 *    for a JSON API and are noise on every response.
 *
 * Headers are set only when absent, so a handler that deliberately set
 * its own (a route that must be framed, say) keeps it.
 */
export function securityHeaders(config: HttpSecurityHeadersConfig = {}): MiddlewareHandler {
  const referrerPolicy = config.referrerPolicy ?? "no-referrer";
  const frameOptions = config.frameOptions ?? "DENY";
  const hsts = config.strictTransportSecurity ?? DEFAULT_HSTS;
  const extra = config.extra ?? {};

  return async (c, next) => {
    await next();

    const headers = c.res.headers;

    // The one header with no upside to omitting: without it a browser
    // may sniff a JSON error body as HTML and execute it.
    setIfAbsent(headers, "X-Content-Type-Options", "nosniff");

    if (referrerPolicy !== false) {
      setIfAbsent(headers, "Referrer-Policy", referrerPolicy);
    }

    if (frameOptions !== false) {
      setIfAbsent(headers, "X-Frame-Options", frameOptions);
    }

    if (hsts !== false && isSecureRequest(c)) {
      setIfAbsent(headers, "Strict-Transport-Security", hsts);
    }

    for (const [key, value] of Object.entries(extra)) {
      headers.set(key, value);
    }
  };
}

function setIfAbsent(headers: Headers, key: string, value: string): void {
  if (!headers.has(key)) {
    headers.set(key, value);
  }
}

/**
 * Whether this request arrived over TLS.
 *
 * Prefers the Mahi `Request`'s scheme over `c.req.url`, because that is
 * the one `trustProxies()` has already corrected from
 * `X-Forwarded-Proto`. Behind a TLS terminator the raw Hono URL is
 * always `http://` — reading it would mean HSTS is never sent by
 * precisely the deployments that need it. Falls back to the raw URL when
 * no `Request` was constructed (a route reached before the global pipe).
 */
function isSecureRequest(c: Context): boolean {
  const request = c.get(REQUEST_CONTEXT_KEY) as Request | undefined;

  if (request) {
    return request.secure();
  }

  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}
