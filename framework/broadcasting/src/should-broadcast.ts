import type { AbstractEvent } from "@mahiframework/events";

/**
 * Marker interface an `Event` subclass implements to opt into being pushed
 * to connected websocket clients, mirroring Laravel's `ShouldBroadcast`.
 *
 *   export class TodoCreated extends AbstractEvent implements ShouldBroadcast {
 *     constructor(public readonly todo: TodoTable) { super(); }
 *     broadcastChannel(): string { return "todos"; }
 *   }
 *
 * The central design property here: **no dispatch call site changes.**
 * Existing `dispatcher.dispatch(new TodoCreated(todo))` calls keep working
 * untouched, and whether an event broadcasts is purely a property of the
 * event class. That's why this lives in `@mahiframework/broadcasting` rather
 * than on `Event` itself in `@mahiframework/events` — `events` has no
 * dependency on HTTP or broadcasting today and shouldn't gain one just to
 * host a marker interface (the dependency-direction rule: lower-level
 * packages never depend on higher-level ones).
 */
export interface ShouldBroadcast {
  /** The channel name clients subscribe to in order to receive this event. */
  broadcastChannel(): string;

  /**
   * The wire-level event name. Defaults to the class's `constructor.name`
   * when not implemented — implement it when the client-facing name should
   * survive minification/renaming of the class itself.
   */
  broadcastEventName?(): string;

  /**
   * The JSON payload sent to clients. Defaults to the event instance
   * itself (serialized with `JSON.stringify`) when not implemented.
   *
   * ⚠️ THE DEFAULT PUTS THE ENTIRE EVENT ON THE WIRE. If your event holds
   * a full model — `OrderShipped(order, user)` — its `toJSON()` (every
   * column, including internal ones) is what every subscriber receives.
   * Channel authorization (`private-`/`presence-` + `Broadcast.channel()`)
   * controls *who* may subscribe, but this method controls *what* they
   * get. **Implement `broadcastPayload()` to send only the fields the
   * client needs** whenever an event carries anything you wouldn't publish
   * openly — the two protections are complementary, not interchangeable.
   */
  broadcastPayload?(): unknown;
}

/**
 * Structural (not `instanceof`) check, because `ShouldBroadcast` is an
 * interface: an event opts in by having a `broadcastChannel()` method,
 * exactly as Laravel checks for its own marker interface.
 */
export function shouldBroadcast(event: unknown): event is AbstractEvent & ShouldBroadcast {
  return (
    typeof event === "object" &&
    event !== null &&
    typeof (event as ShouldBroadcast).broadcastChannel === "function"
  );
}

/**
 * Opt a broadcastable event into being pushed to clients only after the
 * enclosing `DB.transaction()` commits — Laravel's
 * `ShouldBroadcastAfterCommit`. Two equivalent forms, both read off the
 * event without changing any dispatch call site:
 *
 *   - a `static broadcastAfterCommit = true` on the event class, or
 *   - implementing this marker interface (a truthy `broadcastAfterCommit`
 *     property — mirrors Laravel's marker-interface style).
 *
 * When set and a transaction is open, the broadcast is held until commit
 * and dropped on rollback; outside a transaction it broadcasts
 * immediately. Distinct from `ShouldDispatchAfterCommit` on the event
 * itself: this defers only the *broadcast* side channel, not the event's
 * in-process listeners.
 */
export interface ShouldBroadcastAfterCommit {
  broadcastAfterCommit: boolean;
}

/**
 * Whether a broadcastable event opted into after-commit broadcasting — via
 * a `static broadcastAfterCommit` on its class or an instance
 * `broadcastAfterCommit` property (the marker-interface form).
 */
export function shouldBroadcastAfterCommit(event: AbstractEvent): boolean {
  const instanceFlag = (event as Partial<ShouldBroadcastAfterCommit>).broadcastAfterCommit;

  if (typeof instanceFlag === "boolean") {
    return instanceFlag;
  }

  const staticFlag = (event.constructor as { broadcastAfterCommit?: boolean }).broadcastAfterCommit;

  return staticFlag === true;
}

/** The `BroadcastMessage` fields a broadcastable event resolves to. */
export function broadcastMessageFor(event: AbstractEvent & ShouldBroadcast): {
  channel: string;
  event: string;
  payload: unknown;
} {
  return {
    channel: event.broadcastChannel(),
    event: event.broadcastEventName?.() ?? event.constructor.name,
    payload: event.broadcastPayload?.() ?? event,
  };
}
