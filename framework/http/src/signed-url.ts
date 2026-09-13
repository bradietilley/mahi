import { app } from "@mahiframework/core";
import { Signer, SIGNER_TOKEN } from "@mahiframework/encryption";
import type { Request } from "./request.js";
import { HttpError } from "./http-error.js";
import type { HttpPipe } from "./middleware/pipeline-middleware.js";

/**
 * HTTP-layer wrapper over `@mahiframework/encryption`'s `Signer`, the
 * equivalent of Laravel's `UrlGenerator::signedRoute()` + the
 * `ValidateSignature` middleware. This is the path-based form, where the
 * caller passes the raw path it already has; for a NAMED route, use
 * `URL.signedRoute(name, params)` (`url-generator.ts`), which resolves
 * the pattern and then signs through this same machinery.
 *
 * A signed URL is just `path?...params...&expires=<unix>&signature=<hmac>`,
 * where the HMAC covers the path plus every query param except
 * `signature` itself, in a canonical (sorted) order so build and verify
 * agree regardless of param ordering. Because the payload doesn't need to
 * stay secret, only tamper-evident, this uses `Signer` (HMAC), not
 * `Encrypter`; key rotation is handled by `Signer.verify()`.
 *
 * Directly needed by email-verification / password-reset / one-click
 * unsubscribe / invite links.
 */

export interface SignedUrlOptions {
  /** Seconds from now until the link expires. Omit for a non-expiring signature. */
  expiresInSeconds?: number;
  /** Override the resolved `Signer` (tests). Defaults to the `SIGNER_TOKEN` singleton. */
  signer?: Signer;
  /** Absolute unix-seconds override for "now" (tests). */
  now?: number;
}

export const SIGNATURE_PARAM = "signature";
export const EXPIRES_PARAM = "expires";

/**
 * Resolves the signer and narrows it to the `"url"` purpose, so signed
 * URLs use a key derived exclusively for them. This is what stops a URL
 * signature being replayed as a session cookie (or vice versa), the two
 * consumers never share a key. Applied to explicitly-passed signers
 * too, so tests exercise the same derivation as production.
 */
export function resolveSigner(explicit?: Signer): Signer {
  return (explicit ?? app().make<Signer>(SIGNER_TOKEN)).for("url");
}

/**
 * Canonical `path?sortedQuery` string that both sign and verify hash. The
 * `signature` param is always excluded; every other param (including
 * `expires`) participates, sorted by key for a stable ordering.
 */
export function canonicalPayload(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams();

  for (const key of Object.keys(params).sort()) {
    if (key === SIGNATURE_PARAM) {
      continue;
    }

    search.set(key, params[key]!);
  }

  const query = search.toString();

  return query ? `${path}?${query}` : path;
}

/**
 * Compute just the HMAC signature for a canonical payload, shared by
 * `signedUrl()` (path-based) and the URL generator's `signedRoute()`
 * (named-route based). `Signer.sign()` returns `${payload}.${hmac}`; we
 * slice off and return only the hmac, which callers carry as a
 * `signature` query param.
 */
export function computeSignature(payload: string, signer: Signer): string {
  const signed = signer.sign(payload);

  return signed.slice(payload.length + 1);
}

/**
 * Build a signed URL string. The returned value is `path` with the
 * combined query (`params` + optional `expires`) plus a trailing
 * `signature`. Pass it straight into an email/link; verify it later with
 * `validateSignature()` (middleware) or `hasValidSignature()`.
 *
 *   const url = signedUrl("/verify-email", { id: user.id }, { expiresInSeconds: 3600 });
 */
export function signedUrl(
  path: string,
  params: Record<string, string> = {},
  options: SignedUrlOptions = {},
): string {
  const signer = resolveSigner(options.signer);
  const allParams: Record<string, string> = { ...params };

  if (options.expiresInSeconds !== undefined) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    allParams[EXPIRES_PARAM] = String(now + options.expiresInSeconds);
  }

  const payload = canonicalPayload(path, allParams);
  const signature = computeSignature(payload, signer);

  const search = new URLSearchParams(allParams);
  search.set(SIGNATURE_PARAM, signature);

  return `${path}?${search.toString()}`;
}

export interface VerifySignatureOptions {
  signer?: Signer;
  now?: number;
}

/**
 * Verify a request's signature (and expiry) without throwing, returns
 * `true`/`false`. `validateSignature()` builds on this.
 */
export function hasValidSignature(request: Request, options: VerifySignatureOptions = {}): boolean {
  const signer = resolveSigner(options.signer);

  // Rebuilt from the RAW query string, not `request.query()`. The parsed
  // bag expands bracket notation (`ids[]=1` becomes an array), so
  // canonicalising it would hash a different string than the one that
  // was signed for any link carrying a bracketed param, a signature
  // that verifies in a unit test and fails in production.
  const query: Record<string, string> = {};

  for (const [key, value] of new URLSearchParams(request.queryString())) {
    query[key] = value;
  }

  const signature = query[SIGNATURE_PARAM];

  if (!signature) {
    return false;
  }

  const expires = query[EXPIRES_PARAM];

  if (expires !== undefined) {
    const expiresAt = Number(expires);
    const now = options.now ?? Math.floor(Date.now() / 1000);

    if (!Number.isFinite(expiresAt) || now > expiresAt) {
      return false;
    }
  }

  const payload = canonicalPayload(request.path(), query);

  return signer.verify(`${payload}.${signature}`) === payload;
}

/**
 * Middleware (same factory-function shape as `throttle()`) that 403s a
 * request whose signature is missing, tampered, or expired. Attach to any
 * route reached via a `signedUrl()` link:
 *
 *   router.get("/verify-email", verifyEmail).middleware(validateSignature());
 */
export function validateSignature(options: VerifySignatureOptions = {}): HttpPipe {
  return async (request, next) => {
    if (!hasValidSignature(request, options)) {
      throw HttpError.forbidden("Invalid signature.");
    }

    return next(request);
  };
}
