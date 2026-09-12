import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tracks the currently-active set of suppressed event-name wildcard
 * patterns via AsyncLocalStorage — same mechanism/shape as
 * `@mahiframework/database`'s `transaction-context.ts` (`storage.run(value,
 * callback)` + plain getters, no class wrapper). Backs `Event.suppress()`/
 * `Event.isSuppressed()` (see `event.ts`); `EventDispatcher.dispatch()`
 * checks it directly so EVERY `dispatch()` call — not just ones a
 * particular caller remembers to guard — becomes a no-op for a
 * suppressed event.
 *
 * Patterns stack: nested `Event.suppress()` calls concatenate onto
 * whatever's already active (`[...current, ...patterns]`), rather than
 * replacing it, so `Event.suppress(outer, ["model.posts.*"])` wrapping
 * `Event.suppress(inner, ["model.comments.*"])` suppresses BOTH inside
 * `inner`'s callback.
 */
const storage = new AsyncLocalStorage<string[]>();

export async function runWithEventsSuppressed<T>(
  callback: () => T | Promise<T>,
  patterns: string[],
): Promise<T> {
  const current = storage.getStore() ?? [];

  return storage.run([...current, ...patterns], callback);
}

/** Whether ANY suppression is currently active (regardless of which patterns). */
export function hasActiveSuppression(): boolean {
  const patterns = storage.getStore();

  return patterns !== undefined && patterns.length > 0;
}

/**
 * Whether `name` matches any currently-active suppression pattern.
 * Patterns are dot-segmented strings with `*` as a wildcard matching any
 * run of characters (not just a single segment) — e.g. `"model.posts.*"`
 * matches `"model.posts.created"`; a bare `"*"` matches every name.
 */
export function isNameSuppressed(name: string): boolean {
  const patterns = storage.getStore();

  if (!patterns || patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => matchesPattern(name, pattern));
}

/**
 * Dot-segmented `*` wildcard matching used by both `Event.suppress()` and
 * `EventDispatcher.listen("model.posts.*", handler)` — `*` matches any
 * run of characters (not just a single segment).
 */
export function matchesPattern(name: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);

  return regex.test(name);
}

function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
