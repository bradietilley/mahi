/**
 * `@mahiframework/broadcasting`, push already-dispatched application events
 * to connected websocket clients, scoped to named channels.
 *
 * An event opts in by implementing `ShouldBroadcast`; no dispatch call
 * site changes. See `should-broadcast.ts`.
 *
 * ⚠️ THE ONE THING TO READ BEFORE USING THIS: the shipped `"local"` driver
 * keeps its subscription table in the memory of a single Node process, so
 * broadcasts only reach clients connected to *that* process. It is correct
 * for a single-process deployment and silently lossy for any other. See
 * `LocalBroadcastDriver`'s docstring for the full explanation and the
 * `BroadcastManager.extend("redis", ...)` escape hatch.
 */

export type { BroadcastDriver, BroadcastMessage } from "./broadcast-driver.js";

export {
  LocalBroadcastDriver,
  DEFAULT_SOCKET_PATH,
  DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_BUFFERED_BYTES,
} from "./drivers/local-broadcast-driver.js";
export type {
  LocalBroadcastDriverOptions,
  BroadcastLogger,
} from "./drivers/local-broadcast-driver.js";

export { BroadcastManager } from "./broadcast-manager.js";
export type { BroadcastConfig, WebSocketInjectable } from "./broadcast-manager.js";

export {
  shouldBroadcast,
  broadcastMessageFor,
  shouldBroadcastAfterCommit,
} from "./should-broadcast.js";
export type { ShouldBroadcast, ShouldBroadcastAfterCommit } from "./should-broadcast.js";

export {
  PRIVATE_PREFIX,
  PRESENCE_PREFIX,
  isPrivateChannel,
  isPresenceChannel,
  isProtectedChannel,
  normalizeChannelName,
} from "./channel-name.js";

export { ChannelRegistry } from "./channel-registry.js";
export type {
  ChannelAuthorizationCallback,
  ChannelAuthorizationResult,
  ChannelAuthorization,
} from "./channel-registry.js";

export type { BroadcastAuthorizer, SubscribeAuthorization } from "./broadcast-authorizer.js";

export { Broadcast } from "./broadcast-facade.js";

export {
  BroadcastServiceProvider,
  BROADCAST_TOKEN,
  CHANNEL_REGISTRY_TOKEN,
  resolveBroadcastDriverOptions,
} from "./broadcast-service-provider.js";
export type { LocalConnectionConfig, BroadcastAuthConfig } from "./broadcast-service-provider.js";

export { ContainerBroadcastAuthorizer, BROADCAST_SIGNER_PURPOSE } from "./container-authorizer.js";
export type { SignerLike } from "./container-authorizer.js";
