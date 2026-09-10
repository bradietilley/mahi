import type { Request } from "./request.js";
import { HttpError } from "./http-error.js";
import { peerAddressFrom } from "./conninfo.js";
import type { HttpPipeFn } from "./middleware/pipeline-middleware.js";

/**
 * Trusted-proxy / trusted-host middleware — the equivalent of Laravel's
 * `TrustProxies` and `TrustHosts`. Both are opt-in global pipes (installed
 * via a provider's `middleware()` hook); nothing is trusted unless the app
 * says so.
 *
 * `Request.ip()` returns the socket peer by default and never reads
 * `X-Forwarded-For` on its own — a header is client-supplied, so believing
 * it without a trust boundary means an attacker chooses their own identity
 * for rate limiting, IP allow-lists, and audit logs. `trustProxies()` IS
 * that boundary: it consults the forwarding headers only when the machine
 * that actually opened the socket is one the app has named as its proxy.
 *
 * Behind a proxy an app must register this, or `ip()` is the load
 * balancer's address for every request (correct, but useless) — that is
 * the intended failure: wrong-but-safe rather than forgeable.
 */

/** Parse an IPv4 dotted-quad into a 32-bit unsigned integer, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");

  if (parts.length !== 4) {
    return null;
  }

  let result = 0;

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }

    const n = Number(part);

    if (n > 255) {
      return null;
    }

    result = (result << 8) | n;
  }

  return result >>> 0;
}

/** Strip an IPv6-mapped IPv4 prefix (`::ffff:1.2.3.4`) down to the IPv4. */
function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);

  return mapped ? mapped[1]! : ip;
}

/**
 * True if `ip` matches `pattern`, where `pattern` is one of: `"*"` (any),
 * an exact IP, or an IPv4 `a.b.c.d/len` CIDR block. Non-IPv4 addresses
 * only match by exact string or `"*"`.
 */
export function ipMatches(ip: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }

  const normalizedIp = normalizeIp(ip);

  if (normalizedIp === pattern) {
    return true;
  }

  const slash = pattern.indexOf("/");

  if (slash === -1) {
    return false;
  }

  const base = pattern.slice(0, slash);
  const bits = Number(pattern.slice(slash + 1));

  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }

  const ipInt = ipv4ToInt(normalizedIp);
  const baseInt = ipv4ToInt(base);

  if (ipInt === null || baseInt === null) {
    return false;
  }

  if (bits === 0) {
    return true;
  }

  const mask = (0xffffffff << (32 - bits)) >>> 0;

  return (ipInt & mask) === (baseInt & mask);
}

/** The immediate TCP peer address for this request, or undefined. */
function peerAddress(request: Request): string | undefined {
  return request.peerAddress() ?? peerAddressFrom(request.raw());
}

export interface TrustProxiesOptions {
  /**
   * Also apply `X-Forwarded-Proto` / `X-Forwarded-Host` /
   * `X-Forwarded-Port` to the request's scheme and host, so `secure()` is
   * true behind a TLS terminator and generated links come out `https://`.
   *
   * On by default: an app registering `trustProxies()` is by definition
   * behind a proxy, and the overwhelmingly common deployment terminates
   * TLS there. Set `false` to resolve only the client IP.
   */
  forwardedOrigin?: boolean;
}

/**
 * Resolve the real client address from a right-to-left walk of the
 * `X-Forwarded-For` chain.
 *
 * Direction is the crux. Proxies **append**, so the chain reads
 * `<client>, <hop1>, <hop2>` with the most-recent, most-trustworthy hop
 * LAST — everything to its left was copied verbatim from whatever the
 * previous hop received, including whatever the client made up. Taking
 * the leftmost entry (as most naive implementations do) hands the
 * attacker the answer directly:
 * send `X-Forwarded-For: 1.2.3.4`, the proxy appends the real address,
 * and the leftmost entry is still the attacker's fiction.
 *
 * So: start at the peer, walk leftwards while each hop is a configured
 * proxy, and return the first address that is NOT one. That is the
 * closest hop the app can still vouch for. Symfony and Laravel do the
 * same.
 *
 * Returns the peer itself when every entry is trusted (a
 * proxy-to-proxy chain with no client address) or when there is no
 * chain at all.
 */
function resolveForwardedClient(chain: string[], peer: string, proxies: string[]): string {
  const isTrusted = (ip: string): boolean => proxies.some((p) => ipMatches(ip, p));

  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;

    if (!isTrusted(hop)) {
      return hop;
    }
  }

  return peer;
}

/** Split an `X-Forwarded-For` header into its hops, in wire order. */
function forwardedChain(header: string | undefined): string[] {
  if (!header) {
    return [];
  }

  return header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Only trust the forwarding headers when the immediate peer is a
 * configured proxy. `proxies` entries may be exact IPs, IPv4 CIDR blocks,
 * or `"*"`.
 *
 *   provider.middleware() { return [trustProxies(["10.0.0.0/8"])]; }
 *
 * `"*"` trusts whatever opened the socket, and is only correct when the
 * app is genuinely unreachable except through a proxy that **overwrites**
 * (not appends to) `X-Forwarded-For` — a platform load balancer on a
 * private network. On a host reachable directly it is equivalent to
 * having no trust boundary at all, since the "proxy" is then the
 * attacker.
 */
export function trustProxies(proxies: string[], options: TrustProxiesOptions = {}): HttpPipeFn {
  const applyOrigin = options.forwardedOrigin ?? true;

  return async (request, next) => {
    const peer = peerAddress(request);

    // Fail CLOSED when the peer is unknown. `getConnInfo` has no socket
    // to read under an in-process dispatch or a non-Node adapter, and
    // "we couldn't identify the peer" must never widen into "so trust
    // the headers" — that is precisely the state an attacker would
    // engineer if they could. `ip()` then reports undefined, which
    // downstream code treats as an unknown client.
    if (peer === undefined) {
      request.setResolvedIp(undefined);

      return next(request);
    }

    if (!proxies.some((p) => ipMatches(peer, p))) {
      // Untrusted peer: ignore every forwarding header and pin the
      // identity to the address that actually opened the socket.
      request.setResolvedIp(peer);

      return next(request);
    }

    request.setResolvedIp(
      resolveForwardedClient(forwardedChain(request.header("x-forwarded-for")), peer, proxies),
    );

    if (applyOrigin) {
      applyForwardedOrigin(request);
    }

    return next(request);
  };
}

/**
 * Apply `X-Forwarded-Proto` / `-Host` / `-Port` to the request's origin.
 *
 * Only ever called after the peer has been confirmed trusted. Each header
 * may itself be a comma-separated chain (the same append behaviour as
 * `X-Forwarded-For`); the LAST entry is the one written by the nearest
 * proxy, so that is the one used.
 */
function applyForwardedOrigin(request: Request): void {
  const scheme = lastHop(request.header("x-forwarded-proto"))?.toLowerCase();
  const forwardedHost = lastHop(request.header("x-forwarded-host"));
  const forwardedPort = lastHop(request.header("x-forwarded-port"));

  const origin: { scheme?: string; host?: string } = {};

  // Only the two schemes this framework serves. A proxy sending
  // anything else is misconfigured, and echoing it into generated links
  // would put an arbitrary attacker-influenced string in front of every
  // URL the app emits.
  if (scheme === "https" || scheme === "http") {
    origin.scheme = scheme;
  }

  if (forwardedHost) {
    const host = sanitizeHost(forwardedHost);

    if (host) {
      // A port in X-Forwarded-Host wins over X-Forwarded-Port, since it
      // is the more specific statement.
      origin.host = host.includes(":") || !forwardedPort ? host : `${host}:${forwardedPort}`;
    }
  }

  if (origin.scheme || origin.host) {
    request.setForwardedOrigin(origin);
  }
}

/** The last (nearest-proxy) entry of a possibly comma-separated header. */
function lastHop(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const parts = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts[parts.length - 1];
}

/**
 * Accept a host only if it looks like one: hostname or IP, optional
 * port, optional IPv6 brackets. Anything else is dropped rather than
 * cleaned, because this value is interpolated into generated URLs and a
 * partial clean-up of a hostile string is how header injection survives.
 */
function sanitizeHost(host: string): string | undefined {
  const trimmed = host.trim().toLowerCase();

  if (trimmed === "") {
    return undefined;
  }

  if (/^\[[0-9a-f:.]+\](:\d{1,5})?$/.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-z0-9.-]+(:\d{1,5})?$/.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}

/**
 * Validate the request `Host` header against an allow-list, 403ing
 * otherwise — guards against cache-poisoning and, more concretely,
 * password-reset-link poisoning: the URL generator prefers the live
 * request's host, so without this an attacker sends `Host: evil.example`
 * to "forgot password" and the victim receives a real, valid signed link
 * pointing at the attacker's server.
 *
 * Patterns support a leading `*.` wildcard for subdomains
 * (`"*.example.com"`); an exact host otherwise. The port is ignored.
 *
 *   provider.middleware() { return [trustHosts(["example.com", "*.example.com"])]; }
 */
export function trustHosts(patterns: string[]): HttpPipeFn {
  return async (request, next) => {
    // The EFFECTIVE host — `Request.httpHost()`, parsed from the request
    // URL and already updated by `trustProxies()` if a trusted proxy
    // sent `X-Forwarded-Host`. Reading the raw `Host` header instead
    // would check a different value than the URL generator uses (so the
    // poisoned link this middleware exists to prevent could still be
    // generated) and would 403 every in-process dispatch, since
    // `hono.request()` sets no `Host` header at all.
    const host = hostWithoutPort(request.httpHost());

    if (!host || !patterns.some((pattern) => hostMatches(host, pattern))) {
      throw HttpError.forbidden("Untrusted host.");
    }

    return next(request);
  };
}

/**
 * Strip the port from a `Host` header value, lowercased.
 *
 * Splitting on `":"` — the obvious implementation — is wrong for an
 * IPv6 literal: `[::1]:3000` splits at
 * the first colon and yields `"["`, so an IPv6 host can never match any
 * allow-list entry and is 403'd outright.
 */
export function hostWithoutPort(host: string): string {
  const trimmed = host.trim().toLowerCase();

  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");

    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }

  const colon = trimmed.indexOf(":");

  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** Match a host against an allow-list pattern (`example.com` / `*.example.com`). */
export function hostMatches(host: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase();

  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1); // ".example.com"

    return host.endsWith(suffix) || host === normalized.slice(2);
  }

  return host === normalized;
}

/**
 * Derive `trustHosts()` patterns from a configured application URL —
 * `"https://api.example.com"` becomes `["api.example.com"]`.
 *
 * Exists so the scaffolded app can register host validation from the
 * `APP_URL` it already sets, rather than asking every developer to
 * maintain a second copy of their own hostname. Returns `[]` for an
 * unparseable or absent URL, and `trustHosts([])` would reject
 * everything, so callers must skip registration on an empty result.
 */
export function hostsFromUrl(url: string | undefined): string[] {
  if (!url) {
    return [];
  }

  try {
    return [new globalThis.URL(url).hostname.toLowerCase()];
  } catch {
    return [];
  }
}
