import type { Application } from "@mahiframework/core";
import type { Request } from "../request.js";
import { HttpResponse, type HttpResponse as HttpResponseType } from "../response.js";
import type { HttpPipe } from "../middleware/pipeline-middleware.js";
import { secretMatches } from "../secret-compare.js";
import { MaintenanceMode, type MaintenanceData } from "./maintenance-mode.js";

/** Cookie holding a granted maintenance bypass. */
export const MAINTENANCE_BYPASS_COOKIE = "mahi_maintenance_bypass";

/** How long a granted bypass lasts, in seconds (12 hours). */
const BYPASS_TTL_SECONDS = 12 * 60 * 60;

/** Matches a request path against a single glob pattern (`*` = wildcard). */
function matchesPath(path: string, pattern: string): boolean {
  const normalized = pattern.startsWith("/") ? pattern : `/${pattern}`;
  const regex = new RegExp(
    `^${normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );

  return regex.test(path);
}

/**
 * How this request is presenting the bypass secret, if at all.
 *
 * - `header`, `X-Maintenance-Secret`, for a machine (curl, a probe, CI).
 * - `path`, `/<secret>/...`, for a human pasting the URL Laravel's
 *              `down --secret` prints. Answered with a redirect that
 *              SETS the cookie, so every subsequent request works
 *              normally.
 * - `cookie`, a bypass already granted.
 */
type BypassKind = "header" | "path" | "cookie" | undefined;

function bypassKind(request: Request, secret: string | undefined): BypassKind {
  if (!secret) {
    return undefined;
  }

  if (secretMatches(request.header("x-maintenance-secret"), secret)) {
    return "header";
  }

  if (secretMatches(cookieValue(request, MAINTENANCE_BYPASS_COOKIE), secret)) {
    return "cookie";
  }

  if (secretMatches(request.path().split("/").filter(Boolean)[0], secret)) {
    return "path";
  }

  return undefined;
}

/** Read one cookie off the request's `Cookie` header. */
function cookieValue(request: Request, name: string): string | undefined {
  const header = request.header("cookie");

  if (!header) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");

    if (eq === -1) {
      continue;
    }

    if (part.slice(0, eq).trim() !== name) {
      continue;
    }

    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }

  return undefined;
}

/**
 * Global pipe that short-circuits every request with a 503 (plus
 * `Retry-After`) while the application is down for maintenance, except
 * requests matching a configured `except` path (e.g. the liveness check)
 * or carrying the bypass secret. Installed automatically by `HttpKernel`
 * ahead of provider middleware, so no app wiring is required.
 */
export function maintenanceMiddleware(
  app: Application,
  mode: MaintenanceMode,
  alwaysExcept: string[] = [],
): HttpPipe {
  return async (request, next) => {
    const data = await mode.data();

    if (!data) {
      return next(request);
    }

    const except = [...alwaysExcept, ...(data.except ?? [])];

    if (except.some((pattern) => matchesPath(request.path(), pattern))) {
      return next(request);
    }

    const kind = bypassKind(request, data.secret);

    // The `/<secret>` URL is a one-time exchange, not a way to browse.
    // Merely skipping the 503 would let the request fall through to
    // routing, match nothing, and 404. The documented bypass would never
    // reach the application, and its only lasting effect would be writing
    // the secret into the access log of every proxy in front of it. Trade
    // it for a cookie and redirect to the root, which is what makes the
    // following requests work.
    if (kind === "path") {
      return grantBypass(data.secret!, request.secure());
    }

    if (kind) {
      return next(request);
    }

    return maintenanceResponse(data);
  };
}

/**
 * Redirect to `/` with the bypass cookie set.
 *
 * `HttpOnly` because nothing in a browser needs to read it, `SameSite=Lax`
 * so it survives a pasted link, and `Secure` whenever the request itself
 * was. The value IS the secret, so it must not be sent in clear once
 * TLS is available.
 */
function grantBypass(secret: string, secure: boolean): HttpResponseType {
  const attributes = [
    `${MAINTENANCE_BYPASS_COOKIE}=${encodeURIComponent(secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${BYPASS_TTL_SECONDS}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return HttpResponse.redirect("/", 302).header("Set-Cookie", attributes.join("; "));
}

function maintenanceResponse(data: MaintenanceData): HttpResponseType {
  const headers: Record<string, string> = {};

  if (data.retryAfter !== undefined) {
    headers["Retry-After"] = String(data.retryAfter);
  }

  return HttpResponse.json(
    { message: data.message ?? "Service Unavailable" },
    data.status ?? 503,
    headers,
  );
}
