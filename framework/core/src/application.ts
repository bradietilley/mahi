import { Container } from "./container.js";
import { ConfigRepository } from "./config-repository.js";
import { ContextRepository } from "./context.js";
import type { Logger } from "./logger.js";
import { ConsoleLogger } from "./logger.js";
import type { ServiceProvider } from "./service-provider.js";
import { clearCurrentApp, setCurrentApp } from "./global-app.js";

export type ServiceProviderClass = new (app: Application) => ServiceProvider;

/**
 * Normalize an environment name to the framework's Laravel-style
 * vocabulary. `NODE_ENV`'s Node-idiomatic `"development"` maps to
 * `"local"`, so an app that only sets `NODE_ENV=development` still gets
 * `isLocal() === true`. Everything else is returned unchanged.
 */
function normalizeEnvironment(name: string): string {
  return name === "development" ? "local" : name;
}

/**
 * The Application is the root of everything: a Container that also owns
 * config, logging, and the provider boot lifecycle.
 *
 * Boot sequence:
 *   1. Providers are instantiated in the order they're registered.
 *   2. `register()` is called on every provider (awaited if async).
 *      Providers should only bind their own services here — other
 *      providers' services are not guaranteed to exist yet.
 *   3. `boot()` is called on every provider, SEQUENTIALLY (not
 *      Promise.all), in registration order. By the time a given
 *      provider's boot() runs, every provider before it in the list has
 *      fully completed its own boot() (including any async connection
 *      warm-up it chose to await). This is a deliberate ordering
 *      guarantee, not an implementation detail.
 *
 * Shutdown is the mirror image: `terminate()` runs `terminating()`
 * callbacks and then every provider's `shutdown()` hook in REVERSE
 * registration order, so a provider tears down before the providers it
 * depends on do.
 */
export class Application extends Container {
  readonly config = new ConfigRepository();

  /**
   * Global log context, always available and zero-config (same design as
   * `logger` below) — data added here is appended to every log line by
   * `formatLogLine()`. Usually reached through the `Context` facade; see
   * `ContextRepository`'s docstring for the process-global caveat.
   */
  readonly context = new ContextRepository();

  /**
   * Constructed with `this` as its `LogSource` (safe in a field
   * initializer: `ConsoleLogger` only stores the reference and reads
   * `environment()`/`context` lazily at log time), so even the
   * zero-config fallback logger renders full
   * `[timestamp] env.LEVEL: message {context} {globalContext}` lines.
   */
  readonly logger: Logger = new ConsoleLogger(this);

  private providerClasses: ServiceProviderClass[] = [];
  private providers: ServiceProvider[] = [];
  private booted = false;

  /**
   * The in-flight `bootstrap()` run, if any. Two concurrent calls share
   * one run rather than both sailing past a `booted` flag that is only
   * set at the very end — which booted every provider twice.
   */
  private bootstrapping?: Promise<void>;

  /** Whether every provider has been instantiated and `register()`ed. */
  private registered = false;

  /** How many providers have completed `boot()` — see `runBootstrap()`. */
  private bootedCount = 0;

  private terminatingCallbacks: Array<() => void | Promise<void>> = [];
  private terminated = false;

  /**
   * The current environment name. Seeded from `APP_ENV`, falling back to
   * `NODE_ENV`, then to `"production"` when neither is set (fail-safe: an
   * unknown environment is treated as production, so `isProduction()`-gated
   * safety checks default to "on" rather than off — matching Laravel's
   * `APP_ENV` default of `"production"`). `NODE_ENV`'s Node-idiomatic
   * `"development"` is normalized to Laravel's `"local"`, so `isLocal()` is
   * true under `NODE_ENV=development`. An app that validates its env through
   * a stricter schema can pin this explicitly via `useEnvironment(...)`
   * right after constructing the Application.
   */
  private environmentName: string = normalizeEnvironment(
    process.env.APP_ENV ?? process.env.NODE_ENV ?? "production",
  );

  /**
   * Queue a provider class to be instantiated and run through
   * register()/boot() during `bootstrap()`.
   */
  register(providerClass: ServiceProviderClass): void {
    this.providerClasses.push(providerClass);
  }

  /**
   * Run the full register -> boot lifecycle for every queued provider.
   * A call once the app is booted is a no-op; a call after a *failed*
   * bootstrap resumes from the provider that threw (see `runBootstrap()`).
   *
   * Concurrent calls share the *same* run rather than each starting one:
   * `booted` is only true once every provider has booted, so without the
   * shared promise two callers racing here would both pass the guard and
   * boot every provider twice — double-binding singletons, mounting routes
   * twice, opening two pools. Whoever calls second awaits the first call's
   * promise.
   */
  async bootstrap(): Promise<void> {
    if (this.booted) {
      return;
    }

    this.bootstrapping ??= this.runBootstrap().finally(() => {
      this.bootstrapping = undefined;
    });

    return this.bootstrapping;
  }

  /**
   * The actual lifecycle, resumable at the point it last failed.
   *
   * A provider whose `boot()` throws leaves the app un-booted, and a
   * caller may reasonably retry (fix a connection, call `bootstrap()`
   * again). Re-running `register()` on that retry would re-instantiate
   * every provider and re-bind every singleton — an app that looked
   * recovered but had two of everything. `registered`/`bootedCount` make
   * the retry pick up from the provider that failed instead.
   */
  private async runBootstrap(): Promise<void> {
    // The global is set BEFORE providers run, not after, so `app()` and
    // every facade built on it (`Log`, `Events`, `Context`, …) work
    // inside `register()`/`boot()`, where they are most useful. Matches
    // Laravel binding the container globally ahead of provider
    // registration.
    setCurrentApp(this);

    if (!this.registered) {
      this.providers = this.providerClasses.map((ProviderClass) => new ProviderClass(this));

      for (const provider of this.providers) {
        await provider.register?.();
      }

      this.registered = true;
    }

    while (this.bootedCount < this.providers.length) {
      const provider = this.providers[this.bootedCount];
      await provider?.boot?.();
      this.bootedCount += 1;
    }

    this.booted = true;
  }

  isBooted(): boolean {
    return this.booted;
  }

  /**
   * Register a callback to run when the application terminates, before
   * any provider's `shutdown()`. Callbacks run in REVERSE registration
   * order (LIFO), so a callback registered later — and therefore
   * potentially depending on what an earlier one set up — unwinds first.
   *
   *   app.terminating(async () => { await report.flush(); });
   *
   * Returns `this` for chaining. A throwing callback is logged and does
   * not stop the rest of termination: shutdown is best-effort by
   * definition, and one broken teardown must not strand a database pool.
   */
  terminating(callback: () => void | Promise<void>): this {
    this.terminatingCallbacks.push(callback);

    return this;
  }

  /**
   * Tear the application down: run `terminating()` callbacks (LIFO), then
   * every provider's `shutdown()` hook in reverse registration order.
   *
   * This is what closes database pools, quits Redis clients, and
   * generally releases the handles that keep Node's event loop alive — a
   * process that boots an app with a MySQL or Redis connection and never
   * terminates it does not exit, it hangs until something kills it.
   * Every entrypoint the framework ships calls this
   * (`ConsoleKernel.run()`'s `finally`, `artisan serve`, the scaffolded
   * `bin/server.ts` signal handler, `createTestApplication().cleanup()`).
   *
   * Idempotent, and never throws: each hook is awaited inside its own
   * try/catch and failures are logged. There is no un-terminate — an
   * application that has been terminated should be discarded.
   */
  async terminate(): Promise<void> {
    if (this.terminated) {
      return;
    }

    this.terminated = true;

    for (const callback of [...this.terminatingCallbacks].reverse()) {
      try {
        await callback();
      } catch (error) {
        this.logger.error("Application: a terminating callback threw during shutdown.", { error });
      }
    }

    for (const provider of [...this.providers].reverse()) {
      try {
        await provider.shutdown?.();
      } catch (error) {
        this.logger.error(`Application: ${provider.constructor.name}.shutdown() threw.`, { error });
      }
    }

    // Only if this app is the current one: a test file that terminates
    // its own app shouldn't blank out another's global, and leaving a
    // terminated app reachable through `app()` hands out an application
    // whose connections are closed.
    clearCurrentApp(this);
  }

  /** True once `terminate()` has run. */
  isTerminated(): boolean {
    return this.terminated;
  }

  /**
   * Override the environment name (see `environmentName`). Call this right
   * after `new Application()` with the value from your validated env schema
   * (e.g. `app.useEnvironment(env.NODE_ENV)`), so `environment()`/
   * `isProduction()`/`isLocal()` reflect the same value the rest of the
   * app validated against rather than a raw `process.env` read. Returns
   * `this` for chaining.
   */
  useEnvironment(name: string): this {
    this.environmentName = normalizeEnvironment(name);

    return this;
  }

  /**
   * With no arguments: returns the current environment name (e.g.
   * `"local"`, `"production"`, `"test"`).
   *
   * With one or more arguments: returns `true` if the current environment
   * matches any of the given names — `app.environment("local", "test")`.
   * Matches Laravel's `Application::environment(...)` overload exactly.
   */
  environment(): string;
  environment(...names: string[]): boolean;
  environment(...names: string[]): string | boolean {
    if (names.length === 0) {
      return this.environmentName;
    }

    return names.includes(this.environmentName);
  }

  /** True when the environment is `"local"` — Laravel's `isLocal()`. */
  isLocal(): boolean {
    return this.environmentName === "local";
  }

  /** True when the environment is `"production"` — Laravel's `isProduction()`. */
  isProduction(): boolean {
    return this.environmentName === "production";
  }

  getProviders(): readonly ServiceProvider[] {
    return this.providers;
  }
}
