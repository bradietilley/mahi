export interface JsonResponse<T> {
  status: number;
  body: T;
}

// The result is always awaited, so a handler that answers synchronously is
// as usable as one that returns a promise. Hono's own `app.request` is typed
// `Response | Promise<Response>`, so narrowing this to `Promise<Response>`
// would reject the single most common thing callers pass.
type RequestFn = (path: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * Parse one cookie name/value pair out of a `Set-Cookie` header line,
 * ignoring the attributes (`Path`, `HttpOnly`, `Max-Age`, ...). Returns
 * `undefined` for a line that has no `name=value` pair.
 */
function parseSetCookie(line: string): { name: string; value: string } | undefined {
  const first = line.split(";", 1)[0] ?? "";
  const eq = first.indexOf("=");

  if (eq === -1) {
    return undefined;
  }

  return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
}

/**
 * Thin convenience wrapper around a raw `request()` function (as returned
 * by `createTestApplication()`) that cuts down on repeated
 * `JSON.stringify`/`headers: {"Content-Type": ...}` boilerplate per test.
 * Deliberately a plain class, not a vitest-specific base class — compose
 * it from `beforeAll`/`afterAll` like any other test fixture.
 *
 * Holds a **cookie jar** and a set of **default headers** so a session
 * cookie set by one request (login) is replayed on the next (`GET /me`),
 * and an `Authorization`/`actingAs` header set once applies to every
 * request — the behaviours session/token-guard tests need through the
 * kernel. Both are mutable builder state; each `with*` method returns
 * `this` for chaining and mutates in place.
 */
export class TestClient {
  private cookies = new Map<string, string>();
  private defaultHeaders = new Headers();

  constructor(private request: RequestFn) {}

  /**
   * Send an `Authorization: Bearer <token>` header on every subsequent
   * request — for token-guard (`Bearer`) authentication. Pair with
   * `TokenGuard.createToken()` to get a plaintext token.
   */
  withToken(token: string, type = "Bearer"): this {
    this.defaultHeaders.set("Authorization", `${type} ${token}`);

    return this;
  }

  /** Merge extra default headers applied to every subsequent request. */
  withHeaders(headers: Record<string, string> | [string, string][] | Headers): this {
    const extra = new Headers(headers);
    extra.forEach((value, key) => this.defaultHeaders.set(key, value));

    return this;
  }

  /** Seed a cookie into the jar (replayed as `Cookie: name=value`). */
  withCookie(name: string, value: string): this {
    this.cookies.set(name, value);

    return this;
  }

  /** The current value of a cookie captured from a `Set-Cookie` response, if any. */
  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  /** Drop all default headers and cookies — reset between logical sessions. */
  flush(): this {
    this.cookies.clear();
    this.defaultHeaders = new Headers();

    return this;
  }

  async getJson<T = unknown>(path: string, init?: RequestInit): Promise<JsonResponse<T>> {
    const res = await this.send(path, { method: "GET", ...init });

    return { status: res.status, body: await this.readJson<T>(res) };
  }

  async postJson<T = unknown>(
    path: string,
    payload?: unknown,
    init?: RequestInit,
  ): Promise<JsonResponse<T>> {
    return this.sendJson<T>("POST", path, payload, init);
  }

  async patchJson<T = unknown>(
    path: string,
    payload?: unknown,
    init?: RequestInit,
  ): Promise<JsonResponse<T>> {
    return this.sendJson<T>("PATCH", path, payload, init);
  }

  async putJson<T = unknown>(
    path: string,
    payload?: unknown,
    init?: RequestInit,
  ): Promise<JsonResponse<T>> {
    return this.sendJson<T>("PUT", path, payload, init);
  }

  async deleteJson<T = unknown>(path: string, init?: RequestInit): Promise<JsonResponse<T>> {
    const res = await this.send(path, { method: "DELETE", ...init });

    return { status: res.status, body: await this.readJson<T>(res) };
  }

  private async sendJson<T>(
    method: string,
    path: string,
    payload: unknown,
    init: RequestInit = {},
  ): Promise<JsonResponse<T>> {
    const headers = new Headers(init.headers);

    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await this.send(path, {
      ...init,
      method,
      headers,
      body: JSON.stringify(payload ?? {}),
    });

    return { status: res.status, body: await this.readJson<T>(res) };
  }

  /**
   * Issue the underlying request, merging default headers + the cookie jar
   * into `init` and capturing any `Set-Cookie` on the way back.
   *
   * Headers are normalised through `new Headers()` rather than spread: a
   * `Headers` instance or a `[key, value][]` tuple array both spread to
   * `{}`, silently dropping every header.
   */
  private async send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    // Per-request headers win over the client defaults.
    this.defaultHeaders.forEach((value, key) => {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    });

    if (this.cookies.size > 0 && !headers.has("Cookie")) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }

    const res = await this.request(path, { ...init, headers });

    for (const line of res.headers.getSetCookie()) {
      const parsed = parseSetCookie(line);

      if (parsed) {
        this.cookies.set(parsed.name, parsed.value);
      }
    }

    return res;
  }

  /**
   * Read a JSON body defensively (F5): a `204 No Content`, an empty body,
   * or a non-JSON `Content-Type` (a plain-text 404/500) returns `undefined`
   * rather than throwing an opaque `SyntaxError` from `res.json()`. The
   * caller still has `status` to assert on.
   */
  private async readJson<T>(res: Response): Promise<T> {
    if (res.status === 204 || res.status === 205) {
      return undefined as T;
    }

    const type = res.headers.get("Content-Type") ?? "";
    const text = await res.text();

    if (text.length === 0) {
      return undefined as T;
    }

    if (!type.includes("json")) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
  }
}
