import { join } from "node:path";

/**
 * Path helpers mirroring Laravel's `base_path()`/`storage_path()`/etc.
 * Every helper resolves relative to the application's root, by default
 * the directory the bootstrap process is run from (`process.cwd()`), not
 * this framework package's own location. That is wherever the consuming
 * app's `bin/console.ts` (or its artisan-equivalent entrypoint) is
 * invoked from, the skeleton app that loads the framework, analogous to
 * a plain `laravel/laravel` install. See `framework/create-mahi/template/`
 * for the shape of that app.
 *
 * Deliberately resolved against a MODULE-LEVEL root rather than an
 * `Application` instance's state: config files (e.g.
 * the app's `config/storage.ts`) call these helpers while building the config
 * that's handed to `new Application()`/`app.config.set(...)`, before
 * `app.bootstrap()` has run, well before the `app()` global singleton
 * (`./global-app.ts`) is populated. Tying these to cwd (or to a
 * module-level override) instead keeps them usable at any point in the
 * boot sequence, with no ordering trap.
 */

type PathSegment = string | null | undefined;

function joinPath(root: string, segments: PathSegment[]): string {
  const parts = segments.filter((segment): segment is string => segment != null);

  return join(root, ...parts);
}

/**
 * Overrides `process.cwd()` as the root, when set. Deliberately a plain
 * module-level variable and not `Application` state. See this file's
 * header: config functions run before an `Application` exists, so there
 * is nothing to hang it off yet.
 */
let appRoot: string | undefined;

/**
 * Pin the application root explicitly, instead of inferring it from
 * `process.cwd()`.
 *
 * This exists for apps that are *installed and run from anywhere* rather
 * than run from a project directory, a compiled CLI binary being the
 * motivating case. Run such a binary from `~/Downloads` and the cwd
 * default silently resolves `database_path()` to `~/Downloads/database`,
 * where a relative sqlite `filename` then creates a **fresh empty
 * database** rather than failing. (The same failure is described in
 * `docs/deployment/README.md`.) An app in that position calls this with
 * its own data root, e.g. `~/.config/<name>`, as the very first
 * statement of `bootstrap()`, before `loadEnv()` and before any
 * `config/*.ts` function runs, since those call `storage_path()` etc.
 * while building the config object.
 *
 * Additive and default-preserving: leave it unset and every helper below
 * behaves exactly as it always has, resolving against `process.cwd()`.
 * Project-style apps (`./artisan`, which `cd`s to the app root) should
 * not call this at all.
 */
export function setBasePath(root: string): void {
  appRoot = root;
}

/**
 * The root `base_path()` currently resolves against, the value passed to
 * `setBasePath()`, or `process.cwd()` when it was never called. Mostly
 * useful for diagnostics ("which root did we actually pick?") and tests.
 */
export function resolvedBasePath(): string {
  return appRoot ?? process.cwd();
}

/**
 * Clears any root set by `setBasePath()`, restoring the `process.cwd()`
 * default. For tests. A module-level root would otherwise leak between
 * test files sharing a module registry.
 */
export function clearBasePath(): void {
  appRoot = undefined;
}

/**
 * The application's root directory, optionally joined with further path
 * segments. `null`/`undefined` segments are stripped, so conditional
 * segments can be passed inline (e.g. `base_path("storage", env && "logs")`).
 */
export function base_path(...segments: PathSegment[]): string {
  return joinPath(resolvedBasePath(), segments);
}

export function storage_path(...segments: PathSegment[]): string {
  return base_path("storage", ...segments);
}

export function resource_path(...segments: PathSegment[]): string {
  return base_path("resources", ...segments);
}

export function database_path(...segments: PathSegment[]): string {
  return base_path("database", ...segments);
}
