import { app } from "./global-app.js";
import type { ContextRepository } from "./context.js";

/**
 * Thin facade over the always-available `Application.context` repository,
 * for call sites that would otherwise read `app().context.add(...)`.
 * Matches Laravel's `Illuminate\Support\Facades\Context`:
 *
 *   Context.add("deploy", env.DEPLOY_ID);
 *   Log.info("cache warmed");          // ... cache warmed {"deploy":"abc123"}
 *   Context.forget("deploy");
 *
 * Unlike `Log`, there's no token/provider indirection at all — the
 * repository is a plain readonly field on `Application` (like
 * `Application.logger`), so this facade needs no `LoggingServiceProvider`
 * or any other registration to work.
 *
 * Hand-written directly against `app()` rather than built on
 * `@mahi/facades`' `Facade<T>(getFacadeKey)` mixin for the same
 * reason as the `Log` facade (see `log-facade.ts`): `@mahi/facades`
 * depends on `@mahi/core`, and `ContextRepository` lives in core,
 * so importing `Facade` here would create a circular package dependency —
 * and the repository isn't container-bound anyway, so there's no facade
 * key to resolve.
 *
 * Same guidance and test-suite caveat as `Log`/`app()` itself: prefer
 * reading `app.context` off an injected `Application` where practical;
 * this facade always resolves off the *current* global `app()`, so tests
 * that construct their own isolated `Application` should use that
 * instance's `context` directly.
 */
export class Context {
  static instance(): ContextRepository {
    return app().context;
  }

  static add(key: string, value: unknown): ContextRepository;
  static add(values: Record<string, unknown>): ContextRepository;
  static add(keyOrValues: string | Record<string, unknown>, value?: unknown): ContextRepository {
    return typeof keyOrValues === "string"
      ? this.instance().add(keyOrValues, value)
      : this.instance().add(keyOrValues);
  }

  static addIf(key: string, value: unknown): ContextRepository {
    return this.instance().addIf(key, value);
  }

  static get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return this.instance().get(key, defaultValue);
  }

  static pull<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return this.instance().pull(key, defaultValue);
  }

  static has(key: string): boolean {
    return this.instance().has(key);
  }

  static missing(key: string): boolean {
    return this.instance().missing(key);
  }

  static all(): Record<string, unknown> {
    return this.instance().all();
  }

  static only(keys: string[]): Record<string, unknown> {
    return this.instance().only(keys);
  }

  static except(keys: string[]): Record<string, unknown> {
    return this.instance().except(keys);
  }

  static forget(key: string | string[]): ContextRepository {
    return this.instance().forget(key);
  }

  static push(key: string, ...values: unknown[]): ContextRepository {
    return this.instance().push(key, ...values);
  }

  static remember<T = unknown>(key: string, factory: () => T): T {
    return this.instance().remember(key, factory);
  }

  static scope<T>(callback: () => T, data: Record<string, unknown> = {}): T {
    return this.instance().scope(callback, data);
  }

  /**
   * Run `fn` inside a fresh per-request context overlay (seeded from the
   * global context), isolating everything it adds/forgets from other
   * concurrent requests. The HTTP kernel calls this for you around each
   * request; reach for it directly only in non-HTTP entry points (a queue
   * job, a CLI command, a test) that want the same per-invocation
   * isolation. See `ContextRepository.runScoped()`.
   */
  static runScoped<T>(fn: () => T): T {
    return this.instance().runScoped(fn);
  }

  static flush(): ContextRepository {
    return this.instance().flush();
  }

  static isEmpty(): boolean {
    return this.instance().isEmpty();
  }
}
