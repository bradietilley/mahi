import type { ClientRequest } from "./client-request.js";
import type { ResponseSequence } from "./response-sequence.js";

/**
 * A stubbed response, in any of the shapes `Http.fake()` accepts. Same
 * coercions as Laravel's `stubUrl`:
 *
 * - `number` — a status code (100-599), empty body
 * - `string` — a raw body, 200
 * - `Uint8Array` — raw bytes, 200
 * - `object` — a JSON body with `Content-Type: application/json`, 200
 * - `{ body?, status?, headers? }` — spelled out
 * - `Response` — used verbatim
 */
export type StubResponse =
  string | number | Uint8Array | Response | StubResponseSpec | Record<string, unknown> | unknown[];

/** The explicit stub form. */
export interface StubResponseSpec {
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * A stub computed from the request. Returning `undefined` **declines** —
 * matching falls through to the next registered stub, which is how a
 * handler can stub one shape of request and leave the rest alone.
 */
export type StubHandler = (
  request: ClientRequest,
) => StubResponse | undefined | Promise<StubResponse | undefined>;

/** Anything registrable as the value in a `Http.fake({ pattern: ... })` map. */
export type StubEntry = StubResponse | StubHandler | ResponseSequence;

/** Marker header identifying a synthesised stray-request response. See `Http`. */
export const STRAY_MARKER = "x-mahi-stray";

/**
 * Status used for the synthesised no-matching-stub response. 555 is
 * unassigned by IANA, is a legal `Response` status (99 and 600 throw
 * `RangeError`; 555 does not), and is unambiguously not from a real
 * server. It is converted to a `StrayRequestError` at the send boundary
 * and should never be observable as a `ClientResponse`.
 */
export const STRAY_STATUS = 555;

/**
 * The response returned when nothing matched, rather than an immediate
 * throw.
 *
 * Throwing at the miss site would unwind through user middleware — a
 * `try`/`catch` in someone's logging or auth pipe could swallow it and
 * turn a loud test failure into a silent one. A response value flows back
 * out normally, gets recorded (so `assertSent()` still works on the
 * request that had no stub, which is exactly what you want when debugging
 * why a pattern didn't match), and is raised once at a boundary we control.
 */
export function strayResponse(request: ClientRequest): Response {
  return new Response(`No matching fake for ${request.method} ${request.url}`, {
    status: STRAY_STATUS,
    headers: { [STRAY_MARKER]: "1" },
  });
}

/** Whether `response` is the synthesised stray marker. */
export function isStray(response: Response): boolean {
  return response.status === STRAY_STATUS && response.headers.get(STRAY_MARKER) === "1";
}

/**
 * Normalises any accepted stub shape into a platform `Response`.
 *
 * A `Response` stub is `clone()`d rather than returned verbatim: a body can
 * only be read once, so reusing the same registered `Response` across two
 * requests would throw `TypeError: Body is unusable` on the second. Laravel
 * sidesteps this by re-creating its PSR response per call; cloning is the
 * platform equivalent. The original stays pristine for the next match.
 */
export function normalizeStub(stub: StubResponse): Response {
  if (stub instanceof Response) {
    return stub.clone();
  }

  if (typeof stub === "number") {
    if (!Number.isInteger(stub) || stub < 100 || stub > 599) {
      throw new RangeError(
        `Http stub status must be an integer between 100 and 599, got ${stub}. ` +
          `To stub a numeric body instead, use { body: ${stub} }.`,
      );
    }

    return new Response(null, { status: stub });
  }

  if (typeof stub === "string") {
    return new Response(stub, { status: 200 });
  }

  if (stub instanceof Uint8Array) {
    return new Response(stub, { status: 200 });
  }

  if (isSpec(stub)) {
    const { body, status = 200, headers = {} } = stub;

    return buildResponse(body, status, headers);
  }

  // Any other object (or array) is a JSON body.
  return buildResponse(stub, 200, {});
}

function buildResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  const merged = new Headers(headers);

  if (body === undefined || body === null) {
    return new Response(null, { status, headers: merged });
  }

  if (typeof body === "string" || body instanceof Uint8Array) {
    return new Response(body, { status, headers: merged });
  }

  if (!merged.has("content-type")) {
    merged.set("content-type", "application/json");
  }

  return new Response(JSON.stringify(body), { status, headers: merged });
}

/**
 * Whether an object is the explicit `{ body?, status?, headers? }` form
 * rather than a JSON payload that happens to be an object.
 *
 * The discriminator is "has at least one of the three keys, *only* those
 * keys, and any `status` present is a number" — so `{ status: 201 }` is a
 * spec, while a JSON body of `{ status: "active" }` is not, because a
 * string `status` is a payload field, not an HTTP status code. That extra
 * type check is what stops a domain object whose keys happen to be a subset
 * of `body`/`status`/`headers` from being misread as a response spec (and
 * then failing deep inside `Response` construction). An object with no keys
 * at all is an empty JSON body.
 */
function isSpec(value: object): value is StubResponseSpec {
  const keys = Object.keys(value);

  if (keys.length === 0) {
    return false;
  }

  if (!keys.every((key) => key === "body" || key === "status" || key === "headers")) {
    return false;
  }

  const { status } = value as StubResponseSpec;

  return status === undefined || typeof status === "number";
}
