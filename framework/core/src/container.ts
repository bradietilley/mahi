/**
 * A minimal service container: bind/singleton/instance/make, plus
 * `extend` (decorate a resolved value).
 *
 * There is deliberately no auto-wiring, no decorators, no reflect-metadata.
 * Factories resolve their own dependencies explicitly via `app.make(token)`.
 * This keeps resolution predictable and avoids TS decorator/build-tool
 * friction (emitDecoratorMetadata, esbuild/tsup compatibility, etc).
 * Contextual binding (`when($concrete)->needs($abstract)->give($impl)`)
 * is not provided — a specific consumer that needs a different
 * implementation binds an explicit distinct token instead.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A factory receives the concrete container/application instance it was
 * registered on (via `this`-typing on Container's methods), so a factory
 * registered on an `Application` receives an `Application`, not a bare
 * `Container` — no `as any` casts needed to reach `app.config`, `app.logger`,
 * etc. from inside a factory.
 */
export type Factory<T, TContainer = Container> = (container: TContainer) => T;

/** How long a binding's resolved value lives: never cached, cached forever, or cached per request scope. */
type Lifetime = "transient" | "singleton" | "scoped";

interface Binding<T = unknown> {
  factory: Factory<T, any>;
  lifetime: Lifetime;
}

export class BindingNotFoundError extends Error {
  constructor(public readonly token: string) {
    super(`Nothing bound in the container for token "${token}".`);
    this.name = "BindingNotFoundError";
  }
}

/**
 * Thrown when resolving a token requires resolving itself (directly or
 * transitively) — the message names the full cycle so the offending pair of
 * factories is obvious (`a -> b -> a`).
 */
export class CircularDependencyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Circular dependency detected while resolving: ${cycle.join(" -> ")}.`);
    this.name = "CircularDependencyError";
  }
}

type Extender = (value: unknown, container: Container) => unknown;

export class Container {
  private bindings = new Map<string, Binding>();
  private instances = new Map<string, unknown>();
  private extenders = new Map<string, Extender[]>();
  /** Tokens currently mid-resolution on this call stack — the cycle guard for `make()`. */
  private resolving: string[] = [];
  /**
   * Per-scope cache for `scoped()` bindings, isolated per async call stack
   * via `AsyncLocalStorage` — the same mechanism `ContextRepository` uses
   * for per-request context. `undefined` outside any `runScoped()` scope.
   */
  private readonly scopeStore = new AsyncLocalStorage<Map<string, unknown>>();

  /**
   * Register a factory that produces a new instance every time it is
   * resolved via `make()`.
   */
  bind<T>(token: string, factory: Factory<T, this>): void {
    this.rebind(token, { factory: factory as Factory<unknown>, lifetime: "transient" });
  }

  /**
   * Register a factory that is resolved once and cached; subsequent
   * `make()` calls return the same instance.
   */
  singleton<T>(token: string, factory: Factory<T, this>): void {
    this.rebind(token, { factory: factory as Factory<unknown>, lifetime: "singleton" });
  }

  /**
   * Register a factory resolved once *per scope* (per request, per queue
   * job — whatever `runScoped()` wraps) and cached for that scope only.
   * Resolved outside any scope it behaves like a plain transient, so it is
   * always safe to `make()`. Same `AsyncLocalStorage` mechanism as
   * `ContextRepository`'s per-request overlay.
   */
  scoped<T>(token: string, factory: Factory<T, this>): void {
    this.rebind(token, { factory: factory as Factory<unknown>, lifetime: "scoped" });
  }

  /**
   * Register an already-constructed value directly (implicitly a singleton).
   */
  instance<T>(token: string, value: T): void {
    this.bindings.set(token, { factory: () => value, lifetime: "singleton" });
    this.extenders.delete(token);
    this.instances.set(token, value);
  }

  /**
   * Replace a binding: drop any cached instance and any extenders left over
   * from a previous binding of the same token, so a re-bound token gets a
   * clean slate rather than the old decorators. Shared by
   * `bind`/`singleton`/`scoped`.
   */
  private rebind(token: string, binding: Binding): void {
    this.bindings.set(token, binding);
    this.instances.delete(token);
    this.extenders.delete(token);
  }

  /**
   * Resolve a binding by token. Throws if nothing is registered.
   */
  make<T>(token: string): T {
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    const scopeCache = this.scopeStore.getStore();

    if (scopeCache?.has(token)) {
      return scopeCache.get(token) as T;
    }

    const binding = this.bindings.get(token);

    if (!binding) {
      throw new BindingNotFoundError(token);
    }

    // Cycle guard: if `token` is already being resolved further up this
    // call stack, its factory (transitively) depends on itself — surface a
    // named cycle instead of Node's opaque `RangeError: Maximum call stack`.
    if (this.resolving.includes(token)) {
      throw new CircularDependencyError([...this.resolving, token]);
    }

    this.resolving.push(token);
    let value: unknown;
    try {
      value = binding.factory(this);

      for (const extender of this.extenders.get(token) ?? []) {
        value = extender(value, this);
      }
    } finally {
      this.resolving.pop();
    }

    if (binding.lifetime === "singleton") {
      this.instances.set(token, value);
    } else if (binding.lifetime === "scoped" && scopeCache) {
      // Only cache when a scope is actually open; outside one a scoped
      // binding resolves fresh each time (transient-like), never leaking
      // a per-request instance into the process-global container.
      scopeCache.set(token, value);
    }

    return value as T;
  }

  /**
   * Open a fresh resolution scope for the duration of `fn`: `scoped()`
   * bindings resolved inside it (across `await` boundaries) are cached and
   * shared within the scope, and discarded when it ends. Nesting starts a
   * new, independent scope. Mirrors `ContextRepository.runScoped()`.
   */
  runScoped<T>(fn: () => T): T {
    return this.scopeStore.run(new Map(), fn);
  }

  /** Whether a resolution scope (`runScoped`) is active on this call stack. */
  hasScope(): boolean {
    return this.scopeStore.getStore() !== undefined;
  }

  has(token: string): boolean {
    return this.bindings.has(token) || this.instances.has(token);
  }

  /**
   * Whether this token has actually been *built* — a singleton that has
   * been `make()`d at least once, or an `instance()` registered directly.
   * `has()` answers the different question of whether anything is bound.
   *
   * The distinction matters at shutdown: a provider tearing down what it
   * opened wants to skip a token nothing ever resolved, because
   * `make()`ing it in order to close it would construct the very pool /
   * client / handle it is trying to avoid leaving open. Always `false`
   * for a `bind()` (transient) binding, which by definition caches
   * nothing to tear down.
   */
  isResolved(token: string): boolean {
    return this.instances.has(token) || (this.scopeStore.getStore()?.has(token) ?? false);
  }

  /**
   * Decorate an already-registered binding: `callback` receives the
   * resolved value and must return the (possibly wrapped) value to use
   * instead. Applied on every `make()` of a transient binding, and once
   * (then cached) for a singleton. If the token is already resolved as
   * a singleton, the extender runs immediately against the cached
   * instance.
   */
  extend<T>(token: string, callback: (value: T, container: this) => T): void {
    const extender: Extender = (value, container) => callback(value as T, container as this);
    const existing = this.extenders.get(token) ?? [];
    existing.push(extender);
    this.extenders.set(token, existing);

    if (this.instances.has(token)) {
      this.instances.set(token, extender(this.instances.get(token), this));
    }
  }

  /**
   * Drop the binding, any cached instance/scoped instance, and any
   * extenders for `token`. After this the container has no knowledge of the
   * token at all (`has()` is `false`). Primarily a test affordance — swap a
   * binding out and re-register a fake, without leaking into the next test.
   */
  forget(token: string): void {
    this.bindings.delete(token);
    this.instances.delete(token);
    this.extenders.delete(token);
    this.scopeStore.getStore()?.delete(token);
  }

  /**
   * Forget only the cached instance for `token`, keeping the binding — the
   * next `make()` rebuilds it from the factory. Leaves scoped/transient
   * bindings (which cache nothing globally) untouched.
   */
  forgetInstance(token: string): void {
    this.instances.delete(token);
    this.scopeStore.getStore()?.delete(token);
  }

  /**
   * Reset the container to empty: all bindings, instances and
   * extenders. A `runScoped()` scope's own cache is left to be discarded
   * with the scope. Test-suite teardown / a full application restart.
   */
  flush(): void {
    this.bindings.clear();
    this.instances.clear();
    this.extenders.clear();
    this.scopeStore.getStore()?.clear();
  }
}
