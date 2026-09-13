import { app } from "@mahiframework/core";

/**
 * `Facade<T>(getFacadeKey)` is a mixin factory: it returns an (anonymous,
 * non-exported) base class with a single working `static instance(): T`,
 * which a concrete facade `extends` and adds its own hand-written static
 * methods to:
 *
 *   export class Events extends Facade<EventDispatcher>(() => EVENTS_TOKEN) {
 *     static dispatch<E extends AbstractEvent>(event: E): Promise<void> {
 *       return this.instance().dispatch(event);
 *     }
 *   }
 *
 *   await Events.dispatch(new TodoCreated(todo));
 *
 * Mixin factory, not `abstract class Facade<T> { static instance(): T
 * {...} }` with `class Events extends Facade<EventDispatcher>`, because
 * TypeScript categorically disallows a generic class's *static* side from
 * referencing that class's own type parameter (`error TS2302: Static
 * members cannot reference class type parameters`). This holds for a
 * base class's statics as seen by a subclass too, so there is no way to
 * write a single generic `Facade<T>` class with a working generic
 * `static instance(): T` for subclasses to inherit. Calling `Facade<T>`
 * as a plain function first (producing an ordinary, non-generic class
 * with `T` already baked into its `instance()` return type) sidesteps
 * this entirely, at the cost of supplying `getFacadeKey` as a constructor
 * argument to `Facade<T>(...)` rather than as an overridable static
 * method on `Events` itself (also disallowed by the same TS rule).
 *
 * This is deliberately **not** a `Proxy`/`__get`-style dynamic-forwarding
 * mechanism, even though the resulting call-site ergonomics resemble
 * Laravel's `Facade` base class:
 *
 *   - `Facade<T>(getFacadeKey)` only produces `instance()` for a single,
 *     fixed token, chosen once at the `extends Facade<T>(...)` call site,
 *     never a dynamic/computed token or a chain of resolutions (resolving
 *     one service to look up the name of a second). That kind of hidden
 *     dispatch chain is what the existing docs actually warn against, not
 *     a facade with plainly-named, statically-typed methods.
 *   - Every facade method (`Events.dispatch`, etc.) is written out by
 *     hand on the subclass with a normal static method signature, no
 *     runtime reflection, no `Proxy`, no forwarding of arbitrary
 *     properties/methods that happen to exist on the resolved instance.
 *     Renaming or removing a method on the underlying service is a
 *     normal TypeScript compile error at the facade's own method body
 *     (`this.instance().thatMethod(...)`), not a silent runtime failure,
 *     and calling a method that was never defined on the facade itself
 *     (`Events.notAMethod()`) is a compile error too. There's no dynamic
 *     forwarding for a typo to silently fall through to.
 *   - The token `getFacadeKey()` returns must already be bound via
 *     `app.singleton()`/`app.bind()` by that service's own
 *     ServiceProvider, `Facade()` never binds anything itself.
 *   - `instance()` re-resolves on every call (never cached on the facade
 *     itself). The container's own `singleton()`/`bind()` already
 *     controls whether the underlying resolution is cached.
 *   - Like `app()` itself, a facade built with this is unsafe to rely on
 *     inside the test suite when a test constructs its own isolated
 *     `Application` instance, `instance()` always calls the *current*
 *     global `app()`, exactly the same caveat `app()` itself already
 *     documents. Prefer resolving the service directly off the test's own
 *     `Application`/`TestApplication` instance instead.
 * */
export function Facade<T>(getFacadeKey: () => string) {
  return class {
    /**
     * A test double standing in for the resolved service.
     *
     * Held on the facade class rather than rebound in the container,
     * deliberately. Rebinding would also change what
     * `app().make(TOKEN)` returns for code that resolves the service
     * directly, constructor injection, a provider, another service's
     * dependency, so a swap intended to intercept `Cache.get()` would
     * silently alter unrelated call paths. Keeping it here means
     * `swap()` does exactly what it says: it changes what *this facade*
     * returns, and nothing else.
     *
     * The cost is that a swap is invisible to direct container
     * resolution, which is the right trade for a facade. But means
     * `swap()` is not a substitute for binding a fake in tests that
     * exercise the container itself.
     *
     * Public rather than `protected` because TypeScript cannot emit a
     * non-public member on an *anonymous* exported class (TS4094), and
     * this class is anonymous by necessity. See the note above on why
     * `Facade<T>` must be a mixin factory. Underscore-prefixed and
     * `@internal` to say what the modifier cannot.
     *
     * @internal
     */
    static _swapped?: T;

    static instance(): T {
      return this._swapped ?? app().make<T>(getFacadeKey());
    }

    /**
     * Replace what `instance()` returns until `restore()`.
     *
     * Accepts a partial, since a test usually cares about one or two
     * methods; anything not supplied is simply absent, and calling it
     * throws a normal "not a function" TypeError rather than silently
     * doing nothing.
     *
     *   Cache.swap({ get: async () => "canned" });
     *   // ...
     *   Cache.restore();
     *
     * Returns the double, so it can be captured inline.
     */
    static swap<S extends Partial<T>>(fake: S): S {
      this._swapped = fake as unknown as T;

      return fake;
    }

    /** Drop any `swap()`, so `instance()` resolves from the container again. */
    static restore(): void {
      this._swapped = undefined;
    }

    /** Whether a `swap()` is currently in effect. */
    static isSwapped(): boolean {
      return this._swapped !== undefined;
    }
  };
}
