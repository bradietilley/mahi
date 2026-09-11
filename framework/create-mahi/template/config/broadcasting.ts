import type { BroadcastConfig, BroadcastAuthConfig } from "@mahi/broadcasting";
import type { Env } from "./env.js";

interface BroadcastingConfig extends BroadcastConfig {
  auth?: BroadcastAuthConfig;
}

/**
 * The `"local"` driver runs the websocket server inside this Node process
 * and keeps its subscription table in that process's memory. That is
 * correct for a single-process deployment and *silently lossy* for any
 * other: with two or more processes, a broadcast from one never reaches
 * clients connected to another. Before scaling this app horizontally,
 * register a fanout-capable driver (Redis pub/sub, Pusher, Ably) via
 * `BroadcastManager.extend()` and point `default` at it.
 *
 * `auth` gates `private-`/`presence-` channels and hardens the socket.
 * Declare who may subscribe with `Broadcast.channel(...)` in
 * `src/providers/broadcast-channels.provider.ts`. Public (unprefixed)
 * channels stay open to any client.
 */
export function broadcastingConfig(env: Env): BroadcastingConfig {
  return {
    default: "local",
    connections: {
      local: { path: "/broadcasting/socket" },
      // Cross-process fanout via Redis pub/sub (requires @mahi/redis).
      // This is the fix for `local`'s silent single-process message loss —
      // point `default` here when scaling horizontally. Keeps the same
      // websocket endpoint (`path`); `channel` is the Redis pub/sub channel
      // every process publishes to and subscribes on.
      redis: { path: "/broadcasting/socket" },
    },
    auth: {
      // Guards tried, in order, to authenticate a connecting socket from
      // the upgrade request. `session` lets a same-origin browser's cookie
      // authenticate the websocket directly.
      guards: ["session", "token"],
      // Origin allow-list for the upgrade (cross-site websocket hijacking
      // guard). Leave undefined to allow any Origin; set it in production.
      allowedOrigins: env.APP_URL ? [env.APP_URL] : undefined,
      maxSubscriptionsPerSocket: 100,
      maxFrameBytes: 64 * 1024,
      maxBufferedBytes: 1024 * 1024,
    },
  };
}
