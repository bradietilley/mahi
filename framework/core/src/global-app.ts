import type { Application } from "./application.js";

let current: Application | undefined;

/**
 * Escape hatch for retrieving the current Application instance without
 * threading it through every function signature. Prefer constructor
 * injection (ServiceProvider, Command, Model, etc. already receive `app`
 * directly) — reach for this only where DI genuinely isn't practical
 * (ad-hoc scripts, deeply nested pure-function helpers, etc.).
 *
 * Only one Application may be "current" at a time. Application.bootstrap()
 * calls setCurrentApp(this) before providers run (so `app()` and facades
 * work inside register()/boot()), and Application.terminate() clears it
 * again; tests that construct multiple Application instances (e.g. one
 * per test file) must not rely on this global and should keep using
 * explicit injection, or call setCurrentApp()/clearCurrentApp()
 * themselves around each test.
 */
export function app(): Application {
  if (!current) {
    throw new Error(
      "No Application instance is currently registered. Call app.bootstrap() first, " +
        "or avoid the global app() helper and use explicit dependency injection instead.",
    );
  }

  return current;
}

export function setCurrentApp(instance: Application): void {
  current = instance;
}

/**
 * Unset the current Application.
 *
 * Pass an instance to clear *conditionally* — it only clears when that
 * instance is the current one. `Application.terminate()` uses this form
 * so terminating an app that was never the global (a second app built in
 * a test) doesn't blank out the one that is.
 */
export function clearCurrentApp(only?: Application): void {
  if (only !== undefined && current !== only) {
    return;
  }

  current = undefined;
}
