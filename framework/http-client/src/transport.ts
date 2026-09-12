/**
 * The single seam through which every outbound request passes, and
 * therefore the single place fakes, `undici`'s `MockAgent`, proxies, and
 * record/replay hook in. `PendingRequest.withTransport()` swaps it for one
 * request; `Http.fake()` swaps a module-level default.
 *
 * Takes both a `Request` **and** the `RequestInit` that built it, rather
 * than a `Request` alone: non-standard init keys (`dispatcher`, `duplex`)
 * cannot round-trip through a `Request` object, so `withFetchOptions()`
 * values have to survive alongside it.
 *
 * The init is the same `RequestInit & Record<string, unknown>` that
 * `withFetchOptions()` accepts and `send()` actually passes — carrying the
 * index signature is the whole point of the parameter, so a transport that
 * reads `init.dispatcher` typechecks without a cast.
 */
export type Transport = (
  request: Request,
  init: RequestInit & Record<string, unknown>,
) => Promise<Response>;

/** The default `Transport`: the platform `fetch` (undici-backed on Node 26). */
export const fetchTransport: Transport = (request, init) => fetch(request, init);
