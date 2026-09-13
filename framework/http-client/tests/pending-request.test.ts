import { afterEach, describe, expect, it } from "vitest";
import { ClientRequest } from "../src/client-request.js";
import { Http } from "../src/http.js";
import { PendingRequest } from "../src/pending-request.js";
import type { Transport } from "../src/transport.js";

/** Captures the request the transport was handed, answering an empty 200. */
function capture(): { transport: Transport; last: () => Request } {
  let seen: Request | undefined;

  return {
    transport: async (request) => {
      seen = request;

      return new Response(null, { status: 200 });
    },
    last: () => {
      if (!seen) {
        throw new Error("No request was sent.");
      }

      return seen;
    },
  };
}

/** A `PendingRequest` wired to a capturing transport. */
function client(): { http: PendingRequest; last: () => Request } {
  const { transport, last } = capture();

  return { http: new PendingRequest().withTransport(transport), last };
}

describe("URL resolution", () => {
  it("joins baseUrl with a relative path, normalising slashes", async () => {
    const { http, last } = client();
    await http.baseUrl("https://api.example.com/v1/").get("/users");
    expect(last().url).toBe("https://api.example.com/v1/users");
  });

  it("joins without duplicating or dropping a slash", async () => {
    const { http, last } = client();
    await http.baseUrl("https://api.example.com").get("users");
    expect(last().url).toBe("https://api.example.com/users");
  });

  it("lets an absolute URL win over baseUrl", async () => {
    const { http, last } = client();
    await http.baseUrl("https://api.example.com").get("https://other.test/thing");
    expect(last().url).toBe("https://other.test/thing");
  });

  it("expands {placeholders} from withUrlParameters", async () => {
    const { http, last } = client();
    await http
      .withUrlParameters({ host: "api.github.com", repo: "mahi" })
      .get("https://{host}/repos/{repo}");
    expect(last().url).toBe("https://api.github.com/repos/mahi");
  });

  it("percent-encodes url parameters so they cannot inject path segments", async () => {
    const { http, last } = client();
    await http.withUrlParameters({ repo: "a/b?c" }).get("https://x.test/{repo}");
    expect(last().url).toBe("https://x.test/a%2Fb%3Fc");
  });

  it("leaves an unmatched placeholder in place rather than blanking it", async () => {
    const { http, last } = client();
    await http.withUrlParameters({ a: "1" }).get("https://x.test/{a}/{missing}");
    expect(last().url).toBe("https://x.test/1/%7Bmissing%7D");
  });
});

describe("query parameters", () => {
  it("appends to a URL that already has a query string", async () => {
    const { http, last } = client();
    await http.get("https://x.test/search?existing=1", { q: "ada" });
    const url = new URL(last().url);
    expect(url.searchParams.get("existing")).toBe("1");
    expect(url.searchParams.get("q")).toBe("ada");
  });

  it("merges withQueryParameters with per-call query, the call winning", async () => {
    const { http, last } = client();
    await http.withQueryParameters({ page: 1, per: 10 }).get("https://x.test/", { page: 2 });
    const url = new URL(last().url);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per")).toBe("10");
  });

  it("expands an array into repeated keys", async () => {
    const { http, last } = client();
    await http.get("https://x.test/", { tag: ["a", "b"] });
    expect(new URL(last().url).searchParams.getAll("tag")).toEqual(["a", "b"]);
  });

  it("bracket-nests a nested object rather than serialising [object Object]", async () => {
    const { http, last } = client();
    await http.get("https://x.test/", { filter: { status: "active" } });
    const url = new URL(last().url);
    expect(url.searchParams.get("filter[status]")).toBe("active");
    expect(url.search).not.toContain("object");
  });

  it("skips null and undefined rather than serialising them as strings", async () => {
    const { http, last } = client();
    await http.get("https://x.test/", { a: null, b: undefined, c: "keep" });
    const url = new URL(last().url);
    expect(url.searchParams.has("a")).toBe(false);
    expect(url.searchParams.has("b")).toBe(false);
    expect(url.searchParams.get("c")).toBe("keep");
  });
});

describe("body formats", () => {
  it("asJson (the default) serialises JSON with the right Content-Type", async () => {
    const { http, last } = client();
    await http.post("https://x.test/", { name: "Ada" });
    const request = last();
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.text()).toBe('{"name":"Ada"}');
  });

  it("asForm serialises url-encoded with the right Content-Type", async () => {
    const { http, last } = client();
    await http.asForm().post("https://x.test/", { name: "Ada Lovelace", n: 1 });
    const request = last();
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(await request.text()).toBe("name=Ada+Lovelace&n=1");
  });

  it("asForm bracket-nests a nested object rather than [object Object]", async () => {
    const { http, last } = client();
    await http.asForm().post("https://x.test/", { a: { b: 1 } });
    const raw = await last().text();
    // Decode via URLSearchParams so `[`/`]` escaping doesn't matter.
    expect(new URLSearchParams(raw).get("a[b]")).toBe("1");
    expect(raw).not.toContain("object");
  });

  it("asForm keeps scalar arrays as repeated keys", async () => {
    const { http, last } = client();
    await http.asForm().post("https://x.test/", { tag: ["a", "b"] });
    const params = new URLSearchParams(await last().text());
    expect(params.getAll("tag")).toEqual(["a", "b"]);
  });

  it("asMultipart sends FormData and lets fetch generate the boundary header", async () => {
    const { http, last } = client();
    await http.asMultipart().post("https://x.test/", { name: "Ada" });
    const contentType = last().headers.get("content-type") ?? "";
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("asMultipart bracket-nests a nested object rather than [object Object]", async () => {
    const { http, last } = client();
    await http.asMultipart().post("https://x.test/", { user: { name: "Ada" } });
    const form = await last().formData();
    expect(form.get("user[name]")).toBe("Ada");
  });

  it("withBody sends content verbatim", async () => {
    const { http, last } = client();
    await http.withBody("raw text", "text/plain").post("https://x.test/");
    const request = last();
    expect(request.headers.get("content-type")).toBe("text/plain");
    expect(await request.text()).toBe("raw text");
  });

  it("contentType() overrides the format's implied type", async () => {
    const { http, last } = client();
    await http.contentType("application/vnd.api+json").post("https://x.test/", { a: 1 });
    expect(last().headers.get("content-type")).toBe("application/vnd.api+json");
  });

  it("sends no body for a GET even when data is configured", async () => {
    const { http, last } = client();
    await http.send("GET", "https://x.test/", { data: { a: 1 } });
    expect(last().body).toBeNull();
  });
});

describe("auth headers", () => {
  it("withToken defaults to Bearer", async () => {
    const { http, last } = client();
    await http.withToken("abc123").get("https://x.test/");
    expect(last().headers.get("authorization")).toBe("Bearer abc123");
  });

  it("withToken accepts a custom scheme", async () => {
    const { http, last } = client();
    await http.withToken("abc123", "Token").get("https://x.test/");
    expect(last().headers.get("authorization")).toBe("Token abc123");
  });

  it("withBasicAuth base64-encodes the credentials", async () => {
    const { http, last } = client();
    await http.withBasicAuth("ada", "s3cret").get("https://x.test/");
    const expected = Buffer.from("ada:s3cret").toString("base64");
    expect(last().headers.get("authorization")).toBe(`Basic ${expected}`);
  });
});

describe("headers", () => {
  it("withHeaders REPLACES on collision rather than accumulating", async () => {
    const { http, last } = client();
    await http.withHeaders({ "X-Try": "1" }).withHeaders({ "X-Try": "2" }).get("https://x.test/");

    // Laravel's array_merge_recursive would yield "1, 2" here. That is a
    // bug people trip over, and the only reason its replaceHeaders() exists.
    expect(last().headers.get("x-try")).toBe("2");
  });

  it("appendHeader produces a multi-value header", async () => {
    const { http, last } = client();
    await http.appendHeader("X-Multi", "a").appendHeader("X-Multi", "b").get("https://x.test/");
    expect(last().headers.get("x-multi")).toBe("a, b");
  });

  it("acceptJson and withUserAgent set their headers", async () => {
    const { http, last } = client();
    await http.acceptJson().withUserAgent("mahi/1.0").get("https://x.test/");
    const request = last();
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.get("user-agent")).toBe("mahi/1.0");
  });

  it("withCookies sets a Cookie header", async () => {
    const { http, last } = client();
    await http.withCookies({ session: "abc", theme: "dark" }).get("https://x.test/");
    expect(last().headers.get("cookie")).toBe("session=abc; theme=dark");
  });
});

describe("immutability", () => {
  it("leaves the base client unchanged after a derived one sends", async () => {
    const { transport, last } = capture();
    const base = new PendingRequest().withTransport(transport).baseUrl("https://x.test");

    await base.withToken("secret").post("/a", { n: 1 });
    expect(last().headers.get("authorization")).toBe("Bearer secret");

    // The base never saw withToken, and its body/payload state was not
    // consumed by the send, Laravel nulls pendingBody on send, making a
    // configured client unsafe to reuse.
    await base.post("/b", { n: 2 });
    expect(last().headers.get("authorization")).toBeNull();
    expect(await last().text()).toBe('{"n":2}');
  });

  it("does not leak state between two clients derived from one base", async () => {
    const { transport, last } = capture();
    const base = new PendingRequest().withTransport(transport);
    const a = base.withHeader("X-Client", "a");
    const b = base.withHeader("X-Client", "b");

    await a.get("https://x.test/");
    expect(last().headers.get("x-client")).toBe("a");
    await b.get("https://x.test/");
    expect(last().headers.get("x-client")).toBe("b");
  });

  it("returns a new instance from every fluent method", () => {
    const base = new PendingRequest();
    expect(base.withToken("t")).not.toBe(base);
    expect(base.baseUrl("https://x.test")).not.toBe(base);
    expect(base.asForm()).not.toBe(base);
    expect(base.retry(3)).not.toBe(base);
  });

  it("supports concurrent sends from one configured client", async () => {
    Http.fake({ "*": { ok: true } });
    const github = Http.baseUrl("https://api.example.com").withToken("t");

    const [a, b] = await Promise.all([github.get("/a"), github.get("/b")]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    Http.assertSentCount(2);
    Http.restore();
  });
});

describe("ClientRequest", () => {
  afterEach(() => {
    Http.restore();
  });

  it("exposes the decoded payload via data(), not a re-parsed body", async () => {
    Http.fake();
    await Http.post("https://x.test/users", { name: "Ada", tags: ["math"] });

    const [request] = Http.recorded()[0]!;
    expect(request.data()).toEqual({ name: "Ada", tags: ["math"] });
  });

  it("reports the body format via isJson/isForm/isMultipart", async () => {
    const json = new ClientRequest({
      method: "POST",
      url: "https://x.test/",
      headers: new Headers({ "content-type": "application/json" }),
    });
    expect(json.isJson()).toBe(true);
    expect(json.isForm()).toBe(false);

    const form = new ClientRequest({
      method: "POST",
      url: "https://x.test/",
      headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
    });
    expect(form.isForm()).toBe(true);
  });

  it("hasHeader matches presence and, optionally, an exact value", () => {
    const request = new ClientRequest({
      method: "GET",
      url: "https://x.test/",
      headers: new Headers({ "X-A": "1" }),
    });
    expect(request.hasHeader("x-a")).toBe(true);
    expect(request.hasHeader("x-a", "1")).toBe(true);
    expect(request.hasHeader("x-a", "2")).toBe(false);
    expect(request.hasHeader("x-b")).toBe(false);
  });

  it("withHeader returns a copy, leaving the original untouched", () => {
    const request = new ClientRequest({
      method: "GET",
      url: "https://x.test/",
      headers: new Headers(),
    });
    const next = request.withHeader("X-A", "1");
    expect(next).not.toBe(request);
    expect(request.header("X-A")).toBeUndefined();
    expect(next.header("X-A")).toBe("1");
  });
});

describe("transport behaviour", () => {
  it("withoutRedirecting sets redirect: manual on the init", async () => {
    let seenInit: RequestInit | undefined;
    const http = new PendingRequest().withTransport(async (_request, init) => {
      seenInit = init;

      return new Response(null, { status: 200 });
    });

    await http.withoutRedirecting().get("https://x.test/");
    expect(seenInit?.redirect).toBe("manual");
  });

  it("timeout attaches an AbortSignal", async () => {
    let seenInit: RequestInit | undefined;
    const http = new PendingRequest().withTransport(async (_request, init) => {
      seenInit = init;

      return new Response(null, { status: 200 });
    });

    await http.timeout(5_000).get("https://x.test/");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still honours timeout when the caller supplies their own signal", async () => {
    let seenSignal: AbortSignal | undefined;
    const http = new PendingRequest().withTransport(async (_request, init) => {
      seenSignal = init.signal ?? undefined;

      // Never resolves on its own, only an abort ends this request, so a
      // dropped timeout would hang forever instead of throwing.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });

    const userController = new AbortController();
    await expect(
      http.timeout(5).withFetchOptions({ signal: userController.signal }).get("https://x.test/"),
    ).rejects.toThrow();

    // The signal handed to fetch is a composite that aborts on the timeout
    // even though the user's controller never fired.
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(true);
    expect(userController.signal.aborted).toBe(false);
  });

  it("withFetchOptions merges raw init through to the transport", async () => {
    let seenInit: (RequestInit & Record<string, unknown>) | undefined;
    const http = new PendingRequest().withTransport(async (_request, init) => {
      seenInit = init;

      return new Response(null, { status: 200 });
    });

    // `dispatcher` is undici's non-standard proxy/pool hook, the reason
    // init travels alongside the Request rather than through it. What is
    // under test is that the value survives the trip untouched, so a
    // sentinel is used rather than a real `Dispatcher`; `@types/node` types
    // the key, hence the cast.
    const dispatcher = { marker: true } as unknown as NonNullable<RequestInit["dispatcher"]>;
    await http.withFetchOptions({ dispatcher, keepalive: true }).get("https://x.test/");

    expect(seenInit?.dispatcher).toBe(dispatcher);
    expect(seenInit?.keepalive).toBe(true);
  });

  it("sets duplex: half automatically for a ReadableStream body", async () => {
    let seenInit: (RequestInit & Record<string, unknown>) | undefined;
    const http = new PendingRequest().withTransport(async (request) => {
      // The Request constructor is what would throw without duplex, so
      // reaching the transport at all proves it was set.
      seenInit = { ok: request.method === "POST" };

      return new Response(null, { status: 200 });
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });

    await expect(http.withBody(body).post("https://x.test/")).resolves.toBeDefined();
    expect(seenInit?.ok).toBe(true);
  });
});
