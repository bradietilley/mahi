import { Collection, data_get } from "@mahi/core";
import type { ClientRequest } from "./client-request.js";
import { RequestFailedError } from "./errors.js";

/**
 * The outcome of a completed request — port of Laravel's
 * `Illuminate\Http\Client\Response`.
 *
 * The body is buffered once at construction (unless `stream()` or `sink()`
 * was requested) and memoised, so `body()`/`json()` are **synchronous and
 * repeatable**. A platform `Response` body is single-use; making every
 * accessor async to preserve that would poison every call site for no gain
 * on the JSON-API case this is overwhelmingly used for.
 *
 * A non-2xx status is an ordinary return value here, never a rejection —
 * `throw()` is the opt-in, mirroring `ProcessResult.throw()`.
 */
export interface ClientResponse {
  /** The HTTP status code. */
  readonly status: number;
  /** The effective URL, reflecting any redirects followed. */
  readonly url: string;
  /** Wall-clock duration of the exchange, in milliseconds. */
  readonly durationMs: number;
  /** The request that produced this response. */
  readonly request: ClientRequest;

  /** The response body as text. Throws if `stream()` was requested. */
  body(): string;
  /**
   * The body parsed as JSON, memoised. With a `key`, a dot-path lookup into
   * the parsed value (`data_get` semantics), falling back to `fallback`.
   * Throws if the body is not valid JSON.
   */
  json<T = unknown>(): T;
  json<T = unknown>(key: string, fallback?: T): T;
  /** The JSON body (or the value at `key`) wrapped in a `Collection`. */
  collect<T = unknown>(key?: string): Collection<T, number>;
  /** The raw body bytes. Throws if `stream()` was requested. */
  bytes(): Uint8Array;
  /** The unbuffered body stream. Only available when `stream()` was requested. */
  stream(): ReadableStream<Uint8Array>;

  reason(): string;
  successful(): boolean;
  ok(): boolean;
  created(): boolean;
  noContent(): boolean;
  redirect(): boolean;
  failed(): boolean;
  clientError(): boolean;
  serverError(): boolean;
  unauthorized(): boolean;
  forbidden(): boolean;
  notFound(): boolean;
  unprocessable(): boolean;
  tooManyRequests(): boolean;

  /** A header's value, or `undefined`. Multi-values are comma-joined. */
  header(name: string): string | undefined;
  /** Every header as a plain record, names lowercased. */
  headers(): Record<string, string>;
  /** Cookies parsed from every `Set-Cookie` header. No jar; see the docs. */
  cookies(): Record<string, string>;

  /** No-op on success; otherwise throws `RequestFailedError`. Returns `this`. */
  throw(callback?: (response: ClientResponse, error: RequestFailedError) => void): ClientResponse;
  throwIf(condition: boolean | ((response: ClientResponse) => boolean)): ClientResponse;
  throwUnless(condition: boolean | ((response: ClientResponse) => boolean)): ClientResponse;
  /** Throws if the status matches — **unconditional**, even on a 2xx, per Laravel. */
  throwIfStatus(status: number | ((status: number) => boolean)): ClientResponse;
  throwUnlessStatus(status: number | ((status: number) => boolean)): ClientResponse;
  /** Runs `callback` if the response failed. Never throws. */
  onError(callback: (response: ClientResponse) => void): ClientResponse;
  /** The error `throw()` would raise, or `undefined` on success. */
  toException(): RequestFailedError | undefined;

  /** The underlying platform `Response`. */
  toWebResponse(): Response;
}

/** Options controlling how the body is (or isn't) captured. */
export interface MakeClientResponseOptions {
  /** Skip buffering; expose `stream()` instead. */
  streamed?: boolean;
  /** Body bytes already read elsewhere (e.g. drained into a `sink()`). */
  buffered?: Uint8Array;
}

/**
 * Wraps a platform `Response` into a `ClientResponse`, buffering the body
 * unless `streamed` is set. Async because reading the body is.
 */
export async function makeClientResponse(
  response: Response,
  request: ClientRequest,
  durationMs: number,
  options: MakeClientResponseOptions = {},
): Promise<ClientResponse> {
  let bytes: Uint8Array | undefined;

  if (options.buffered !== undefined) {
    bytes = options.buffered;
  } else if (!options.streamed) {
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  return buildClientResponse(response, request, durationMs, bytes);
}

function buildClientResponse(
  response: Response,
  request: ClientRequest,
  durationMs: number,
  bytes: Uint8Array | undefined,
): ClientResponse {
  const status = response.status;

  let text: string | undefined;
  let parsed: unknown;
  let didParse = false;

  const requireBuffered = (): Uint8Array => {
    if (bytes === undefined) {
      throw new Error(
        "This response was requested with stream(), so its body was never buffered. " +
          "Read it via response.stream(), or drop stream() to buffer it.",
      );
    }

    return bytes;
  };

  const body = (): string => {
    if (text === undefined) {
      text = new TextDecoder().decode(requireBuffered());
    }

    return text;
  };

  const json = ((key?: string, fallback?: unknown): unknown => {
    if (!didParse) {
      const raw = body();
      try {
        parsed = raw === "" ? undefined : JSON.parse(raw);
      } catch (error) {
        const preview = raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
        throw new Error(
          `Response body is not valid JSON (${(error as Error).message}). Body: ${preview}`,
        );
      }
      didParse = true;
    }

    if (key === undefined) {
      return parsed;
    }

    if (parsed === null || typeof parsed !== "object") {
      return fallback;
    }

    return data_get(parsed as Record<string, unknown>, key as never, fallback as never);
  }) as ClientResponse["json"];

  const successful = () => status >= 200 && status < 300;
  const failed = () => !successful() && !(status >= 300 && status < 400);

  const toException = (): RequestFailedError | undefined =>
    failed() ? new RequestFailedError(clientResponse) : undefined;

  const matchesStatus = (matcher: number | ((status: number) => boolean)): boolean =>
    typeof matcher === "function" ? matcher(status) : matcher === status;

  const resolveCondition = (
    condition: boolean | ((response: ClientResponse) => boolean),
  ): boolean => (typeof condition === "function" ? condition(clientResponse) : condition);

  const clientResponse: ClientResponse = {
    status,
    // `response.url` is empty for a synthesised (stubbed) Response — fall
    // back to what we asked for, which is what the caller means by "the URL".
    url: response.url || request.url,
    durationMs,
    request,

    body,
    json,
    collect: <T>(key?: string) => {
      const value = key === undefined ? json() : json(key);

      return Collection.wrap(value as T[]) as Collection<T, number>;
    },
    bytes: () => requireBuffered(),
    stream: () => {
      if (bytes !== undefined) {
        throw new Error(
          "This response was buffered, so there is no stream to read. Call stream() on the " +
            "PendingRequest before sending to opt out of buffering.",
        );
      }

      if (response.body === null) {
        throw new Error("This response has no body to stream.");
      }

      return response.body;
    },

    reason: () => response.statusText,
    successful,
    ok: () => status === 200,
    created: () => status === 201,
    // Laravel requires both the status *and* an empty body — a 204 with a
    // body is malformed, and reporting it as "no content" hides that.
    noContent: () => status === 204 && (bytes === undefined || bytes.length === 0),
    redirect: () => status >= 300 && status < 400,
    failed,
    clientError: () => status >= 400 && status < 500,
    serverError: () => status >= 500,
    unauthorized: () => status === 401,
    forbidden: () => status === 403,
    notFound: () => status === 404,
    unprocessable: () => status === 422,
    tooManyRequests: () => status === 429,

    header: (name) => response.headers.get(name) ?? undefined,
    headers: () => Object.fromEntries(response.headers.entries()),
    cookies: () => parseCookies(response.headers),

    throw(callback) {
      const error = toException();

      if (error) {
        callback?.(clientResponse, error);
        throw error;
      }

      return clientResponse;
    },
    throwIf(condition) {
      return resolveCondition(condition) ? clientResponse.throw() : clientResponse;
    },
    throwUnless(condition) {
      return resolveCondition(condition) ? clientResponse : clientResponse.throw();
    },
    throwIfStatus(matcher) {
      // Unconditional by design: `throwIfStatus(200)` throws on a 200.
      // Laravel does the same, and narrowing it to failures would make the
      // method useless for the "this status is unexpected here" case.
      if (matchesStatus(matcher)) {
        throw new RequestFailedError(clientResponse);
      }

      return clientResponse;
    },
    throwUnlessStatus(matcher) {
      if (!matchesStatus(matcher)) {
        throw new RequestFailedError(clientResponse);
      }

      return clientResponse;
    },
    onError(callback) {
      if (failed()) {
        callback(clientResponse);
      }

      return clientResponse;
    },
    toException,

    toWebResponse: () => response,
  };

  return clientResponse;
}

/**
 * Parses `Set-Cookie` headers into a name→value record. `getSetCookie()`
 * is the only correct way to read them — `headers.get("set-cookie")`
 * comma-joins them, which is ambiguous with the commas inside an `Expires`
 * date.
 */
function parseCookies(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const name = pair.slice(0, separator).trim();

    if (name === "") {
      continue;
    }

    cookies[name] = decodeURIComponent(pair.slice(separator + 1).trim());
  }

  return cookies;
}
