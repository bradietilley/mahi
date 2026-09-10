import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { Hasher, Signer } from "@mahi/encryption";
import { HASHER_TOKEN, SIGNER_TOKEN } from "@mahi/encryption";
import { Request } from "@mahi/http";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import { User } from "../__fixtures__/user-model.js";
import { AuthManager } from "../../src/auth-manager.js";
import { DatabaseUserProvider } from "../../src/providers/database-user-provider.js";
import { SessionGuard } from "../../src/guards/session-guard.js";
import { TokenGuard } from "../../src/guards/token-guard.js";
import { DatabaseSessionStore } from "../../src/session/database-session-store.js";
import { PersonalAccessToken } from "../../src/models/personal-access-token.js";
import { Session } from "../../src/models/session.js";

/**
 * The wiring test for H2: not "the broker calls its revokers" (the unit
 * suite covers that with mocks) but "a broker resolved the normal way,
 * through `AuthManager` and real config, actually kills real sessions and
 * real tokens."
 *
 * Worth its own file because the failure mode was entirely in the
 * wiring — `PasswordBroker` simply never asked anything to revoke, and no
 * unit test of the broker in isolation could have noticed.
 */
describe("password reset revokes credentials (wired through AuthManager)", () => {
  let database: TestDatabase;
  let app: Application;
  let manager: AuthManager;
  let hasher: Hasher;
  let sessions: DatabaseSessionStore;

  beforeEach(async () => {
    database = await createTestDatabase();
    app = database.app;
    setCurrentApp(app);

    hasher = new Hasher();
    sessions = new DatabaseSessionStore();

    app.instance(HASHER_TOKEN, hasher);
    app.instance(SIGNER_TOKEN, new Signer(Buffer.alloc(32, 5)));

    manager = new AuthManager(
      app,
      {
        default: "web",
        guards: {
          web: { driver: "session", provider: "users" },
          api: { driver: "token", provider: "users" },
        },
        providers: { users: { driver: "database", model: User } },
        passwords: { throttleSeconds: 0 },
      },
      hasher,
    );

    manager.extendUserProvider(
      "database",
      (_app, config) => new DatabaseUserProvider(config as any, hasher),
    );
    manager.extend("session", () => {
      const config = manager.guardConfig();

      return new SessionGuard(
        manager.userProvider(config["provider"] as string),
        sessions,
        new Signer(Buffer.alloc(32, 5)),
        { secure: false },
      );
    });
    manager.extend("token", () => {
      const config = manager.guardConfig();

      return new TokenGuard(manager.userProvider(config["provider"] as string), {});
    });

    await User.create({
      id: "alice",
      email: "alice@example.com",
      password: await hasher.make("old-password"),
    });
  });

  afterEach(() => {
    clearCurrentApp();
    database.cleanup();
  });

  it("kills existing sessions and tokens on a successful reset", async () => {
    // Two live sessions and a live API token, as an account under
    // someone else's control would have.
    const sessionGuard = manager.statefulGuard("web");
    const phone = await sessionGuard.login(Request.create("/"), "alice");
    const laptop = await sessionGuard.login(Request.create("/"), "alice");

    const tokenGuard = manager.guard("api") as unknown as TokenGuard;
    await tokenGuard.createToken("alice", "cli");

    await expect(Session.query().where("user_id", "alice").get()).resolves.toHaveLength(2);
    await expect(PersonalAccessToken.query().where("user_id", "alice").get()).resolves.toHaveLength(
      1,
    );

    const broker = manager.passwordBroker();
    const sent = await broker.sendResetLink("alice@example.com");
    const token = sent.status === "sent" ? sent.token! : "";

    await expect(broker.reset("alice@example.com", token, "new-password")).resolves.toEqual({
      status: "reset",
    });

    // Every credential minted before the reset is gone.
    await expect(sessions.read(phone)).resolves.toBeNull();
    await expect(sessions.read(laptop)).resolves.toBeNull();
    await expect(PersonalAccessToken.query().where("user_id", "alice").get()).resolves.toHaveLength(
      0,
    );
  });

  it("leaves credentials alone when the reset fails", async () => {
    const sessionGuard = manager.statefulGuard("web");
    const live = await sessionGuard.login(Request.create("/"), "alice");

    const broker = manager.passwordBroker();
    await broker.sendResetLink("alice@example.com");
    await broker.reset("alice@example.com", "wrong-token", "new-password");

    await expect(sessions.read(live)).resolves.not.toBeNull();
  });
});
