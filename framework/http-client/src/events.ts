import type { ClientRequest } from "./client-request.js";
import type { ClientResponse } from "./client-response.js";
import type { ConnectionError } from "./errors.js";

/**
 * Dispatched immediately before a request leaves for the transport — port
 * of `Illuminate\Http\Client\Events\RequestSending`. Fires once **per retry
 * attempt**, matching Laravel, since retry wraps the whole pipeline.
 */
export class RequestSending {
  constructor(readonly request: ClientRequest) {}
}

/**
 * Dispatched after a response is received, whatever its status — port of
 * `Illuminate\Http\Client\Events\ResponseReceived`.
 */
export class ResponseReceived {
  constructor(
    readonly request: ClientRequest,
    readonly response: ClientResponse,
  ) {}
}

/**
 * Dispatched when the transport failed outright — port of
 * `Illuminate\Http\Client\Events\ConnectionFailed`. A 500 is a
 * `ResponseReceived`, not this.
 */
export class ConnectionFailed {
  constructor(
    readonly request: ClientRequest,
    readonly error: ConnectionError,
  ) {}
}

/** Any of the three client events. */
export type HttpClientEvent = RequestSending | ResponseReceived | ConnectionFailed;

/**
 * The slice of `@mahi/events`' dispatcher this package needs. Structural,
 * so wiring the real dispatcher costs no dependency edge — `@mahi/events`
 * is not a dependency of `@mahi/http-client`.
 */
export interface EventSink {
  dispatch(event: HttpClientEvent): unknown;
}
