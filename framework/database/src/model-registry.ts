import type { Model, AnyModelClass } from "./model.js";

/**
 * A `Model` subclass that has opted into job serialization by declaring a
 * `static morphName`. The registry only ever holds these — the constraint
 * is expressed structurally (rather than as `AnyModelClass`) so `register()`
 * can reject a class whose `morphName` is still `undefined` at the type
 * level too, not just at runtime.
 */
export type SerializableModelClass = AnyModelClass & { morphName: string };

/**
 * Maps a model's `morphName` (a stable string, safe to persist to disk and
 * survive across deploys/process restarts) to the `Model` subclass it
 * names. The mirror of `JobRegistry` for the model-serialization feature:
 * a queued payload stores `{ __model: morphName, __id }`, and a worker —
 * a *separate process* that may never have imported the model class
 * directly — resolves it back through this registry before `handle()`.
 *
 * Populated during `DatabaseServiceProvider` boot from every provider's
 * `models()` hook (same collection pattern the queue package uses for
 * `jobs()`). This central enumeration is the one required registration
 * point: nothing else forces a fresh worker to load an otherwise-unimported
 * model class.
 */
export class ModelRegistry {
  private byName = new Map<string, SerializableModelClass>();

  /**
   * Registers `modelClass` under its own `morphName`. Throws if the class
   * has no `morphName` (it hasn't opted in) or if a *different* class is
   * already registered under that name (a collision that would make
   * rehydration ambiguous). Registering the exact same class twice is a
   * harmless no-op, so a model listed by two providers doesn't error.
   */
  register(modelClass: AnyModelClass): void {
    const name = modelClass.morphName;

    if (name === undefined) {
      throw new Error(
        `Model [${modelClass.name}] cannot be registered for serialization: ` +
          `it has no static morphName. Add \`static override morphName = "..."\`.`,
      );
    }

    const existing = this.byName.get(name);

    if (existing !== undefined && existing !== modelClass) {
      throw new Error(
        `Model morphName [${name}] is already registered to [${existing.name}]; ` +
          `[${modelClass.name}] cannot reuse it.`,
      );
    }

    this.byName.set(name, modelClass as SerializableModelClass);
  }

  /** Resolves a `morphName` back to its model class, throwing if unknown. */
  resolve(name: string): SerializableModelClass {
    const cls = this.byName.get(name);

    if (cls === undefined) {
      throw new Error(
        `Model [${name}] is not registered for serialization. ` +
          `Add it to a provider's models() hook.`,
      );
    }

    return cls;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * The `morphName` for a model *instance*, or `undefined` if its class
   * hasn't opted in. Used by the codec to decide whether a value in a
   * payload is a serializable model reference.
   */
  nameFor(instance: Model): string | undefined {
    // NB: reached via the prototype's own constructor rather than
    // `instance.constructor`. The proxy's `get` trap exempts
    // `constructor` from its usual bind-to-receiver, so either works
    // today; going through the prototype is independent of that trap.
    return (Object.getPrototypeOf(instance).constructor as AnyModelClass).morphName;
  }
}
