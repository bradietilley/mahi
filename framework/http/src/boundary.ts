import type { Context } from "hono";
import type { Request } from "./request.js";
import { withCookies } from "./cookies.js";
import { toWebResponse, type ResponseInput } from "./response.js";

/**
 * The single place a Mahi result becomes the response Hono will send.
 *
 * Two things have to happen here that nothing else in the stack does, and
 * both are the reason this module exists rather than being inlined at the
 * two call sites:
 *
 * 1. **Framework cookies are drained.** Mahi handlers return platform
 *    `Response` objects, which Hono does not merge its context-queued
 *    headers into. Cookies are therefore queued on the `Request` and
 *    written here — see `cookies.ts`.
 *
 * 2. **Hono's own queued headers are preserved.** Third-party Hono
 *    middleware (`hono/cors` is mounted by `HttpKernel`, and an app may
 *    add more via `raw()`) calls `c.header()` before `next()`. Hono
 *    stashes those on the context and only applies them when *it* builds
 *    the response. Returning a bare `Response` from here would drop them,
 *    so they are merged in explicitly.
 *
 * `Set-Cookie` is appended rather than set throughout: it is the one
 * header that legitimately repeats, and `Headers.set()` — or copying a
 * `Headers` bag entry by entry — silently collapses several cookies into
 * one malformed value.
 */
export async function finalizeResponse(
  c: Context,
  request: Request,
  result: ResponseInput,
): Promise<Response> {
  // Drains the queue rather than reading it: this function runs once per
  // pipeline frame (the route handler, then each enclosing global
  // middleware on the way out), and a non-destructive read would re-emit
  // every cookie at every level.
  const response = withCookies(await toWebResponse(result), request.flushQueuedCookies());
  const merged = mergeContextHeaders(c, response);

  // Publish the finished response onto the context, clearing it first.
  //
  // The clear is load-bearing, not defensive. Hono's `set res` merges the
  // PREVIOUS response's headers into the incoming one, and for
  // `Set-Cookie` that merge is a *replacement*: it deletes the incoming
  // cookies and re-appends the old bag's. Assigning directly would
  // therefore throw away every cookie this function just wrote, in favour
  // of whatever `mergeContextHeaders` already merged in — silently
  // undoing the fix. Setting `undefined` first drops the old bag so the
  // assignment is a plain store. (`Context['res']` accepts `undefined`
  // for exactly this purpose.)
  c.res = undefined;
  c.res = merged;

  return merged;
}

/**
 * Merge headers Hono queued on the context into `response`.
 *
 * Reading `c.res` is what materialises the context's pre-response header
 * bag (Hono keeps it private until then), so this both observes and
 * finalises what upstream Hono middleware asked for. The response's own
 * headers win on collision — the handler is more specific than a blanket
 * `use("*")` — except for `Set-Cookie`, where both are kept.
 *
 * Returns `response` untouched when there is nothing queued, which is the
 * overwhelmingly common case (no Hono middleware, no CORS).
 */
function mergeContextHeaders(c: Context, response: Response): Response {
  // `c.finalized` is true once something has already assigned `c.res`;
  // reading `.res` here would then hand back that earlier response rather
  // than a header bag, and merging it into ours would resurrect headers
  // the current response deliberately replaced.
  if (c.finalized) {
    return response;
  }

  let queued: Headers;
  try {
    queued = c.res.headers;
  } catch {
    // A context with no response bag to speak of (some adapters) — there
    // is simply nothing to merge.
    return response;
  }

  const queuedCookies = queued.getSetCookie();
  const queuedOthers = [...queued.entries()].filter(([key]) => key.toLowerCase() !== "set-cookie");

  if (queuedCookies.length === 0 && queuedOthers.length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);

  for (const [key, value] of queuedOthers) {
    // The response's own value wins: a handler setting `Content-Type`
    // explicitly must not be overridden by a global default.
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  for (const cookie of queuedCookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
