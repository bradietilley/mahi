import { Application, EVENTS_TOKEN } from "@mahiframework/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionFailed,
  RequestSending,
  ResponseReceived,
  type HttpClientEvent,
} from "../src/events.js";
import { HttpClientFactory } from "../src/http-client-factory.js";
import { Http } from "../src/http.js";
import {
  HTTP_CLIENT_TOKEN,
  HttpClientServiceProvider,
} from "../src/http-client-service-provider.js";
import type { HttpClientConfig } from "../src/http-client-config.js";

afterEach(() => {
  Http.restore();
  // The provider swaps the module-level factory; put a clean one back so
  // one test's configuration can't leak into the next.
  Http.swap(new HttpClientFactory());
});

function bootApp(
  config: HttpClientConfig = {},
  configure?: (app: Application) => void,
): Application {
  const app = new Application();
  app.config.set("http-client", config);
  configure?.(app);

  const provider = new HttpClientServiceProvider(app);
  provider.register();
  provider.boot();

  return app;
}

describe("registration", () => {
  it("binds an HttpClientFactory singleton at HTTP_CLIENT_TOKEN", () => {
    const app = bootApp();
    const factory = app.make<HttpClientFactory>(HTTP_CLIENT_TOKEN);

    expect(factory).toBeInstanceOf(HttpClientFactory);
    expect(app.make<HttpClientFactory>(HTTP_CLIENT_TOKEN)).toBe(factory);
  });

  it("points the static Http surface at the bound factory", () => {
    const app = bootApp();
    expect(Http.getFactory()).toBe(app.make<HttpClientFactory>(HTTP_CLIENT_TOKEN));
  });

  it("works with no http-client config at all", async () => {
    const app = new Application();
    const provider = new HttpClientServiceProvider(app);
    provider.register();
    provider.boot();

    Http.fake({ "*": { ok: true } });
    expect((await Http.get("https://x.test/")).json("ok")).toBe(true);
  });
});

describe("config-driven defaults", () => {
  it("applies baseUrl to relative paths", async () => {
    bootApp({ baseUrl: "https://api.example.com" });
    Http.fake({ "*": { ok: true } });

    await Http.get("/users");
    Http.assertSent("https://api.example.com/users");
  });

  it("applies default headers", async () => {
    bootApp({ headers: { "X-App": "mahi" } });
    Http.fake({ "*": { ok: true } });

    await Http.get("https://x.test/");
    Http.assertSent((request) => request.header("x-app") === "mahi");
  });

  it("lets a per-request header override a configured one", async () => {
    bootApp({ headers: { "X-App": "mahi" } });
    Http.fake({ "*": { ok: true } });

    await Http.withHeader("X-App", "override").get("https://x.test/");
    Http.assertSent((request) => request.header("x-app") === "override");
  });

  it("applies the configured timeout", async () => {
    bootApp({ timeout: 5_000 });
    let seenSignal: unknown;

    await Http.withTransport(async (_request, init) => {
      seenSignal = init.signal;

      return new Response(null, { status: 200 });
    }).get("https://x.test/");

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("named clients", () => {
  const config: HttpClientConfig = {
    clients: {
      github: {
        baseUrl: "https://api.github.com",
        headers: { Accept: "application/vnd.github+json" },
      },
    },
  };

  it("resolves a named client's base URL and headers", async () => {
    bootApp(config);
    Http.fake({ "*": { ok: true } });

    await Http.client("github").get("/user");

    Http.assertSent("https://api.github.com/user");
    Http.assertSent((request) => request.header("accept") === "application/vnd.github+json");
  });

  it("throws for an unknown client, listing what is available", () => {
    bootApp(config);
    expect(() => Http.client("gitlab")).toThrow(
      'No HTTP client named "gitlab" is configured. Available: github.',
    );
  });

  it("reports (none) when no clients are configured", () => {
    bootApp();
    expect(() => Http.client("github")).toThrow(/Available: \(none\)\./);
  });
});

describe("global middleware", () => {
  it("runs on every request from the factory", async () => {
    const app = bootApp();
    const factory = app.make<HttpClientFactory>(HTTP_CLIENT_TOKEN);
    factory.withGlobalMiddleware((request, next) => next(request.withHeader("X-Traced", "1")));

    Http.fake({ "*": { ok: true } });
    await Http.get("https://x.test/");

    Http.assertSent((request) => request.header("x-traced") === "1");
  });
});

describe("events", () => {
  /** A minimal dispatcher matching the structural `EventSink` slice. */
  function recorder(): { dispatch: (event: HttpClientEvent) => void; events: HttpClientEvent[] } {
    const events: HttpClientEvent[] = [];

    return { dispatch: (event) => void events.push(event), events };
  }

  it("dispatches RequestSending and ResponseReceived when a dispatcher is registered", async () => {
    const sink = recorder();
    bootApp({}, (app) => app.instance(EVENTS_TOKEN, sink));

    Http.fake({ "*": { ok: true } });
    await Http.get("https://x.test/");

    expect(sink.events[0]).toBeInstanceOf(RequestSending);
    expect(sink.events[1]).toBeInstanceOf(ResponseReceived);
    expect((sink.events[1] as ResponseReceived).response.status).toBe(200);
  });

  it("dispatches ConnectionFailed on a transport failure", async () => {
    const sink = recorder();
    bootApp({}, (app) => app.instance(EVENTS_TOKEN, sink));

    Http.fake({ "*": Http.failedConnection("down") });
    await Http.get("https://x.test/").catch(() => undefined);

    expect(sink.events.at(-1)).toBeInstanceOf(ConnectionFailed);
  });

  it("fires RequestSending once per retry attempt", async () => {
    const sink = recorder();
    bootApp({}, (app) => app.instance(EVENTS_TOKEN, sink));

    Http.fake({ "*": Http.sequence().pushStatus(500).pushStatus(500).push({ ok: true }) });
    await Http.retry(3).get("https://x.test/");

    expect(sink.events.filter((event) => event instanceof RequestSending)).toHaveLength(3);
  });

  it("silently skips events when no dispatcher is registered", async () => {
    bootApp();
    Http.fake({ "*": { ok: true } });

    // @mahiframework/events stays an optional peer. A missing dispatcher must not
    // fail the request.
    await expect(Http.get("https://x.test/")).resolves.toBeDefined();
  });
});
