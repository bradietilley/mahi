import type { Redis } from "ioredis";
import type { WSContext } from "hono/ws";
import type { Connectable } from "@mahi/core";
import {
  LocalBroadcastDriver,
  DEFAULT_SOCKET_PATH,
  type LocalBroadcastDriverOptions,
} from "@mahi/broadcasting";
import type { RedisConnection } from "../redis-connection.js";

/** The Redis pub/sub channel every process publishes broadcasts to and subscribes on. */
export const DEFAULT_BROADCAST_CHANNEL = "mahi:broadcast";

/**
 * An envelope for the frames a process publishes to the shared pub/sub
 * channel. `channel` is the broadcast/presence channel the pre-encoded
 * `frame` targets; `excludeSocketId` is the originating socket a presence
 * `joining`/`leaving` should skip (so the actor isn't echoed to itself),
 * carried across the process boundary by its stable id.
 */
interface FanoutEnvelope {
  channel: string;
  frame: string;
  excludeSocketId?: string;
}

/**
 * The multi-process fix this driver is really about — the
 * direct answer to `LocalBroadcastDriver`'s "worst possible failure mode"
 * (a broadcast from process A silently never reaching a client on process
 * B). It keeps everything `LocalBroadcastDriver` already does — the
 * websocket upgrade endpoint, channel authorization, the in-memory
 * `channel -> sockets` map for *this* process's own clients — and adds one
 * thing: fanout through Redis pub/sub so every process delivers every frame
 * to its own local sockets.
 *
 * The flow, deliberately uniform across processes and across frame kinds
 * (data broadcasts AND presence `here`/`joining`/`leaving`):
 *
 *   1. `fanoutFrame()` does NOT touch local sockets directly. It
 *      `PUBLISH`es an envelope to a shared Redis channel.
 *   2. Every process (including the publisher) runs a dedicated subscriber
 *      client `SUBSCRIBE`d to that channel. On each incoming publish it
 *      calls the inherited `deliverLocalFrame()` to deliver to *its own*
 *      connected sockets.
 *
 * So a frame reaches exactly the sockets subscribed to the channel, no
 * matter which process they connected to — with no process ever delivering
 * to sockets it doesn't own. Presence rosters are likewise shared across
 * processes via a per-channel Redis set (see the `presence*` overrides).
 *
 * The pub/sub channel is namespaced by the connection's `keyPrefix` so two
 * apps sharing one Redis server never cross-deliver — pub/sub channels are
 * NOT keys, so ioredis's own `keyPrefix` does not touch them and the prefix
 * must be applied here explicitly.
 *
 * `instanceof LocalBroadcastDriver` still holds, so
 * `BroadcastServiceProvider` mounts the websocket route and
 * `injectWebSocket()`s it exactly as for the local driver — no entrypoint
 * change is needed to switch an app from `local` to `redis`.
 */
export class RedisBroadcastDriver extends LocalBroadcastDriver implements Connectable {
  private subscriber?: Redis;
  private connected = false;
  private readonly channel: string;
  private readonly presenceKeyPrefix: string;

  /**
   * Accepts either the historical positional form
   * (`new RedisBroadcastDriver(conn, channel, path)`) or an options object
   * carrying the channel-authorization + hardening settings shared with
   * the local driver.
   */
  constructor(
    private readonly connection: RedisConnection,
    channelOrOptions:
      string | (LocalBroadcastDriverOptions & { channel?: string }) = DEFAULT_BROADCAST_CHANNEL,
    path: string = DEFAULT_SOCKET_PATH,
  ) {
    const options: LocalBroadcastDriverOptions & { channel?: string } =
      typeof channelOrOptions === "string" ? { channel: channelOrOptions, path } : channelOrOptions;

    super({ ...options, path: options.path ?? path });

    this.channel = options.channel ?? DEFAULT_BROADCAST_CHANNEL;
    // ioredis's keyPrefix is NOT applied to pub/sub channels or to the raw
    // keys used with the primary client here, so derive an explicit prefix
    // to namespace both the pub/sub channel and the presence sets.
    this.presenceKeyPrefix = this.connection.keyPrefix();
  }

  /** The keyPrefix-namespaced pub/sub channel this process publishes/subscribes on. */
  private pubsubChannel(): string {
    return `${this.presenceKeyPrefix}${this.channel}`;
  }

  /**
   * Publish every outbound frame to Redis instead of delivering locally —
   * the subscriber loop (in every process, this one included) relays it
   * back to local sockets. Kept `async` and awaiting the `PUBLISH` so a
   * failure still surfaces to `BroadcastServiceProvider`'s fire-and-forget
   * error logging.
   */
  protected override async fanoutFrame(
    channel: string,
    frame: string,
    excludeSocketId?: string,
  ): Promise<void> {
    const envelope: FanoutEnvelope = { channel, frame, excludeSocketId };
    await this.connection.client().publish(this.pubsubChannel(), JSON.stringify(envelope));
  }

  /**
   * Spin up the dedicated subscriber and start relaying. Idempotent. Must
   * run after the shared `RedisConnection` has connected (its `duplicate()`
   * inherits the same options); `RedisServiceProvider.boot()` connects the
   * connection first, then this.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.connected = true;

    const subscriber = this.connection.duplicate();
    this.subscriber = subscriber;
    const pubsubChannel = this.pubsubChannel();

    subscriber.on("message", (incoming: string, raw: string) => {
      if (incoming !== pubsubChannel) {
        return;
      }

      const envelope = this.parseEnvelope(raw);

      if (!envelope) {
        return;
      }

      // Synchronous, in-process delivery — a slow/dead socket must never
      // stall the subscriber's message pump for other deliveries. An
      // escaping throw here would be an uncaught exception in the ioredis
      // event handler and, on Node's defaults, take the process down: one
      // bad socket must never crash the server. `deliverLocalFrame` already
      // guards each `send()`, but this belt-and-braces `try` covers
      // anything else in the fan-out path.
      try {
        this.deliverLocalFrame(envelope.channel, envelope.frame, envelope.excludeSocketId);
      } catch {
        // Logged inside `deliver()`; dropped here so the pump survives.
      }
    });

    await subscriber.connect();
    await subscriber.subscribe(pubsubChannel);
  }

  async disconnect(): Promise<void> {
    if (!this.subscriber) {
      return;
    }

    try {
      await this.subscriber.unsubscribe(this.pubsubChannel());
    } catch {
      // Shutdown is best-effort — see RedisConnection.disconnect().
    }
    // The subscriber was created via `connection.duplicate()`, which
    // tracks it, so `RedisConnection.disconnect()` also closes it; quitting
    // here too is harmless and makes a standalone driver teardown clean.
    try {
      await this.subscriber.quit();
    } catch {
      this.subscriber.disconnect();
    }
    this.subscriber = undefined;
    this.connected = false;
  }

  // A presence channel's membership must be visible to every process, not
  // just the one a member happens to be connected to. Each member is stored
  // in a Redis hash keyed by the channel, field = socketId, value = the JSON
  // member payload. `here` reads the whole hash; join/leave mutate one
  // field. The `joining`/`leaving` control frames themselves already fan out
  // via `fanoutFrame()` above.

  private presenceKey(channel: string): string {
    return `${this.presenceKeyPrefix}presence:${channel}`;
  }

  protected override async presenceMembers(
    channel: string,
  ): Promise<Array<{ socketId: string; member: object }>> {
    const raw = await this.connection.client().hgetall(this.presenceKey(channel));
    const members: Array<{ socketId: string; member: object }> = [];

    for (const [socketId, value] of Object.entries(raw)) {
      try {
        members.push({ socketId, member: JSON.parse(value) as object });
      } catch {
        // Skip a corrupt entry rather than failing the whole roster.
      }
    }

    return members;
  }

  protected override async presenceAdd(
    channel: string,
    _ws: WSContext,
    socketId: string,
    member: object,
  ): Promise<void> {
    await this.connection
      .client()
      .hset(this.presenceKey(channel), socketId, JSON.stringify(member));
  }

  protected override async presenceRemove(
    channel: string,
    _ws: WSContext,
    socketId?: string,
  ): Promise<object | undefined> {
    if (socketId === undefined) {
      return undefined;
    }

    const key = this.presenceKey(channel);
    const client = this.connection.client();
    const value = await client.hget(key, socketId);

    if (value === null) {
      return undefined;
    }

    await client.hdel(key, socketId);
    try {
      return JSON.parse(value) as object;
    } catch {
      return undefined;
    }
  }

  private parseEnvelope(raw: string): FanoutEnvelope | undefined {
    try {
      const parsed = JSON.parse(raw) as Partial<FanoutEnvelope>;

      if (typeof parsed.channel !== "string" || typeof parsed.frame !== "string") {
        return undefined;
      }

      return {
        channel: parsed.channel,
        frame: parsed.frame,
        excludeSocketId:
          typeof parsed.excludeSocketId === "string" ? parsed.excludeSocketId : undefined,
      };
    } catch {
      return undefined;
    }
  }
}
