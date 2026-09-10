import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { Signer, SIGNER_TOKEN } from "@mahi/encryption";
import { Request } from "../src/request.js";
import { RouteRegistry } from "../src/route-registry.js";
import { UrlGenerator, RouteNotFoundError } from "../src/url-generator.js";
import { hasValidSignature } from "../src/signed-url.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");

function setup(): { app: Application; registry: RouteRegistry; url: UrlGenerator } {
  const app = new Application();
  app.instance(SIGNER_TOKEN, new Signer(KEY));
  app.config.set("http", { url: "https://app.test" });
  setCurrentApp(app);

  const registry = new RouteRegistry();
  registry.register("posts.show", { methods: ["GET"], path: "/posts/{post}" });
  registry.register("users.posts", { methods: ["GET"], path: "/users/{username}/posts" });
  registry.register("unsubscribe", { methods: ["GET"], path: "/unsubscribe/{user}" });

  return { app, registry, url: new UrlGenerator(app, registry) };
}

describe("UrlGenerator.route", () => {
  beforeEach(setup);
  afterEach(() => clearCurrentApp());

  it("substitutes params and builds an absolute URL from http.url config", () => {
    const { url } = setup();
    expect(url.route("posts.show", { post: 42 })).toBe("https://app.test/posts/42");
  });

  it("returns a relative URL when absolute:false", () => {
    const { url } = setup();
    expect(url.route("posts.show", { post: 42 }, { absolute: false })).toBe("/posts/42");
  });

  it("appends leftover params as query string", () => {
    const { url } = setup();
    expect(url.route("posts.show", { post: 42, page: 2 }, { absolute: false })).toBe(
      "/posts/42?page=2",
    );
  });

  it("throws on unknown route name", () => {
    const { url } = setup();
    expect(() => url.route("nope")).toThrow(RouteNotFoundError);
  });

  it("throws on a missing required param", () => {
    const { url } = setup();
    expect(() => url.route("posts.show", {})).toThrow(/Missing required parameter/);
  });

  it("borrows the in-flight request root over config", () => {
    const { app, url } = setup();
    app.context.runScoped(() => {
      // Constructing a Request publishes its root into the Context overlay.
      Request.create("/posts/1", "GET", {}, { headers: { host: "live.example" } });
      // Request.create doesn't set scheme/host from headers, so simulate:
      app.context.add("__mahi_request_root", "https://live.example");
      expect(url.route("posts.show", { post: 1 })).toBe("https://live.example/posts/1");
    });
  });
});

describe("UrlGenerator.signedRoute", () => {
  beforeEach(setup);
  afterEach(() => clearCurrentApp());

  function requestFor(signedUrl: string): Request {
    const relative = signedUrl.replace(/^https?:\/\/[^/]+/, "");
    const [path, query = ""] = relative.split("?");

    return Request.create(
      path!,
      "GET",
      {},
      { query: Object.fromEntries(new URLSearchParams(query)) },
    );
  }

  it("produces a URL that verifies against the same signer", () => {
    const { url } = setup();
    const signed = url.signedRoute("unsubscribe", { user: 7 });
    expect(signed).toContain("signature=");
    expect(hasValidSignature(requestFor(signed))).toBe(true);
  });

  it("includes an expiry that verifies before it lapses", () => {
    const { url } = setup();
    const signed = url.signedRoute(
      "unsubscribe",
      { user: 7 },
      { expiresInSeconds: 100, now: 1000 },
    );
    expect(signed).toContain("expires=1100");
    expect(hasValidSignature(requestFor(signed), { now: 1050 })).toBe(true);
    expect(hasValidSignature(requestFor(signed), { now: 1200 })).toBe(false);
  });

  it("rejects reserved signature/expires params", () => {
    const { url } = setup();
    expect(() => url.signedRoute("unsubscribe", { user: 7, signature: "x" })).toThrow(/reserved/);
  });
});
