import type { CacheStore } from "@mahiframework/cache";
import type { SequenceResolver } from "./sequence-resolver.js";

/**
 * Cache-backed sequencer for multi-process uniqueness with a shared
 * worker id. Mirrors php-snowflake's `LaravelSequenceResolver`: no lock
 * is taken. For a given microsecond key, the first caller wins `add`
 * and gets sequence `0`; concurrent callers fall through to atomic
 * `increment`. Callers on different microseconds never block each other.
 *
 * How safe this is depends entirely on how atomic the store's `add()` and
 * `increment()` really are, since those two calls *are* the whole
 * algorithm:
 *
 *   - `ArrayCacheStore` — atomic within one process only, so it shares
 *     nothing between processes. **Not** usable for multi-process
 *     sequencing; use `FileSequenceResolver` or a unique worker id per
 *     process.
 *   - `FileCacheStore` — atomic across processes **on one host**
 *     (`O_EXCL` create, lock-file-guarded increment). Fine for several
 *     processes on one machine; not across machines, and not over NFS.
 *   - `RedisCacheStore` — atomic anywhere (`SET NX`, `INCRBY`). The right
 *     answer once more than one host shares a worker id.
 */
export class CacheSequenceResolver implements SequenceResolver {
  constructor(
    private readonly store: CacheStore,
    private readonly prefix = "",
  ) {}

  async sequence(currentTime: number): Promise<number> {
    const key = `${this.prefix}${currentTime}`;

    // Seed at 0 so incrementing yields 1, 2, 3… — the documented
    // "first caller gets 0, everyone else increments" contract. (The
    // PHP sibling seeds at 1 and returns 0, which skips sequence 1.)
    if (await this.store.add(key, 0, 10)) {
      return 0;
    }

    return this.store.increment(key);
  }
}
