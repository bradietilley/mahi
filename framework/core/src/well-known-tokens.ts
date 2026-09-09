/**
 * The single source of truth for the container-binding tokens of services
 * that are referenced ACROSS package boundaries.
 *
 * WHY THIS EXISTS: several packages deliberately avoid a compile-time
 * dependency on the package that owns a service, resolving it by string
 * token at runtime instead — `@mahi/authorization` reads the
 * current user via `"auth"` without depending on `@mahi/auth`,
 * `@mahi/schedule` dispatches jobs via `"queue"` without depending
 * on `@mahi/queue`, `@mahi/http` fans broadcasts out via
 * `"broadcast"` without depending on `@mahi/broadcasting`, and
 * `@mahi/auth`'s optional "cache" session store reaches
 * `@mahi/cache` via `"cache"`. Sharing the constants here means the token
 * is declared in exactly one place; a private `const X_TOKEN = "..."`
 * literal per package would let a typo in either copy become a silent
 * `BindingNotFoundError` at runtime with no compile-time protection.
 *
 * Every package already depends on `@mahi/core` (it's where
 * `Application`/`ServiceProvider` live), so hoisting these token strings
 * here gives both the owning package AND every soft-dependent a single
 * literal to import — a typo is now a compile error, not a runtime one,
 * and the value can never drift between the two sides.
 *
 * Each owning package still re-exports its token under the historical
 * name (`AUTH_TOKEN` from `@mahi/auth`, `QUEUE_TOKEN` from
 * `@mahi/queue`, …) so existing imports keep working — those
 * re-exports now just point back here.
 *
 * Only genuinely cross-package tokens belong here. Package-private tokens
 * (e.g. `RATE_LIMITER_TOKEN`, `MODEL_REGISTRY_TOKEN`, `HTTP_KERNEL_TOKEN`)
 * that are only ever resolved from within their own package stay local to
 * that package.
 */

/** `DatabaseManager` — owned by `@mahi/database`. */
export const DATABASE_TOKEN = "db";

/** `AuthManager` — owned by `@mahi/auth`. */
export const AUTH_TOKEN = "auth";

/** `GateRegistry` — owned by `@mahi/authorization`. */
export const GATE_TOKEN = "gate";

/** `QueueManager` — owned by `@mahi/queue`. */
export const QUEUE_TOKEN = "queue";

/** `CacheManager` — owned by `@mahi/cache`. */
export const CACHE_TOKEN = "cache";

/** `EventDispatcher` — owned by `@mahi/events`. */
export const EVENTS_TOKEN = "events";

/** `BroadcastManager` — owned by `@mahi/broadcasting`. */
export const BROADCAST_TOKEN = "broadcast";

/** `StorageManager` — owned by `@mahi/storage`. */
export const STORAGE_TOKEN = "storage";
