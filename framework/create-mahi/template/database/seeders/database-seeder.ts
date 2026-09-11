import { Seeder } from "@mahi/database";
import { User } from "../../src/models/user.model.js";

/**
 * The app's default `db:seed` entrypoint — populates a fresh database
 * with a handful of users via `UserFactory`, so `migrate:fresh --seed`
 * (or a bare `db:seed`) leaves something to look at. Registered in
 * `AppServiceProvider.seeders()`.
 *
 * Add more seeders (and register them alongside this one) as the app
 * grows; each should stay focused on a single table or feature.
 */
export class DatabaseSeeder extends Seeder {
  async run(): Promise<void> {
    await User.factory().times(10).create();
  }
}
