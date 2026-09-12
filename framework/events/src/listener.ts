import type { Application } from "@mahiframework/core";
import type { AbstractEvent } from "./event.js";

/**
 * Listeners are plain classes constructed with the Application, so they can
 * pull their own dependencies out of the container in their constructor,
 * consistent with the rest of the framework's explicit-DI style.
 *
 *   class LogTodoCreated implements Listener<TodoCreated> {
 *     constructor(private app: Application) {}
 *     handle(event: TodoCreated) { this.app.logger.info(...); }
 *   }
 */
export interface Listener<E extends AbstractEvent = AbstractEvent> {
  handle(event: E): void | Promise<void>;
}

/**
 * An inline closure listener for a class event — the lightweight
 * alternative to a full `Listener` class:
 *
 *   events.listen(TodoCreated, (event) => log(event.todoId));
 */
export type ListenerFn<E extends AbstractEvent = AbstractEvent> = (
  event: E,
) => void | Promise<void>;

export type ListenerClass<E extends AbstractEvent = AbstractEvent> = (new (
  app: Application,
) => Listener<E>) & {
  /** Optional stable name for queued-listener ids (survives minification). Falls back to the class name. */
  listenerName?: string;
};
