import path from "node:path";
import type { DatabaseConfig } from "@mahi/database";
import type { Env } from "./env.js";

/**
 * This app's own migrations, resolved relative to THIS compiled file
 * rather than `process.cwd()`.
 *
 * `database_path("migrations")` resolves against the working directory, so
 * it points at the SOURCE `database/migrations/*.ts` even when the process
 * is `node dist/bin/console.js`. On Node without on-the-fly type-stripping
 * (the default below 22.6 / with `--no-experimental-strip-types`) the
 * runner then either throws `ERR_UNKNOWN_FILE_EXTENSION: ".ts"` or, if the
 * source tree isn't shipped at all, finds zero migrations and silently
 * migrates nothing against an empty production database.
 *
 * `import.meta.dirname` is where THIS file actually is — `config/` under
 * source (tsx), `dist/config/` once compiled — so `../database/migrations`
 * lands on the matching `.ts` in development and the compiled `.js` in
 * `dist/`, with no dependence on how the process was launched.
 */
const migrationsPath = path.join(import.meta.dirname, "..", "database", "migrations");

/**
 * SQLite by default — the file lives at `database/database.sqlite`
 * (`DB_FILENAME`), created on first connect. Switch engines by setting
 * `DB_CONNECTION` to `mysql` or `pgsql` and filling in the `DB_*` host
 * credentials.
 *
 * Each connection names its `driver` explicitly, so a connection can be
 * called whatever you like (`mysql`, `analytics`, `reporting`, ...) — the
 * `driver` field, not the key, decides which engine builds it.
 *
 * `migrationsPath` is where `./artisan migrate` looks for *this app's*
 * migrations; the framework's own tables (personal access tokens,
 * sessions, jobs, notifications, ...) are contributed by their packages'
 * `migrations()` provider hooks and are picked up automatically — you
 * don't list them here.
 */
export function databaseConfig(env: Env): DatabaseConfig & { migrationsPath: string } {
  return {
    default: env.DB_CONNECTION,
    migrationsPath,
    connections: {
      sqlite: {
        driver: "sqlite",
        filename: env.DB_FILENAME,
      },
      mysql: {
        driver: "mysql",
        host: env.DB_HOST,
        port: env.DB_PORT ?? 3306,
        database: env.DB_DATABASE,
        username: env.DB_USERNAME,
        password: env.DB_PASSWORD,
      },
      pgsql: {
        driver: "postgres",
        host: env.DB_HOST,
        port: env.DB_PORT ?? 5432,
        database: env.DB_DATABASE,
        username: env.DB_USERNAME,
        password: env.DB_PASSWORD,
      },
    },
  };
}
