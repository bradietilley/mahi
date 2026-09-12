import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApplication, TestClient, type TestApplication } from "@mahiframework/testing";
import { bootstrap } from "../bin/bootstrap.js";
import { clientFor, registerUser, resetRateLimits } from "./helpers/auth.js";

/**
 * `createTestApplication(bootstrap)` boots the real application against a
 * throwaway SQLite file and runs every migration — the framework's and
 * yours. `testApp.request()` dispatches straight into the app's own Hono
 * instance, so there's no server to start and no port to bind.
 *
 * Note there is no per-test "fake client IP" helper. Sending a unique
 * `x-forwarded-for` per request would only work if `request.ip()` trusted
 * that header — which is exactly the hole that lets an attacker rotate
 * the header to bypass the login limiter. The limiter is keyed on the
 * socket peer, which in-process tests share, so tests clear the limiter
 * state instead of pretending to be different clients. See
 * `resetRateLimits()`.
 */

describe("Auth API", () => {
  let testApp: TestApplication;
  let client: TestClient;

  beforeAll(async () => {
    testApp = await createTestApplication(bootstrap);
    client = new TestClient(testApp.request);
  });

  beforeEach(async () => {
    await resetRateLimits(testApp);
  });

  afterAll(async () => {
    await testApp.cleanup();
  });

  it("registers a user and returns a usable token", async () => {
    const email = `new-${randomUUID()}@example.com`;

    const { status, body } = await client.postJson<{ user: { email: string }; token: string }>(
      "/auth/register",
      { name: "Ada", email, password: "correct-horse-battery" },
    );

    expect(status).toBe(201);
    expect(body.user.email).toBe(email);
    expect(body.token).toContain("|");

    const me = await clientFor(testApp, body.token).client.getJson<{ email: string }>("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it("never returns the password hash", async () => {
    const { body } = await client.postJson<Record<string, unknown>>("/auth/register", {
      name: "Grace",
      email: `grace-${randomUUID()}@example.com`,
      password: "correct-horse-battery",
    });

    expect(JSON.stringify(body)).not.toContain("$argon2");
  });

  it("rejects a duplicate email", async () => {
    const user = await registerUser(testApp);

    const { status } = await client.postJson("/auth/register", {
      name: "Impostor",
      email: user.email,
      password: "another-password",
    });

    expect(status).toBe(422);
  });

  it("logs in with valid credentials", async () => {
    const user = await registerUser(testApp);

    const { status, body } = await client.postJson<{ token: string }>("/auth/login", {
      email: user.email,
      password: user.password,
    });

    expect(status).toBe(200);
    expect(body.token).toContain("|");
  });

  it("rejects a wrong password with 401", async () => {
    const user = await registerUser(testApp);

    const { status } = await client.postJson("/auth/login", {
      email: user.email,
      password: "not-the-password",
    });

    expect(status).toBe(401);
  });

  it("locks out repeated wrong-password attempts for one account", async () => {
    // The property the login limiter exists for. It must hold regardless
    // of what `x-forwarded-for` the client sends on each try: 7
    // wrong-password attempts must trip a 429, not return 401 seven times.
    const user = await registerUser(testApp);

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 7; attempt++) {
      const { status } = await client.postJson("/auth/login", {
        email: user.email,
        password: `wrong-${attempt}`,
      });
      statuses.push(status);
    }

    expect(statuses).toContain(429);
  });

  it("cannot be bypassed by forging x-forwarded-for", async () => {
    const user = await registerUser(testApp);

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 7; attempt++) {
      const { status } = await client.postJson(
        "/auth/login",
        { email: user.email, password: `wrong-${attempt}` },
        { headers: { "x-forwarded-for": `10.0.0.${attempt}` } },
      );
      statuses.push(status);
    }

    expect(statuses).toContain(429);
  });

  it("requires authentication for /auth/me", async () => {
    const response = await testApp.request("/auth/me");

    expect(response.status).toBe(401);
  });

  it("revokes the current token on logout", async () => {
    const user = await registerUser(testApp);

    const loggedOut = await user.request("/auth/logout", { method: "POST" });
    expect(loggedOut.status).toBe(200);

    const after = await user.request("/auth/me");
    expect(after.status).toBe(401);
  });
});
