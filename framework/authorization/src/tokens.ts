/**
 * Container binding key, re-exported here (in its own module, so
 * middleware, helpers and the facade can import it without pulling in the
 * service provider and the import cycle that would create) from its
 * canonical definition in `@mahiframework/core`'s `well-known-tokens`. See
 * that module for why cross-package tokens live there.
 */
export { GATE_TOKEN } from "@mahiframework/core";
