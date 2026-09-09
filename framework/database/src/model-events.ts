import { app } from "@mahi/core";
import { AbstractEvent, type EventClass } from "@mahi/events";
import type { EventDispatcher } from "@mahi/events";
import { EVENTS_TOKEN } from "@mahi/events";
import type { AnyModelClass } from "./model.js";
import { afterCommitOn } from "./transaction-context.js";

/**
 * The past-tense lifecycle events that may be deferred until commit when a
 * model sets `static dispatchesEventsAfterCommit`. The `-ing` (before)
 * hooks and `retrieved` are deliberately excluded: `creating`/`saving`/etc.
 * must run inline because they mutate the attributes that are about to be
 * written, and `retrieved` is a read-side hook with no transaction to wait
 * on. Matches Laravel, whose `$afterCommit` only defers the fired-after
 * events.
 */
const DEFERRABLE_EVENTS: ReadonlySet<ModelEventName> = new Set([
  "created",
  "updated",
  "saved",
  "deleted",
  "restored",
]);

/**
 * The lifecycle events a `Model` fires, at the points documented on
 * `Model.create()`/`update()`/`delete()`/hydration and `SoftDeletes`'
 * `restore()` — mirrors Laravel's Eloquent event names
 * (`retrieved`/`creating`/`created`/`updating`/`updated`/`saving`/`saved`/
 * `deleting`/`deleted`/`restoring`/`restored`).
 *
 * `retrieved` fires once per instance hydrated from a query (the only
 * read-side hook — e.g. cache-warming/audit-on-read). `restoring`/
 * `restored` wrap `SoftDeletes.restore()`.
 */
export type ModelEventName =
  | "retrieved"
  | "creating"
  | "created"
  | "updating"
  | "updated"
  | "saving"
  | "saved"
  | "deleting"
  | "deleted"
  | "restoring"
  | "restored";

/**
 * The payload every hook (`ModelObserver` method, `Model.on()` listener,
 * `ModelLifecycleEvent`) receives for a given event.
 *
 * For instance-driven writes (`instance.save()`, `Model.create()`,
 * `Factory`) this is the model **INSTANCE** itself — so a `creating`/
 * `saving` hook can mutate attributes in place (`post.body = ...`) and
 * the change is what gets written, and a `created`/`saved` hook sees the
 * persisted instance (with any DB-generated primary key).
 *
 * The delete/restore lifecycle (`deleting`/`deleted`/`restoring`/
 * `restored`) also receives the model **INSTANCE** now — the static
 * `Model.delete()`/`SoftDeletes` load the row first (see
 * `Model.delete()`'s docstring), matching Laravel, so a listener can read
 * any column, not just the key. Only when no row matches the id (nothing
 * to load) does it fall back to a bare `{ [primaryKeyColumn]: id }`
 * object. Typed as the instance type `TModel` (falling back to a plain
 * row-shaped object) to cover both.
 */
export type ModelEventPayload<TModel = Record<string, any>> = TModel | Record<string, any>;

export type ModelEventListener<TModel = Record<string, any>> = (
  payload: ModelEventPayload<TModel>,
) => void | Promise<void>;

/**
 * The `Event.suppress()`/`isSuppressed()` name for one model's one
 * lifecycle event — `"model.{table}.{event}"` (e.g.
 * `"model.posts.created"`). `Model.withoutEvents()` suppresses the
 * `"model.{table}.*"` pattern built from this same scheme (or
 * `"model.*"` when called on the base `Model` class, which has no
 * `table`) — see `Model.withoutEvents()`'s docstring.
 */
export function modelEventName(modelClass: AnyModelClass, event: ModelEventName): string {
  return `model.${modelClass.table}.${event}`;
}

/**
 * Override the events you care about — every method is optional, so a
 * `PostObserver` interested only in `created` overrides just that one:
 *
 *   class PostObserver extends ModelObserver<PostTable> {
 *     override created(row: PostTable): void {
 *       console.log("created post", row.id);
 *     }
 *   }
 *
 *   Post.observe(PostObserver);
 *
 * Instantiated once, immediately, when `observe()` is called (no
 * constructor arguments) — same statelessness contract as
 * `@mahi/authorization`'s `Policy`: don't hold per-request state
 * on an observer instance, it's shared across every call.
 *
 * See `ModelEventPayload`'s docstring for exactly what each method
 * receives.
 */
export abstract class ModelObserver<TModel = Record<string, any>> {
  retrieved?(model: TModel): void | Promise<void>;
  creating?(model: TModel): void | Promise<void>;
  created?(model: TModel): void | Promise<void>;
  updating?(model: TModel): void | Promise<void>;
  updated?(model: TModel): void | Promise<void>;
  saving?(model: ModelEventPayload<TModel>): void | Promise<void>;
  saved?(model: ModelEventPayload<TModel>): void | Promise<void>;
  deleting?(payload: ModelEventPayload<TModel>): void | Promise<void>;
  deleted?(payload: ModelEventPayload<TModel>): void | Promise<void>;
  restoring?(payload: ModelEventPayload<TModel>): void | Promise<void>;
  restored?(payload: ModelEventPayload<TModel>): void | Promise<void>;
}

export type ModelObserverClass<TModel = Record<string, any>> = new () => ModelObserver<TModel>;

/**
 * A model's `static dispatchesEvents` map — Laravel's
 * `protected $dispatchesEvents` equivalent. Maps a lifecycle event name to
 * an `@mahi/events` `Event` subclass constructed with that event's
 * `ModelEventPayload` and dispatched through the app's `EventDispatcher`:
 *
 *   class PostCreated extends AbstractEvent {
 *     constructor(public readonly post: Post) { super(); }
 *   }
 *
 *   class Post extends Model<PostAttributes>()({ table: "posts" }) {
 *     static override dispatchesEvents: DispatchesEventsMap = {
 *       created: PostCreated,
 *     };
 *   }
 *
 * Only fires when `@mahi/events`' `EventsServiceProvider` has been
 * registered (i.e. `EVENTS_TOKEN` is bound) — a `Model` used in a test or
 * script that never bootstrapped events support simply never dispatches,
 * same graceful-no-op precedent as `@mahi/authorization`'s
 * `GateRegistry.currentUser()` no-op'ing when `AUTH_TOKEN` isn't bound.
 */
export type DispatchesEventsMap = Partial<Record<ModelEventName, EventClass<AbstractEvent>>>;

/**
 * Generic, always-fires event dispatched through the `EventDispatcher` for
 * EVERY model write (independent of `dispatchesEvents`) — the seam for
 * app-wide cross-cutting listeners (audit logging, cache invalidation,
 * search-index syncing) that want to react to "something was created",
 * not one specific model's own named event.
 *
 *   class AuditLog implements Listener<ModelCreated> {
 *     handle(event: ModelCreated) {
 *       log(`${event.model.name} created`, event.payload);
 *     }
 *   }
 */
export abstract class ModelLifecycleEvent extends AbstractEvent {
  constructor(
    public readonly model: AnyModelClass,
    public readonly payload: ModelEventPayload,
    private readonly lifecycleEvent: ModelEventName,
  ) {
    super();
  }

  /**
   * `"model.{table}.{event}"` — e.g. `"model.posts.created"` — so
   * `Post.withoutEvents()`'s `"model.posts.*"` pattern suppresses this
   * event through `EventDispatcher` too, not just the direct
   * `ModelObserver`/`on()` invocations `dispatchModelEvent()` gates
   * separately. See `modelEventName()`.
   */
  override get eventName(): string {
    return modelEventName(this.model, this.lifecycleEvent);
  }
}

export class ModelRetrieved extends ModelLifecycleEvent {}
export class ModelCreating extends ModelLifecycleEvent {}
export class ModelCreated extends ModelLifecycleEvent {}
export class ModelUpdating extends ModelLifecycleEvent {}
export class ModelUpdated extends ModelLifecycleEvent {}
export class ModelSaving extends ModelLifecycleEvent {}
export class ModelSaved extends ModelLifecycleEvent {}
export class ModelDeleting extends ModelLifecycleEvent {}
export class ModelDeleted extends ModelLifecycleEvent {}
export class ModelRestoring extends ModelLifecycleEvent {}
export class ModelRestored extends ModelLifecycleEvent {}

const LIFECYCLE_EVENT_CLASSES: Record<
  ModelEventName,
  new (
    model: AnyModelClass,
    payload: ModelEventPayload,
    event: ModelEventName,
  ) => ModelLifecycleEvent
> = {
  retrieved: ModelRetrieved,
  creating: ModelCreating,
  created: ModelCreated,
  updating: ModelUpdating,
  updated: ModelUpdated,
  saving: ModelSaving,
  saved: ModelSaved,
  deleting: ModelDeleting,
  deleted: ModelDeleted,
  restoring: ModelRestoring,
  restored: ModelRestored,
};

// Keyed by the model CLASS itself (exact identity, not `table`) — same
// dispatch-by-class-reference approach `@mahi/authorization`'s
// `GateRegistry` uses for policies, so a typo'd/renamed model can't
// silently register against the wrong table string.
const observerRegistry = new Map<AnyModelClass, ModelObserver<any>[]>();
const listenerRegistry = new Map<AnyModelClass, Map<ModelEventName, ModelEventListener<any>[]>>();

/**
 * True when at least one observer or `on()` listener is registered for
 * `modelClass`'s given `event` — a cheap guard so hot read paths
 * (`retrieved`, fired once per hydrated instance) can skip the whole
 * dispatch (including the always-on `ModelLifecycleEvent` through
 * `EventDispatcher`) when nothing is listening. Does NOT account for
 * `dispatchesEvents` or app-wide `EventDispatcher` listeners on the
 * generic `ModelRetrieved` class; `retrieved` is opt-in via
 * `observe()`/`on()`, matching its cache-warming/audit-on-read use case.
 */
export function hasModelListeners(modelClass: AnyModelClass, event: ModelEventName): boolean {
  const observers = observerRegistry.get(modelClass);

  if (observers && observers.some((o) => typeof o[event] === "function")) {
    return true;
  }

  return (listenerRegistry.get(modelClass)?.get(event)?.length ?? 0) > 0;
}

export function registerObserver(
  modelClass: AnyModelClass,
  observerClass: ModelObserverClass<any>,
): void {
  const observers = observerRegistry.get(modelClass) ?? [];
  observers.push(new observerClass());
  observerRegistry.set(modelClass, observers);
}

export function registerModelListener(
  modelClass: AnyModelClass,
  event: ModelEventName,
  listener: ModelEventListener<any>,
): void {
  const byEvent =
    listenerRegistry.get(modelClass) ?? new Map<ModelEventName, ModelEventListener<any>[]>();
  const listeners = byEvent.get(event) ?? [];
  listeners.push(listener);
  byEvent.set(event, listeners);
  listenerRegistry.set(modelClass, byEvent);
}

/**
 * Fires `event` for `modelClass` with `payload` — in order: registered
 * `ModelObserver` methods, then `Model.on()` listeners, then (if
 * `EVENTS_TOKEN` is bound) the generic `ModelLifecycleEvent` subclass,
 * then (if declared) the model's own `dispatchesEvents[event]` class.
 * Every step is awaited sequentially. No-ops entirely when
 * `modelEventName(modelClass, event)` (e.g. `"model.posts.created"`)
 * matches an active `Event.suppress()` pattern (see
 * `Model.withoutEvents()`, which delegates to `Event.suppress()` in
 * `@mahi/events` with a `"model.{table}.*"`/`"model.*"` pattern)
 * — `ModelObserver`/`on()` listeners are invoked directly rather than
 * through `EventDispatcher`, so they check the shared suppression
 * pattern list here rather than relying on `EventDispatcher.dispatch()`'s
 * own check (which only covers the `ModelLifecycleEvent`/
 * `dispatchesEvents` dispatch below).
 */
export async function dispatchModelEvent(
  modelClass: AnyModelClass,
  event: ModelEventName,
  payload: ModelEventPayload,
): Promise<void> {
  if (AbstractEvent.isSuppressed(modelEventName(modelClass, event))) {
    return;
  }

  // After-commit deferral: a model opted into `dispatchesEventsAfterCommit`
  // has its PAST-tense events held until its own connection's transaction
  // commits (dropped on rollback). The suppression check above already ran,
  // so a deferred event honours "as if never dispatched" for suppression.
  // `-ing` hooks and `retrieved` are never deferred — see DEFERRABLE_EVENTS.
  if (modelClass.dispatchesEventsAfterCommit && DEFERRABLE_EVENTS.has(event)) {
    // The ROOT (non-transactional) connection — the key the transaction
    // scope is registered under, NOT `resolveConnection()` which returns
    // the transactional instance while inside one. `afterCommitOn` runs
    // the callback immediately when this connection has no open
    // transaction, so this is safe outside a transaction too.
    const root = modelClass.rootConnection();
    await afterCommitOn(root, () => deliverModelEvent(modelClass, event, payload));

    return;
  }

  await deliverModelEvent(modelClass, event, payload);
}

/**
 * Run a model lifecycle event through observers, `on()` listeners, and the
 * `EventDispatcher` — the actual delivery, split out so the immediate and
 * after-commit-deferred paths share it. See `dispatchModelEvent()` for the
 * suppression/deferral gating that precedes it.
 */
async function deliverModelEvent(
  modelClass: AnyModelClass,
  event: ModelEventName,
  payload: ModelEventPayload,
): Promise<void> {
  const observers = observerRegistry.get(modelClass);

  if (observers) {
    for (const observer of observers) {
      const method = observer[event];

      if (typeof method === "function") {
        await method.call(observer, payload);
      }
    }
  }

  const listeners = listenerRegistry.get(modelClass)?.get(event);

  if (listeners) {
    for (const listener of listeners) {
      await listener(payload);
    }
  }

  const container = app();

  if (!container.has(EVENTS_TOKEN)) {
    return;
  }

  const dispatcher = container.make<EventDispatcher>(EVENTS_TOKEN);

  const LifecycleEventClass = LIFECYCLE_EVENT_CLASSES[event];
  await dispatcher.dispatch(new LifecycleEventClass(modelClass, payload, event));

  const EventClass = modelClass.dispatchesEvents[event];

  if (EventClass) {
    await dispatcher.dispatch(new EventClass(payload));
  }
}
