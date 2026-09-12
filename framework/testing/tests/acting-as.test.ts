import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider, clearCurrentApp } from "@mahiframework/core";
import { CacheServiceProvider } from "@mahiframework/cache";
import { DatabaseServiceProvider, Model } from "@mahiframework/database";
import { EncryptionServiceProvider } from "@mahiframework/encryption";
import { HttpResponse, HttpServiceProvider, type Router } from "@mahiframework/http";
import { AuthServiceProvider, Auth, authenticate } from "@mahiframework/auth";
import { createTestApplication } from "../src/create-test-application.js";
import { TestClient } from "../src/test-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MIGRATIONS_DIR = path.join(__dirname, "__fixtures__/migrations");

interface UserAttributes {
  id: string;
  email: string;
  password: string;
}

class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  keyType: "uuid",
  timestamps: false,
}) {}

/** Fixture wiring auth + a route protected by authenticate(). */
class AuthProvider extends ServiceProvider {
  migrations(): string {
    return FIXTURE_MIGRATIONS_DIR;
  }

  routes(router: Router): void {
    router
      .get("/me", () => HttpResponse.json({ user: Auth.userOrNull(), guard: Auth.currentGuard() }))
      .middleware(authenticate());
  }
}

async function bootstrapApp(): Promise<Application> {
  const app = new Application();
  app.config.set("database", {
    default: "sqlite",
    migrationsPath: "database/migrations",
    connections: { sqlite: { filename: process.env.DB_FILENAME } },
  });
  app.config.set("cache", { default: "array", stores: { array: { sweepIntervalSeconds: 0 } } });
  app.config.set("auth", {
    default: "token",
    guards: { token: { driver: "token", provider: "users" } },
    providers: { users: { driver: "database", model: User } },
  });

  app.register(CacheServiceProvider);
  app.register(DatabaseServiceProvider);
  app.register(EncryptionServiceProvider);
  app.register(AuthServiceProvider);
  app.register(HttpServiceProvider);
  app.register(AuthProvider);

  await app.bootstrap();

  return app;
}

describe("actingAs()", () => {
  afterEach(() => {
    delete process.env.DB_FILENAME;
    delete process.env.NODE_ENV;
    delete process.env.APP_KEY;
    clearCurrentApp();
  });

  it("401s without an acting user", async () => {
    const testApp = await createTestApplication(bootstrapApp);
    try {
      const res = await testApp.request("/me");
      expect(res.status).toBe(401);
    } finally {
      await testApp.cleanup();
    }
  });

  it("authenticates the acting user through the kernel", async () => {
    const testApp = await createTestApplication(bootstrapApp);
    try {
      const user = { id: randomUUID(), email: "alice@example.com" };
      testApp.actingAs(user);

      const client = new TestClient(testApp.request);
      const { status, body } = await client.getJson<{
        user: { id: string } | null;
        guard: string | null;
      }>("/me");

      expect(status).toBe(200);
      expect(body.user).toMatchObject({ id: user.id });
      expect(body.guard).toBe("token");
    } finally {
      await testApp.cleanup();
    }
  });

  it("clears the acting user when passed null", async () => {
    const testApp = await createTestApplication(bootstrapApp);
    try {
      testApp.actingAs({ id: "x", email: "x@example.com" });
      expect((await testApp.request("/me")).status).toBe(200);

      testApp.actingAs(null);
      expect((await testApp.request("/me")).status).toBe(401);
    } finally {
      await testApp.cleanup();
    }
  });
});
