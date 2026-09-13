import { randomUUID } from "node:crypto";
import { CACHE_TOKEN, type CacheManager } from "@mahiframework/cache";
import { TestClient, type TestApplication } from "@mahiframework/testing";

export interface AuthenticatedUser {
  id: string;
  email: string;
  password: string;
  token: string;
  /** A TestClient that sends this user's bearer token on every request. */
  client: TestClient;
  /** Raw request fn with the token attached, for header/status assertions. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Clear rate-limiter state between tests.
 *
 * Tests dispatch in-process, so every request shares one client identity.
 * There is no socket, so `request.ip()` is `undefined` and the
 * limiters bucket everything together. One test file's login attempts
 * would otherwise eat another's budget and produce a 429 that has
 * nothing to do with the behaviour under test.
 *
 * Sending a unique `x-forwarded-for` per request so each test looks like
 * a different client is not an option: that only works if `request.ip()`
 * trusts the header. Which is precisely the vulnerability that lets an
 * attacker rotate it to bypass the login limiter entirely. The header is
 * not trusted, so tests reset the limiter rather than impersonating
 * clients.
 */
export async function resetRateLimits(testApp: TestApplication): Promise<void> {
  if (!testApp.app.has(CACHE_TOKEN)) {
    return;
  }

  await testApp.app.make<CacheManager>(CACHE_TOKEN).store().flush();
}

/**
 * Register a fresh user and return a client authenticated as them.
 *
 * Clears the limiter first: registration is throttled (10/min), and a
 * test file creating a handful of users would otherwise trip it.
 */
export async function registerUser(
  testApp: TestApplication,
  overrides: { email?: string; password?: string; name?: string } = {},
): Promise<AuthenticatedUser> {
  const email = overrides.email ?? `user-${randomUUID()}@example.com`;
  const password = overrides.password ?? "correct-horse-battery";

  await resetRateLimits(testApp);

  const response = await testApp.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: overrides.name ?? "Test User", email, password }),
  });

  if (response.status !== 201) {
    throw new Error(`Failed to register test user: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { user: { id: string }; token: string };

  return {
    id: body.user.id,
    email,
    password,
    token: body.token,
    ...clientFor(testApp, body.token),
  };
}

/** Build a request fn + TestClient that carry a bearer token. */
export function clientFor(
  testApp: TestApplication,
  token: string,
): { client: TestClient; request: (path: string, init?: RequestInit) => Promise<Response> } {
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    testApp.request(path, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
    });

  return { client: new TestClient(request), request };
}
