/**
 * Throw from within a route handler to produce a structured JSON error
 * response with the given status code, instead of a generic 500.
 *
 * `headers` exists because several statuses are not merely *allowed* to
 * carry a header, they are **defined by it**: a 401 without
 * `WWW-Authenticate`, a 405 without `Allow`, and a 429 without
 * `Retry-After` are all incomplete responses per RFC 9110, and a client
 * that behaves correctly (a browser's auth prompt, an SDK's retry
 * backoff) has nothing to act on. Without somewhere to hang them, a
 * handler that wants those headers has to bypass `HttpError` entirely and
 * hand-build a response, losing the shared JSON envelope.
 */
export class HttpError extends Error {
  /**
   * Headers merged onto the error response by the central error handler.
   * Empty for the common case; populated by the factories that have a
   * mandatory header (`methodNotAllowed`, `unauthorized`,
   * `tooManyRequests`) or via `withHeaders()`.
   */
  public headers: Record<string, string> = {};

  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  /**
   * Attach response headers (fluent). Merges, so repeated calls
   * accumulate and a later call wins on a repeated key.
   *
   *   throw HttpError.unauthorized().withHeaders({ "WWW-Authenticate": 'Bearer realm="api"' });
   */
  withHeaders(headers: Record<string, string>): this {
    Object.assign(this.headers, headers);

    return this;
  }

  static notFound(message = "Not Found"): HttpError {
    return new HttpError(404, message);
  }

  static badRequest(message = "Bad Request", details?: unknown): HttpError {
    return new HttpError(400, message, details);
  }

  /**
   * 401, the request lacks valid credentials. Distinct from
   * `forbidden()` (403), which means "we know who you are, and you may
   * not do this". Authenticating differently could resolve a 401; it
   * will never resolve a 403.
   */
  static unauthorized(message = "Unauthorized"): HttpError {
    return new HttpError(401, message);
  }

  static forbidden(message = "Forbidden"): HttpError {
    return new HttpError(403, message);
  }

  /**
   * 405. The path exists but not for this method. `Allow` is
   * **mandatory** on a 405 (RFC 9110 §15.5.6) and is the only way the
   * client learns what it should have sent, so it is a required
   * parameter rather than an optional extra.
   */
  static methodNotAllowed(allow: string[], message = "Method Not Allowed"): HttpError {
    return new HttpError(405, message).withHeaders({ Allow: allow.join(", ") });
  }

  /** 413, the request body exceeded the configured limit. */
  static payloadTooLarge(message = "Payload Too Large"): HttpError {
    return new HttpError(413, message);
  }

  /**
   * 429, rate limited. `retryAfterSeconds` sets `Retry-After`; omit it
   * only when the caller genuinely cannot say when to retry.
   */
  static tooManyRequests(message = "Too Many Requests", retryAfterSeconds?: number): HttpError {
    const error = new HttpError(429, message);

    if (retryAfterSeconds !== undefined) {
      error.withHeaders({ "Retry-After": String(retryAfterSeconds) });
    }

    return error;
  }
}
