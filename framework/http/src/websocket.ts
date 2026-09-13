import type { NodeWebSocket } from "@hono/node-ws";
import type { WSContext, WSEvents } from "hono/ws";

/**
 * Re-exported so an application can type a websocket handler without taking a
 * direct dependency on `hono`, which it otherwise has no reason to have, and
 * which would be a second copy of a version this package already pins.
 */
export type { WSContext, WSEvents };

/**
 * The websocket upgrade helper for an application's HTTP server.
 *
 * ---------------------------------------------------------------------
 * THERE IS EXACTLY ONE OF THESE PER SERVER, AND THAT IS NOT A STYLE RULE.
 * ---------------------------------------------------------------------
 * `@hono/node-ws`'s `createNodeWebSocket()` builds a `WebSocketServer` and
 * a `waiterMap` keyed by the incoming request, and `injectWebSocket()`
 * attaches an `upgrade` listener to the Node server. Node calls EVERY
 * `upgrade` listener for EVERY upgrade, so a second helper does not
 * quietly handle only its own routes. It handles all of them, finds no
 * waiter for a request the first helper already claimed, and runs its
 * "reject this upgrade" branch:
 *
 *   socket.end(`HTTP/1.1 ${response.status} ...`)
 *
 * on a socket the winning helper has already taken over. That throws
 * `ERR_STREAM_WRITE_AFTER_END` from the server's `error` event with no
 * handler on it, which in Node is an **unhandled 'error' event and takes
 * the process down**. Measured, not inferred: two helpers on one server
 * crash on the first connection to either endpoint.
 *
 * So the helper is owned by `HttpKernel`, the one object that already
 * owns both the Hono instance and, through `listenHttpServer()`, the Node
 * server. Anything wanting a websocket route asks the kernel for it and
 * registers as many routes as it likes on the one helper, which is
 * supported and tested.
 *
 * `upgradeWebSocket` is the part that is safe to have many of, call it
 * once per route. `injectWebSocket` is the part that is not. It is
 * called once, by `listenHttpServer()`, and an application should not
 * need to call it at all.
 *
 * Structurally `@hono/node-ws`'s `NodeWebSocket` minus its `wss`, which
 * is an implementation detail no consumer should depend on. The two
 * members are `Pick`ed from that interface rather than re-declared so
 * they cannot drift from it: `upgradeWebSocket` is a heavily
 * parameterised overloaded type, and a hand-written lookalike is not
 * assignable to it, a re-declaration compiles here and then fails at
 * every call site with "none of those signatures are compatible".
 */
export type WebSocketSupport = Pick<NodeWebSocket, "upgradeWebSocket" | "injectWebSocket">;
