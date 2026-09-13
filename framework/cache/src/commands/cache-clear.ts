import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";
import { CACHE_TOKEN } from "@mahiframework/core";
import type { CacheManager } from "../cache-manager.js";

/**
 * `./artisan cache:clear`, empty a cache store.
 *
 * Operates on the **default** store unless `--store` names another, which
 * is the one thing to be deliberate about: `cache.default` is usually
 * `array`, and clearing an `array` store from the CLI clears that CLI
 * process's own empty `Map` and exits. It reports success and does
 * nothing, because there is nothing shared to clear, the running
 * server's cache is in a different process's heap. Pass
 * `--store=file`/`--store=redis`, or point `cache.default` at a shared
 * store, if you meant the server's.
 *
 * What it will **not** do is reach outside the cache. Each store's
 * `flush()` is scoped to that store's own namespace: `RedisCacheStore`
 * scans `<connection prefix>cache:*` rather than issuing `FLUSHDB`, so
 * queued jobs (`queues:*`) and any co-tenant on the same Redis survive.
 * That scoping is the whole reason this command is safe to hand to an
 * operator.
 */
export class CacheClearCommand extends Command {
  signature = "cache:clear";
  description = "Remove every entry from a cache store.";

  configure(program: CommanderCommand): void {
    program.option("--store <name>", "Cache store to clear (defaults to the configured default)");
  }

  async handle(options: { store?: string } = {}): Promise<void> {
    const manager = this.app.make<CacheManager>(CACHE_TOKEN);
    const name = options.store ?? manager.getDefaultDriver();

    await manager.store(options.store).flush();

    this.success(`Cleared the "${name}" cache store.`);

    if (name === "array") {
      this.warn(
        "The array store lives in this process's memory, so this cleared nothing a running " +
          "server can see. Use --store with a shared store (file, redis) to clear that one.",
      );
    }
  }
}
