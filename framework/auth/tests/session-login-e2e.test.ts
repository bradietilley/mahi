import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, CACHE_TOKEN, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { HASHER_TOKEN, Hasher, SIGNER_TOKEN, Signer } from "@mahiframework/encryption";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  SCHEMA_TOKEN,
  Schema,
  SqliteDriver,
} from "@mahiframework/database";
import { HttpKernel, HttpResponse, type Router } from "@mahiframework/http";
import { AuthServiceProvider } from "../src/auth-service-provider.js";
import { AUTH_TOKEN } from "../src/tokens.js";
import type { AuthManager } from "../src/auth-manager.js";
import { authenticate } from "../src/middleware/authenticate.js";
import { Auth } from "../src/auth-facade.js";
import { User } from "./__fixtures__/user-model.js";
import createSessionsTable from "../src/migrations/0002_create_sessions_table.js";

/**
 * The test the audit says would have caught the critical bug: a session
 * login through a real `HttpKernel`, a real `AuthServiceProvider`, and
 * framework routes returning framework responses.
 *
 * Everything here is deliberately end to end. The unit suites all
 * constructed guards by hand; this one boots the container, resolves the
 * guard through config, and drives it over HTTP, the only arrangement
 * that exercises the seam where the cookie was being dropped (handlers
 * return platform `Response` objects, which Hono does not merge its
 * context-queued headers into).
 */

/** Pull one cookie's value out of a `Set-Cookie` response header. */
function cookieFrom(response: Response, name = "session"): string | null {
  for (const header of response.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);

    if (match?.[1] !== undefined) {
      return decodeURIComponent(match[1]);
    }
  }

  return null;
}

function setCookieFor(response: Response, name = "session"): string | undefined {
  return response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`));
}

class SessionAuthProvider extends AuthServiceProvider {
  routes(router: Router): void {
    router.post("/login", async (request) => {
      const manager = request.shared<AuthManager>("auth")!;
      await manager.login(request, String(request.input("id")));

      // Deliberately a framework response, not `c.json()`. That is the
      // whole point of this test.
      return HttpResponse.json({ ok: true });
    });

    router.post("/login-remember", async (request) => {
      const manager = request.shared<AuthManager>("auth")!;
      await manager.login(request, String(request.input("id")), { remember: true });

      return HttpResponse.json({ ok: true });
    });

    // Reads the ambient auth scope right after login, in the SAME
    // request, the M6 behaviour.
    router.post("/login-and-read", async (request) => {
      const manager = request.shared<AuthManager>("auth")!;
      await manager.login(request, String(request.input("id")));

      return HttpResponse.json({ user: Auth.userOrNull(), guard: Auth.currentGuard() });
    });

    router
      .get("/me", (request) => HttpResponse.json({ user: request.user() ?? null }))
      .middleware(authenticate("session"));

    router.post("/logout", async (request) => {
      const manager = request.shared<AuthManager>("auth")!;
      await manager.logout(request);

      return HttpResponse.json({ ok: true });
    });
  }

  /** Share the manager so the routes above don't each resolve it. */
  middleware() {
    return [
      ...super.middleware(),
      async (request: any, next: any) => {
        request.share("auth", this.app.make<AuthManager>(AUTH_TOKEN));

        return next(request);
      },
    ];
  }
}

describe("session login end to end", () => {
  let app: Application;
  let kernel: HttpKernel;

  beforeEach(async () => {
    app = new Application();
    setCurrentApp(app);

    const database = new DatabaseManager(app, { default: "sqlite", connections: {} });
    database.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
    app.instance(DATABASE_TOKEN, database);
    app.bind(SCHEMA_TOKEN, () => database.schema());

    app.instance(HASHER_TOKEN, new Hasher());
    app.instance(SIGNER_TOKEN, new Signer(Buffer.alloc(32, 3)));
    app.instance(CACHE_TOKEN, { store: () => ({}) });

    app.config.set("auth", {
      default: "session",
      guards: {
        session: {
          driver: "session",
          provider: "users",
          store: "database",
          cookie: "session",
          lifetimeMinutes: 120,
          // Plain HTTP in the test, as in local development.
          secure: false,
        },
      },
      providers: { users: { driver: "database", model: User } },
    });

    await createSessionsTable.up();
    await Schema.create("users", (table) => {
      table.string("id").primary();
      table.string("email").unique();
      table.string("password");
    });
    await User.create({ id: "alice", email: "alice@example.com", password: "x" });

    const provider = new SessionAuthProvider(app);
    (app as any).providers = [provider];
    provider.register();

    kernel = new HttpKernel(app);
    kernel.collectFromProviders();
  });

  afterEach(() => clearCurrentApp());

  async function request(path: string, init?: RequestInit): Promise<Response> {
    return kernel.raw().request(path, init);
  }

  it("sets the session cookie on a framework route returning HttpResponse", async () => {
    const login = await request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "alice" }),
    });

    expect(login.status).toBe(200);

    const header = setCookieFor(login);
    expect(header).toBeDefined();
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//i);
    expect(header).toMatch(/Max-Age=7200/);
  });

  it("keeps the user logged in on the next request using only that cookie", async () => {
    const login = await request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "alice" }),
    });
    const cookie = cookieFrom(login)!;

    const me = await request("/me", { headers: { Cookie: `session=${cookie}` } });

    expect(me.status).toBe(200);
    expect((await me.json()) as any).toMatchObject({ user: { id: "alice" } });
  });

  it("401s without the cookie", async () => {
    const me = await request("/me");
    expect(me.status).toBe(401);
  });

  it("logout expires the cookie and the session stops working", async () => {
    const login = await request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "alice" }),
    });
    const cookie = cookieFrom(login)!;

    const logout = await request("/logout", {
      method: "POST",
      headers: { Cookie: `session=${cookie}` },
    });

    expect(setCookieFor(logout)).toMatch(/Max-Age=0/);

    const me = await request("/me", { headers: { Cookie: `session=${cookie}` } });
    expect(me.status).toBe(401);
  });

  it("makes the user available in the SAME request that logged them in", async () => {
    // `login()` must populate the ambient scope, not just write the
    // session, otherwise `Auth.user()` throws in the controller that has
    // just authenticated someone.
    const response = await request("/login-and-read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "alice" }),
    });

    const body = (await response.json()) as { user: { id: string } | null; guard: string | null };
    expect(body.user).toMatchObject({ id: "alice" });
    expect(body.guard).toBe("session");
  });

  it("uses the remember window when asked", async () => {
    const login = await request("/login-remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "alice" }),
    });

    const maxAge = /Max-Age=(\d+)/.exec(setCookieFor(login) ?? "")?.[1];
    expect(Number(maxAge)).toBeGreaterThan(120 * 60);
  });
});
