import { DATABASE_TOKEN } from "@mahi/core";
import type { HealthCheck } from "../health-check.js";
import type { DatabaseManagerLike } from "./contracts.js";

/**
 * One trivial query on the default connection.
 *
 * `select 1` (built via Kysely's `selectNoFrom`, so this package needs no
 * `kysely` import) is portable across sqlite/MySQL/Postgres, touches no
 * application table, and cannot be affected by schema state.
 *
 * Deliberately **not** `introspection.getTables()` — what `db:show` uses —
 * which is a far heavier query that turns a probe into a load source on a
 * large schema.
 *
 * Default connection only. Checking every configured connection means a
 * probe whose cost scales with the config file and which fails on a
 * deliberately-offline analytics replica. An app that needs a second
 * connection checked registers a second check.
 */
export const databaseCheck: HealthCheck = {
  name: "database",
  group: "core",

  async run(app) {
    if (!app.has(DATABASE_TOKEN)) {
      return null;
    }

    const { kysely } = app.make<DatabaseManagerLike>(DATABASE_TOKEN).connection();
    await kysely.selectNoFrom((eb) => eb.lit(1).as("health")).execute();

    return true;
  },
};
