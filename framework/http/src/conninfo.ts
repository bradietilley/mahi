import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The immediate TCP peer address for a request, the address that
 * actually opened the socket, which is the only part of an inbound
 * request a client cannot forge.
 *
 * Everything about client identity that carries a security consequence
 * (rate-limit keying, IP allow-lists, deciding whether `X-Forwarded-For`
 * may be believed at all) has to start here. A header cannot, because a
 * header is just something the client typed.
 *
 * Returns `undefined` rather than throwing when there is no socket to
 * read: `getConnInfo()` reaches into `c.env.incoming.socket`, which is
 * present under `@hono/node-server` and absent under `hono.request()`
 * (the in-process test dispatcher), `app.fetch()`, and every non-Node
 * adapter. Callers must treat `undefined` as "unknown peer" and fail
 * **closed**, never as "no peer, so believe the headers".
 */
export function peerAddressFrom(c: Context | undefined): string | undefined {
  if (!c) {
    return undefined;
  }

  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}
