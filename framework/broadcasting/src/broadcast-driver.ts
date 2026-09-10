/**
 * A single message pushed out to whoever is listening on a channel.
 *
 * `event` is the wire-level event name clients match on — by default the
 * dispatched `Event` subclass's `constructor.name`, overridable per event
 * via `ShouldBroadcast.broadcastEventName()`.
 */
export interface BroadcastMessage {
  channel: string;
  event: string;
  payload: unknown;
}

/**
 * Deliberately one-directional and fire-and-forget from the framework's
 * point of view: subscription and connection management is a
 * driver-internal concern, not part of this contract.
 *
 * That's not an oversight — it's what keeps the interface honest for
 * drivers other than `local`. A future Redis driver's "broadcast" side
 * genuinely is just "publish to a channel" with no awareness of who (if
 * anyone) is subscribed; knowing about sockets is the *subscribing*
 * process's job, and in a multi-process deployment that isn't even the
 * same process. Anything socket-shaped on this interface would be
 * `LocalBroadcastDriver`'s implementation detail leaking into the
 * abstraction.
 */
export interface BroadcastDriver {
  broadcast(message: BroadcastMessage): Promise<void>;
}
