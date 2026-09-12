import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  SCHEMA_TOKEN,
  DatabaseManager,
  Schema,
  SqliteDriver,
} from "@mahiframework/database";
import createTokensTable from "../../src/migrations/0001_create_personal_access_tokens_table.js";
import createSessionsTable from "../../src/migrations/0002_create_sessions_table.js";
import createPasswordResetTokensTable from "../../src/migrations/0003_create_password_reset_tokens_table.js";

export interface TestDatabase {
  app: Application;
  cleanup: () => void;
}

/**
 * In-memory SQLite with this package's own migrations applied, plus a
 * `users` table standing in for the app-owned one.
 *
 * Runs the real migration files rather than hand-rolling equivalent
 * schema, so a drift between what the migrations create and what the
 * guards expect shows up as a test failure instead of only appearing in
 * a real app.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, manager);
  app.bind(SCHEMA_TOKEN, () => manager.schema());
  setCurrentApp(app);

  await createTokensTable.up();
  await createSessionsTable.up();
  await createPasswordResetTokensTable.up();

  await Schema.create("users", (table) => {
    table.string("id").primary();
    table.string("email").unique();
    table.string("password");
    table.softDeletes();
  });

  return { app, cleanup: () => clearCurrentApp() };
}
