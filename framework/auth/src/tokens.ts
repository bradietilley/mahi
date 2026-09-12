/**
 * Container binding key, re-exported here (in its own module, so
 * middleware and the facade can import it without pulling in the service
 * provider and the import cycle that would create) from its canonical
 * definition in `@mahiframework/core`'s `well-known-tokens` — it's resolved
 * cross-package by `@mahiframework/authorization` (current user) and
 * `@mahiframework/auth`'s own "cache" session store path.
 */
export { AUTH_TOKEN } from "@mahiframework/core";
