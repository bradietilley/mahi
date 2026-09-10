/**
 * Cookies, owned by the framework rather than by Hono.
 *
 * WHY THIS EXISTS: Mahi handlers and pipes return **platform `Response`
 * objects**. Hono only merges its context-queued headers (`c.header()`,
 * and therefore `hono/cookie`'s `setCookie()`) into a response built
 * through `c.json()`/`c.body()`/`c.newResponse()` — so a cookie queued on
 * the Hono context by framework code was silently dropped on the floor.
 * That is not a cosmetic bug: it made `SessionGuard.login()` write a
 * session row the browser never learned the id of, so every subsequent
 * request was anonymous.
 *
 * The fix is to stop going through Hono at all. Cookies are queued on the
 * Mahi `Request` (`request.queueCookie(...)`) and drained onto the
 * outgoing response at the HTTP boundary, where the framework — not Hono
 * — decides what the final headers are. `Set-Cookie` is the one header
 * that legitimately repeats, so it is always *appended*, never `set`.
 */

/** Attributes of an outgoing cookie. Mirrors the `Set-Cookie` grammar. */
export interface CookieOptions {
  /** Lifetime in seconds. Omit for a session cookie (cleared on browser exit). */
  maxAge?: number;
  expires?: Date;
  domain?: string;
  /** Defaults to `"/"` — the whole site — matching every other framework. */
  path?: string;
  /** Send only over HTTPS. */
  secure?: boolean;
  /** Hide from `document.cookie`. The XSS defense for credential cookies. */
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | "strict" | "lax" | "none";
  /** CHIPS partitioned cookie. Requires `secure`. */
  partitioned?: boolean;
  priority?: "Low" | "Medium" | "High" | "low" | "medium" | "high";
  /**
   * Cookie name prefix the browser enforces:
   *
   * - `"secure"` → `__Secure-`: must be `Secure`.
   * - `"host"` → `__Host-`: must be `Secure`, `Path=/`, and no `Domain`,
   *   which is what makes it un-overwritable by a sibling subdomain. The
   *   right choice for a session or CSRF cookie on a domain that hosts
   *   anything else.
   */
  prefix?: "secure" | "host";
}

/** A cookie queued on the request, waiting to be written to the response. */
export interface QueuedCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

/**
 * 400 days, the cap browsers (per RFC 6265bis) silently clamp `Max-Age`
 * and `Expires` to. Exceeding it is a configuration mistake worth
 * surfacing rather than quietly truncating.
 */
const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;

// RFC 6265 token characters. A name outside this set can't be parsed back
// reliably, so it's rejected at write time rather than producing a cookie
// the browser ignores.
const VALID_COOKIE_NAME = /^[\w!#$%&'*.^`|~+-]+$/;

/** Apply `__Secure-`/`__Host-` prefixing and the attributes each implies. */
function applyPrefix(
  name: string,
  options: CookieOptions,
): { name: string; options: CookieOptions } {
  if (options.prefix === "secure") {
    return { name: `__Secure-${name}`, options: { ...options, secure: true } };
  }

  if (options.prefix === "host") {
    // `Domain` is not merely defaulted away but removed: a `__Host-`
    // cookie with a Domain is rejected outright by the browser, and the
    // whole point of the prefix is that a sibling subdomain can't set it.
    const rest = { ...options };
    delete rest.domain;

    return { name: `__Host-${name}`, options: { ...rest, secure: true, path: "/" } };
  }

  return { name, options };
}

/**
 * Serialize one `Set-Cookie` header value.
 *
 * The value is percent-encoded, so arbitrary payloads (a signed session
 * id, a base64url token) survive the round trip — `parseCookies()` decodes
 * symmetrically.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const prefixed = applyPrefix(name, options);
  const finalName = prefixed.name;
  const opts = prefixed.options;

  if (!VALID_COOKIE_NAME.test(finalName)) {
    throw new Error(`Invalid cookie name "${finalName}".`);
  }

  if (finalName.startsWith("__Host-")) {
    if (opts.secure !== true) {
      throw new Error("A __Host- cookie must set Secure.");
    }

    if ((opts.path ?? "/") !== "/") {
      throw new Error('A __Host- cookie must set Path="/".');
    }

    if (opts.domain !== undefined) {
      throw new Error("A __Host- cookie must not set Domain.");
    }
  }

  if (finalName.startsWith("__Secure-") && opts.secure !== true) {
    throw new Error("A __Secure- cookie must set Secure.");
  }

  let cookie = `${finalName}=${encodeURIComponent(value)}`;

  if (opts.maxAge !== undefined) {
    if (!Number.isFinite(opts.maxAge)) {
      throw new Error("Cookie maxAge must be a finite number of seconds.");
    }

    if (opts.maxAge > MAX_COOKIE_AGE_SECONDS) {
      throw new Error(
        `Cookie maxAge must not exceed 400 days (${MAX_COOKIE_AGE_SECONDS} seconds); browsers clamp anything longer.`,
      );
    }

    // A negative Max-Age is how a cookie is deleted, so it is passed
    // through as-is rather than clamped to zero.
    cookie += `; Max-Age=${Math.trunc(opts.maxAge)}`;
  }

  if (opts.domain !== undefined) {
    cookie += `; Domain=${opts.domain}`;
  }

  cookie += `; Path=${opts.path ?? "/"}`;

  if (opts.expires !== undefined) {
    cookie += `; Expires=${opts.expires.toUTCString()}`;
  }

  if (opts.httpOnly === true) {
    cookie += "; HttpOnly";
  }

  if (opts.secure === true) {
    cookie += "; Secure";
  }

  if (opts.sameSite !== undefined) {
    cookie += `; SameSite=${capitalize(opts.sameSite)}`;
  }

  if (opts.priority !== undefined) {
    cookie += `; Priority=${capitalize(opts.priority)}`;
  }

  if (opts.partitioned === true) {
    if (opts.secure !== true) {
      throw new Error("A Partitioned cookie must set Secure.");
    }

    cookie += "; Partitioned";
  }

  // A stray ";" or newline in an attribute would let a caller inject
  // additional cookie attributes (or split the header entirely).
  for (const [key, raw] of Object.entries({ domain: opts.domain, path: opts.path })) {
    if (typeof raw === "string" && /[;\r\n]/.test(raw)) {
      throw new Error(`Cookie ${key} must not contain ";", CR, or LF.`);
    }
  }

  return cookie;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Parse an inbound `Cookie` header into a name → value map, decoding
 * percent-encoding. A malformed pair is skipped rather than throwing — a
 * junk cookie from some unrelated tool must not 500 the request.
 */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = {};

  if (!header) {
    return cookies;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const name = pair.slice(0, separator).trim();

    if (name === "") {
      continue;
    }

    // First occurrence wins, matching browsers and Hono: a duplicated
    // name is an attacker's cookie-shadowing attempt as often as it is a
    // mistake, and taking the last would let a `Domain`-scoped cookie
    // from a sibling subdomain override the host's own.
    if (Object.prototype.hasOwnProperty.call(cookies, name)) {
      continue;
    }

    let value = pair.slice(separator + 1).trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value; // not valid percent-encoding; take it literally
    }
  }

  return cookies;
}

/**
 * The `Set-Cookie` header value that deletes `name`.
 *
 * Deletion is expiry: an empty value with `Max-Age=0` and a past
 * `Expires`. `Path`/`Domain` must match the cookie being deleted or the
 * browser will treat it as a different cookie and leave the original in
 * place — the single most common cookie-deletion bug.
 */
export function expiredCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, "", {
    ...options,
    maxAge: 0,
    expires: new Date(0),
  });
}

/**
 * Append `Set-Cookie` headers to a response without disturbing anything
 * already on it.
 *
 * `Headers.set()` would collapse multiple cookies into one, and copying a
 * `Headers` bag entry-by-entry has the same effect — `Set-Cookie` is the
 * one header where that matters. Returns the same response when there is
 * nothing to add, so the common path allocates nothing.
 */
export function withCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);

  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
