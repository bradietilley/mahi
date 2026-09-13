import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { CACHE_TOKEN } from "@mahiframework/core";
import type { CacheManager } from "../cache-manager.js";

/**
 * `./artisan cache:prune`, delete entries whose TTL has already elapsed,
 * without touching live ones.
 *
 * Both built-in stores expire **lazily**: an entry past its `expiresAt`
 * is only removed when something reads that key. For a key space that is
 * read back, that is free and sufficient. For one that isn't, a
 * `RateLimiter`'s per-IP counters are written once, checked during their
 * window, and then never looked at again. The dead entries stay
 * forever. On `FileCacheStore` that is an ever-growing directory of files
 * nothing will ever open.
 *
 * `ArrayCacheStore` sweeps itself on a timer, so this command is really
 * for the file store, from the scheduler:
 *
 * ```ts
 * schedule.command("cache:prune").hourly();
 * ```
 *
 * A store that has no `prune()`, `RedisCacheStore`, because Redis expires
 * keys itself, reports that and exits successfully, so a scheduled task
 * doesn't start failing the day someone switches `cache.default`.
 */
export class CachePruneCommand extends Command {
  signature = "cache:prune";
  description = "Delete expired entries from a cache store.";

  configure(program: CommanderCommand): void {
    program.option("--store <name>", "Cache store to prune (defaults to the configured default)");
  }

  async handle(options: { store?: string } = {}): Promise<void> {
    const manager = this.app.make<CacheManager>(CACHE_TOKEN);
    const name = options.store ?? manager.getDefaultDriver();
    const store = manager.store(options.store);

    if (!store.prune) {
      this.info(`The "${name}" store expires entries itself; there is nothing to prune.`);

      return;
    }

    const removed = await store.prune();
    this.success(
      `Pruned ${removed} expired ${removed === 1 ? "entry" : "entries"} from "${name}".`,
    );
  }
}
