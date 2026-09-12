import { ServiceProvider } from "@mahiframework/core";
import { SequentialIdentifierResolver } from "./identifier-resolvers/sequential-identifier-resolver.js";
import { defaultSnowflakeConfig } from "./snowflake-config.js";
import { SnowflakeGenerator } from "./snowflake-generator.js";
import { SEQUENTIAL_IDENTIFIER_TOKEN, SNOWFLAKE_TOKEN } from "./tokens.js";

/**
 * Registers the `SnowflakeGenerator` singleton and a shared
 * `SequentialIdentifierResolver` (used when `snowflake.testing` is true).
 *
 * ORDERING: list after `CacheServiceProvider` if you set
 * `sequencing.resolver` to `"cache"` — the generator resolves `CACHE_TOKEN`
 * on first `id()`. With the default in-process memory sequencer there is
 * no ordering dependency. Call `Snowflake.configureSignature()` from your
 * own provider's `register()` (before this provider's first `id()`) if
 * you need a non-default bit layout.
 */
export class SnowflakeServiceProvider extends ServiceProvider {
  register(): void {
    if (this.app.config.get("snowflake") === undefined) {
      this.app.config.set("snowflake", defaultSnowflakeConfig());
    }

    this.app.singleton(SEQUENTIAL_IDENTIFIER_TOKEN, () => new SequentialIdentifierResolver());
    this.app.singleton(SNOWFLAKE_TOKEN, (app) => new SnowflakeGenerator(app));
  }
}
