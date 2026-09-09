import type { Application } from "@mahi/core";

/**
 * Base class for database seeders. Subclass and implement `run()`; wire
 * seeders up in a `db:seed` command (see @mahi/cli's built-in
 * `db:seed` command, which discovers seeders registered by providers).
 */
export abstract class Seeder {
  constructor(protected app: Application) {}

  abstract run(): Promise<void>;
}
