import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { Request } from "../src/request.js";
import { Router } from "../src/router.js";
import { HttpResponse } from "../src/response.js";
import { createErrorHandler, ErrorRendererRegistry } from "../src/middleware/error-handler.js";
import {
  trustProxies,
  trustHosts,
  ipMatches,
  hostMatches,
  hostWithoutPort,
  hostsFromUrl,
} from "../src/trusted-proxies.js";

describe("ipMatches()", () => {
  it("matches an exact IP", () => {
    expect(ipMatches("1.2.3.4", "1.2.3.4")).toBe(true);
    expect(ipMatches("1.2.3.5", "1.2.3.4")).toBe(false);
  });

  it("matches within an IPv4 CIDR block", () => {
    expect(ipMatches("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipMatches("11.0.0.1", "10.0.0.0/8")).toBe(false);
    expect(ipMatches("192.168.1.50", "192.168.1.0/24")).toBe(true);
    expect(ipMatches("192.168.2.50", "192.168.1.0/24")).toBe(false);
  });

  it("treats * as any", () => {
    expect(ipMatches("8.8.8.8", "*")).toBe(true);
  });

  it("normalizes IPv6-mapped IPv4 addresses", () => {
    expect(ipMatches("::ffff:10.0.0.1", "10.0.0.0/8")).toBe(true);
  });

  it("rejects malformed CIDR", () => {
    expect(ipMatches("1.2.3.4", "1.2.3.4/33")).toBe(false);
  });
});

describe("hostMatches()", () => {
  it("matches an exact host", () => {
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("evil.com", "example.com")).toBe(false);
  });

  it("matches a wildcard subdomain, including the bare apex", () => {
    expect(hostMatches("api.example.com", "*.example.com")).toBe(true);
    expect(hostMatches("example.com", "*.example.com")).toBe(true);
    expect(hostMatches("api.evil.com", "*.example.com")).toBe(false);
  });
});

describe("hostWithoutPort()", () => {
  it("strips a port and lowercases", () => {
    expect(hostWithoutPort("Example.com:8080")).toBe("example.com");
    expect(hostWithoutPort("example.com")).toBe("example.com");
  });

  it("keeps an IPv6 literal intact", () => {
    // Splitting on ":" — the obvious implementation — yields "[" here,
    // so an IPv6 host could never match an allow-list and was 403'd.
    expect(hostWithoutPort("[::1]:3000")).toBe("[::1]");
    expect(hostWithoutPort("[2001:db8::1]")).toBe("[2001:db8::1]");
  });
});

describe("hostsFromUrl()", () => {
  it("extracts the hostname, dropping scheme and port", () => {
    expect(hostsFromUrl("https://api.example.com:8443")).toEqual(["api.example.com"]);
  });

  it("returns [] for missing or unparseable input, so callers can skip registration", () => {
    expect(hostsFromUrl(undefined)).toEqual([]);
    expect(hostsFromUrl("not a url")).toEqual([]);
  });
});

/**
 * Build a Request whose `raw()` context reports a fixed socket peer,
 * shaped the way `@hono/node-server`'s `getConnInfo()` reads it. Pass
 * `peer: undefined` to simulate an adapter with no socket at all.
 */
function requestWithPeer(
  peer: string | undefined,
  headers: Record<string, string> = {},
  path = "/things",
): Request {
  const req = Request.create(path, "GET", {}, { headers });
  const lower: Record<string, string> = {};

  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }

  const fakeContext = {
    env: { incoming: { socket: { remoteAddress: peer, remoteFamily: "IPv4" } } },
    req: { header: (key: string) => lower[key.toLowerCase()] },
  } as never;
  (req as unknown as { rawContext: unknown }).rawContext = fakeContext;

  return req;
}

/** Run a pipe and hand back the Request it passed downstream. */
async function run(pipe: ReturnType<typeof trustProxies>, request: Request): Promise<Request> {
  let seen: Request | undefined;
  await pipe(request, async (r) => {
    seen = r;

    return new Response();
  });

  return seen!;
}

describe("trustProxies() — client IP resolution", () => {
  it("trusts X-Forwarded-For when the peer is a configured proxy", async () => {
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-for": "203.0.113.7" });
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).ip()).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For from an untrusted peer, pinning to the socket IP", async () => {
    const req = requestWithPeer("198.51.100.9", { "x-forwarded-for": "203.0.113.7" });
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).ip()).toBe("198.51.100.9");
  });

  it("falls back to the peer IP when a trusted proxy sends no XFF", async () => {
    const req = requestWithPeer("10.0.0.5");
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).ip()).toBe("10.0.0.5");
  });

  it("takes the RIGHTMOST untrusted hop, not the leftmost", async () => {
    // The attacker sends `X-Forwarded-For: 1.2.3.4`; the trusted proxy
    // APPENDS the real address. Taking the leftmost entry — as a naive
    // implementation does — hands the attacker their own fiction back.
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).ip()).toBe("203.0.113.7");
  });

  it("walks back through several trusted hops to the first untrusted one", async () => {
    const req = requestWithPeer("10.0.0.5", {
      "x-forwarded-for": "1.2.3.4, 203.0.113.7, 10.0.0.9, 10.0.0.8",
    });
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).ip()).toBe("203.0.113.7");
  });

  it("falls back to the peer when every hop in the chain is trusted", async () => {
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-for": "10.0.0.9, 10.0.0.8" });
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).ip()).toBe("10.0.0.5");
  });

  it("fails CLOSED when the peer cannot be determined", async () => {
    // No socket to read (in-process dispatch, non-Node adapter). The
    // header must NOT be believed just because the peer is unknown.
    const req = requestWithPeer(undefined, { "x-forwarded-for": "1.2.3.4" });
    expect((await run(trustProxies(["*"]), req)).ip()).toBeUndefined();
  });
});

describe("trustProxies() — forwarded origin", () => {
  it("applies X-Forwarded-Proto so secure() and root() reflect the real scheme", async () => {
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-proto": "https" });
    const resolved = await run(trustProxies(["10.0.0.0/8"]), req);

    expect(resolved.secure()).toBe(true);
    expect(resolved.scheme()).toBe("https");
    expect(resolved.root()).toBe("https://localhost");
  });

  it("applies X-Forwarded-Host, and X-Forwarded-Port when the host has none", async () => {
    const req = requestWithPeer("10.0.0.5", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "api.example.com",
      "x-forwarded-port": "8443",
    });
    const resolved = await run(trustProxies(["10.0.0.0/8"]), req);

    expect(resolved.root()).toBe("https://api.example.com:8443");
    expect(resolved.httpHost()).toBe("api.example.com:8443");
  });

  it("takes the last hop of a chained forwarding header", async () => {
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-proto": "https, http" });
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).scheme()).toBe("http");
  });

  it("ignores a bogus scheme rather than echoing it into generated URLs", async () => {
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-proto": "javascript" });
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).scheme()).toBe("http");
  });

  it("ignores a malformed forwarded host", async () => {
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-host": "evil.com/../path" });
    expect((await run(trustProxies(["10.0.0.0/8"]), req)).httpHost()).toBe("localhost");
  });

  it("does not apply forwarding headers from an untrusted peer", async () => {
    const req = requestWithPeer("198.51.100.9", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "evil.example",
    });
    const resolved = await run(trustProxies(["10.0.0.0/8"]), req);

    expect(resolved.secure()).toBe(false);
    expect(resolved.httpHost()).toBe("localhost");
  });

  it("leaves the origin alone when forwardedOrigin is off", async () => {
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-proto": "https" });
    const resolved = await run(trustProxies(["10.0.0.0/8"], { forwardedOrigin: false }), req);

    expect(resolved.secure()).toBe(false);
  });
});

describe("trustHosts() middleware", () => {
  function build() {
    const app = new Application();
    const hono = new Hono();
    hono.onError(createErrorHandler(app, new ErrorRendererRegistry()));

    return { hono, router: new Router(hono) };
  }

  it("allows a request with an allowed Host", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(trustHosts(["example.com", "*.example.com"]));

    const res = await hono.request("http://api.example.com/things");
    expect(res.status).toBe(200);
  });

  it("403s a request with a spoofed Host", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(trustHosts(["example.com"]));

    const res = await hono.request("http://evil.com/things");
    expect(res.status).toBe(403);
  });

  it("ignores the port when matching", async () => {
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(trustHosts(["example.com"]));

    const res = await hono.request("http://example.com:8080/things");
    expect(res.status).toBe(200);
  });

  it("allows an IPv6 literal host", async () => {
    const { hono, router } = build();
    router.get("/things", () => HttpResponse.json({ ok: true })).middleware(trustHosts(["[::1]"]));

    const res = await hono.request("http://[::1]:3000/things");
    expect(res.status).toBe(200);
  });

  it("checks the host a trusted proxy forwarded, not the raw socket Host", async () => {
    // The value that matters is the one the URL generator will use for
    // links. Checking the raw `Host` header instead would let a
    // forwarded host through unvalidated — which is the exact link
    // poisoning this middleware exists to stop.
    const req = requestWithPeer("10.0.0.5", { "x-forwarded-host": "evil.example" });
    const resolved = await run(trustProxies(["10.0.0.0/8"]), req);

    await expect(
      trustHosts(["example.com"])(resolved, async () => new Response()),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("allows an in-process dispatch, which carries no Host header", async () => {
    // `hono.request("/things")` sets no Host at all; the effective host
    // is `localhost` from the URL. Reading the raw header would 403
    // every test in every app that registers this pipe.
    const { hono, router } = build();
    router
      .get("/things", () => HttpResponse.json({ ok: true }))
      .middleware(trustHosts(["localhost"]));

    expect((await hono.request("/things")).status).toBe(200);
  });
});
