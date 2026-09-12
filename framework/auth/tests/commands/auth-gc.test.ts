import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { Hasher, Signer } from "@mahiframework/encryption";
import { DateTime } from "@mahiframework/datetime";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import { User } from "../__fixtures__/user-model.js";
import { AuthManager } from "../../src/auth-manager.js";
import { AUTH_TOKEN } from "../../src/tokens.js";
import { AuthGcCommand } from "../../src/commands/auth-gc.js";
import { DatabaseUserProvider } from "../../src/providers/database-user-provider.js";
import { SessionGuard } from "../../src/guards/session-guard.js";
import { TokenGuard } from "../../src/guards/token-guard.js";
import { DatabaseSessionStore } from "../../src/session/database-session-store.js";
import { PersonalAccessToken } from "../../src/models/personal-access-token.js";
import { Session } from "../../src/models/session.js";

const past = () => DateTime.now("UTC").subMinutes(60).toISOString();
const future = () => DateTime.now("UTC").addMinutes(60).toISOString();

describe("auth:gc", () => {
  let database: TestDatabase;
  let app: Application;

  beforeEach(async () => {
    database = await createTestDatabase();
    app = database.app;
    setCurrentApp(app);

    const hasher = new Hasher();

    // Guards named the Laravel way — `web`/`api`, not `session`/`token`.
    // The command must find guards by driver, not by name: looking up
    // `guard("session")` in an app shaped like this resolves nothing and
    // sweeps nothing.
    const manager = new AuthManager(
      app,
      {
        default: "web",
        guards: {
          web: { driver: "session", provider: "users" },
          api: { driver: "token", provider: "users" },
        },
        providers: { users: { driver: "database", model: User } },
      },
      hasher,
    );

    manager.extendUserProvider(
      "database",
      (_a, config) => new DatabaseUserProvider(config as any, hasher),
    );
    manager.extend(
      "session",
      () =>
        new SessionGuard(
          manager.userProvider("users"),
          new DatabaseSessionStore(),
          new Signer(Buffer.alloc(32, 4)),
        ),
    );
    manager.extend("token", () => new TokenGuard(manager.userProvider("users")));

    app.instance(AUTH_TOKEN, manager);
  });

  afterEach(() => {
    clearCurrentApp();
    database.cleanup();
  });

  async function run(): Promise<void> {
    await new AuthGcCommand(app).handle();
  }

  it("deletes expired sessions and keeps live ones", async () => {
    await Session.create({
      id: "stale",
      user_id: "u1",
      expires_at: past(),
      created_at: past(),
      last_active_at: past(),
    });
    await Session.create({
      id: "live",
      user_id: "u1",
      expires_at: future(),
      created_at: past(),
      last_active_at: past(),
    });

    await run();

    await expect(Session.find("stale")).resolves.toBeUndefined();
    await expect(Session.find("live")).resolves.toBeDefined();
  });

  it("deletes expired access tokens, keeping live and never-expiring ones", async () => {
    // Nothing pruned these before, so the table grew forever in any app
    // that configured a token lifetime.
    const base = {
      user_id: "u1",
      name: "t",
      token: "hash",
      last_used_at: null,
      created_at: past(),
    };
    await PersonalAccessToken.create({ ...base, id: "expired", expires_at: past() });
    await PersonalAccessToken.create({ ...base, id: "live", expires_at: future() });
    await PersonalAccessToken.create({ ...base, id: "forever", expires_at: null });

    await run();

    await expect(PersonalAccessToken.find("expired")).resolves.toBeUndefined();
    await expect(PersonalAccessToken.find("live")).resolves.toBeDefined();
    // Null expires_at is the Sanctum default: never expires, never swept.
    await expect(PersonalAccessToken.find("forever")).resolves.toBeDefined();
  });
});
