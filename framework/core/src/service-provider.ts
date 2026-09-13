import type { Application } from "./application.js";

/**
 * Augmented via TypeScript declaration merging by whichever framework
 * packages are imported. `@mahiframework/core` itself declares no hooks here.
 * This keeps core free of any dependency on http/cli/events. e.g.:
 *
 *   // in @mahiframework/http
 *   declare module "@mahiframework/core" {
 *     interface ProviderHooks {
 *       routes?(router: Router): void;
 *     }
 *   }
 *
 * An app that imports @mahiframework/http, @mahiframework/cli, and
 * @mahiframework/events will see all three hooks as valid, fully-typed
 * overrides on any of its own ServiceProvider subclasses, without core
 * ever importing those packages.
 *
 * Intentionally empty. This interface exists purely as a module
 * augmentation target for other framework packages (see example above).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProviderHooks {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- intentional: ServiceProvider implements the (module-augmentable) ProviderHooks interface it's merged with below, so subclasses can implement hook methods (routes/commands/listeners/migrations) directly.
export abstract class ServiceProvider implements ProviderHooks {
  constructor(protected app: Application) {}

  /**
   * Bind services into the container. Runs for every provider before any
   * provider's `boot()` runs, do not depend on other providers' services
   * being ready yet here, only bind your own.
   */
  register?(): void | Promise<void>;

  /**
   * Runs after every provider has finished `register()`, in the order
   * providers were registered (sequential, not parallel. A provider may
   * rely on an earlier provider already being booted/connected here).
   */
  boot?(): void | Promise<void>;

  /**
   * Release whatever `boot()` acquired: close pools, quit clients, clear
   * intervals. Run by `Application.terminate()` in REVERSE registration
   * order, the mirror of `boot()`, so a provider tears down before the
   * providers it booted on top of.
   *
   * Implement this for anything that keeps Node's event loop alive. A
   * connection opened in `boot()` and never closed is why a CLI command
   * finishes its work and then hangs instead of exiting.
   *
   * Must be best-effort: the process is going down regardless, so a
   * failure here is logged by `terminate()` and does not stop the
   * remaining providers from shutting down. It may run after a
   * *partially* completed boot (an earlier provider threw), so guard
   * against state your own `boot()` never got to create.
   */
  shutdown?(): void | Promise<void>;
}

// Allow hook methods declared via `ProviderHooks` augmentation to be
// implemented directly on ServiceProvider subclasses.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface ServiceProvider extends ProviderHooks {}
