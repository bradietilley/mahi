import type { PipeFn } from "@mahiframework/pipeline";
import { ClientRequest, currentClientRequest } from "./client-request.js";
import type { ClientResponse } from "./client-response.js";
import { StrayRequestError } from "./errors.js";
import type { EventSink } from "./events.js";
import type { HttpClientConfig, HttpClientOptions } from "./http-client-config.js";
import { urlMatch, wildcardMatch } from "./matching.js";
import { PendingRequest, type SendObserver } from "./pending-request.js";
import { ResponseSequence } from "./response-sequence.js";
import { isStray, normalizeStub, strayResponse, type StubEntry, type StubHandler } from "./stub.js";
import { fetchTransport, type Transport } from "./transport.js";

/** One recorded exchange: the request, and the response if one came back. */
export type RecordedPair = readonly [ClientRequest, ClientResponse | undefined];

/** A registered stub: a URL pattern and what to answer with. */
interface RegisteredStub {
  pattern: string;
  entry: StubEntry;
}

/**
 * Owns the configuration and — while faking — the stub registry and
 * recording tape shared by every `PendingRequest` it creates.
 *
 * `Http` is a thin static surface over a module-level instance of this;
 * `HttpClientServiceProvider` binds a config-carrying one in the
 * container. Both exist so the package works standalone (`import { Http }`)
 * while an application can still configure base URLs, global middleware,
 * and event dispatch.
 */
export class HttpClientFactory {
  private stubs: RegisteredStub[] | undefined;
  private recordings: RecordedPair[] = [];
  private strayAllowList: string[] | undefined;
  private globalMiddleware: Array<PipeFn<ClientRequest, ClientResponse>> = [];
  private events?: EventSink;

  constructor(private readonly config: HttpClientConfig = {}) {}

  /**
   * A `PendingRequest` carrying the factory's defaults — global options,
   * global middleware, the fake transport when faking, and the event sink.
   * Every `Http.*` verb starts here.
   */
  request(options: HttpClientOptions = {}): PendingRequest {
    const merged: HttpClientOptions = {
      baseUrl: options.baseUrl ?? this.config.baseUrl,
      timeout: options.timeout ?? this.config.timeout,
      headers: { ...this.config.headers, ...options.headers },
    };

    let pending = new PendingRequest()
      .withTransport(this.transport())
      .withEvents(this.events)
      .withObserver(this.observer());

    if (merged.baseUrl !== undefined) {
      pending = pending.baseUrl(merged.baseUrl);
    }

    if (merged.timeout !== undefined) {
      pending = pending.timeout(merged.timeout);
    }

    if (merged.headers && Object.keys(merged.headers).length > 0) {
      pending = pending.withHeaders(merged.headers);
    }

    // Global middleware is registered first so it sits outermost, with
    // per-request middleware inside it and the transport innermost.
    for (const pipe of this.globalMiddleware) {
      pending = pending.withMiddleware(pipe);
    }

    return pending;
  }

  /** A `PendingRequest` preconfigured from `clients.<name>` in the config. */
  client(name: string): PendingRequest {
    const options = this.config.clients?.[name];

    if (!options) {
      const available = Object.keys(this.config.clients ?? {});
      throw new Error(
        `No HTTP client named "${name}" is configured. ` +
          `Available: ${available.length === 0 ? "(none)" : available.join(", ")}.`,
      );
    }

    return this.request(options);
  }

  /** Add a pipe to every request this factory creates. */
  withGlobalMiddleware(pipe: PipeFn<ClientRequest, ClientResponse>): void {
    this.globalMiddleware.push(pipe);
  }

  /** Wire the event dispatcher. Called by the provider in `boot()`. */
  setEvents(events: EventSink | undefined): void {
    this.events = events;
  }

  /**
   * Intercept every request. `stubs` maps URL patterns to responses;
   * a bare handler stubs everything; no argument answers 200/empty.
   *
   * **Replaces** rather than accumulating, unlike Laravel's `->merge()`,
   * where two `fake()` calls in one test compose in a surprising order.
   */
  fake(stubs?: Record<string, StubEntry> | StubHandler): void {
    this.recordings = [];
    this.strayAllowList = undefined;

    if (stubs === undefined) {
      this.stubs = [{ pattern: "*", entry: { status: 200 } }];
    } else if (typeof stubs === "function") {
      this.stubs = [{ pattern: "*", entry: stubs }];
    } else {
      this.stubs = Object.entries(stubs).map(([pattern, entry]) => ({ pattern, entry }));
    }
  }

  isFaked(): boolean {
    return this.stubs !== undefined;
  }

  /**
   * Let unmatched requests reach the real network — Laravel's default,
   * which this package deliberately inverts. With `patterns`, only URLs
   * matching one of them are allowed through.
   *
   * Allow-list patterns match on the bare pattern, **without** the implicit
   * leading `*` stub patterns get: an explicit escape from the stray guard
   * is worth spelling out in full. Matches Laravel's `isAllowedRequestUrl`.
   */
  allowStrayRequests(patterns?: string[]): void {
    this.strayAllowList = patterns ?? [];
  }

  /** Whether a stray request to `url` may proceed to the network. */
  private strayAllowed(url: string): boolean {
    if (this.strayAllowList === undefined) {
      return false;
    }

    if (this.strayAllowList.length === 0) {
      return true;
    }

    return this.strayAllowList.some((pattern) => wildcardMatch(pattern, url));
  }

  /** Clears stubs, recordings, and the stray guard. The `afterEach` hook. */
  restore(): void {
    this.stubs = undefined;
    this.recordings = [];
    this.strayAllowList = undefined;
  }

  /** Every recorded exchange, oldest first, optionally filtered. */
  recorded(
    filter?: (request: ClientRequest, response: ClientResponse | undefined) => boolean,
  ): readonly RecordedPair[] {
    if (!filter) {
      return this.recordings;
    }

    return this.recordings.filter(([request, response]) => filter(request, response));
  }

  /** Records an exchange. Called by the recording middleware. */
  private record(pair: RecordedPair): void {
    this.recordings.push(pair);
  }

  /** Asserts every registered sequence was fully drained. */
  assertSequencesAreEmpty(): void {
    for (const { pattern, entry } of this.stubs ?? []) {
      if (entry instanceof ResponseSequence && !entry.isEmpty()) {
        throw new Error(
          `Expected the response sequence for "${pattern}" to be empty, but it is not.`,
        );
      }
    }
  }

  /**
   * The transport handed to every `PendingRequest`: the stub resolver
   * while faking, the plain `fetch` transport otherwise.
   *
   * The stub is matched against the `ClientRequest` the `PendingRequest`
   * passes alongside the platform `Request`, not a reconstruction of it —
   * a `Request` has lost `data()` (the payload object as passed to
   * `post()`), which is exactly what a stub handler wants to branch on.
   */
  private transport(): Transport {
    return async (request, init) => {
      if (!this.isFaked()) {
        return fetchTransport(request, init);
      }

      const clientRequest =
        currentClientRequest.get(request) ??
        new ClientRequest({ method: request.method, url: request.url, headers: request.headers });

      const stubbed = await this.resolveStub(clientRequest);

      if (stubbed) {
        return stubbed;
      }

      if (this.strayAllowed(request.url)) {
        return fetchTransport(request, init);
      }

      return strayResponse(clientRequest);
    };
  }

  /** First matching stub wins; a handler returning `undefined` declines. */
  private async resolveStub(request: ClientRequest): Promise<Response | undefined> {
    for (const { pattern, entry } of this.stubs ?? []) {
      if (!urlMatch(pattern, request.url)) {
        continue;
      }

      if (entry instanceof ResponseSequence) {
        const next = await entry.next();

        if (typeof next === "object" && "connectionFailure" in next) {
          throw new Error(next.connectionFailure);
        }

        return next;
      }

      if (typeof entry === "function") {
        const result = await entry(request);

        if (result === undefined) {
          continue;
        }

        return normalizeStub(result);
      }

      return normalizeStub(entry);
    }

    return undefined;
  }

  /**
   * The recording and stray-conversion hooks handed to every
   * `PendingRequest` this factory creates.
   *
   * The stray conversion happens here, at the outermost send boundary,
   * rather than where the miss occurred — see `strayResponse()` for why a
   * response value is carried back out instead of a throw.
   */
  private observer(): SendObserver {
    return {
      record: (request, response) => {
        if (this.isFaked()) {
          this.record([request, response] as RecordedPair);
        }
      },
      inspect: (response) => {
        if (this.isFaked() && isStray(response.toWebResponse())) {
          throw new StrayRequestError(response.request);
        }

        return response;
      },
    };
  }
}
