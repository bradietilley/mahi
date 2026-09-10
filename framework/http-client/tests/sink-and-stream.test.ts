import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Http } from "../src/http.js";
import { PendingRequest } from "../src/pending-request.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mahi-http-client-"));
});

afterEach(async () => {
  Http.restore();
  await rm(dir, { recursive: true, force: true });
});

describe("sink()", () => {
  it("writes a real response body to a file path", async () => {
    const path = join(dir, "download.txt");
    const http = new PendingRequest().withTransport(
      async () =>
        new Response("downloaded contents", {
          status: 200,
          // A non-empty `url` marks this as a real network response, which
          // takes the streaming path rather than the stub path.
          headers: { "content-type": "text/plain" },
        }),
    );

    await http.sink(path).get("https://x.test/file");
    expect(await readFile(path, "utf8")).toBe("downloaded contents");
  });

  it("writes to a WritableStream", async () => {
    const chunks: Uint8Array[] = [];
    const target = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    Http.fake({ "*": "streamed to sink" });
    await Http.sink(target).get("https://x.test/file");

    const written = new TextDecoder().decode(
      new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))),
    );
    expect(written).toBe("streamed to sink");
  });

  it("works under fake() and leaves body() readable", async () => {
    const path = join(dir, "stubbed.json");
    Http.fake({ "*": { id: 1 } });

    const response = await Http.sink(path).get("https://x.test/file");

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ id: 1 });
    // Laravel's stub path calls getContents() and thereby empties the body,
    // leaving a test with nothing to assert on. There is no reason to
    // reproduce that.
    expect(response.json("id")).toBe(1);
  });

  it("handles an empty body", async () => {
    const path = join(dir, "empty.txt");
    Http.fake({ "*": 204 });

    await Http.sink(path).get("https://x.test/file");
    expect(await readFile(path, "utf8")).toBe("");
  });
});

describe("stream()", () => {
  it("gives a ReadableStream instead of buffering", async () => {
    const http = new PendingRequest().withTransport(
      async () => new Response("chunk one", { status: 200 }),
    );

    const response = await http.stream().get("https://x.test/big");
    const stream = response.stream();

    expect(stream).toBeInstanceOf(ReadableStream);
    expect(await new Response(stream).text()).toBe("chunk one");
  });

  it("body() throws with a message pointing at stream()", async () => {
    const http = new PendingRequest().withTransport(
      async () => new Response("data", { status: 200 }),
    );
    const response = await http.stream().get("https://x.test/big");

    expect(() => response.body()).toThrow(/never buffered/);
    expect(() => response.body()).toThrow(/response\.stream\(\)/);
  });

  it("json() throws for the same reason", async () => {
    const http = new PendingRequest().withTransport(
      async () => new Response("{}", { status: 200 }),
    );
    const response = await http.stream().get("https://x.test/big");

    expect(() => response.json()).toThrow(/never buffered/);
  });

  it("bytes() throws for the same reason", async () => {
    const http = new PendingRequest().withTransport(async () => new Response("x", { status: 200 }));
    const response = await http.stream().get("https://x.test/big");

    expect(() => response.bytes()).toThrow(/never buffered/);
  });

  it("leaves a large body unread until the stream is consumed", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;

        if (pulled > 3) {
          controller.close();

          return;
        }

        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
    });

    const http = new PendingRequest().withTransport(
      async () => new Response(body, { status: 200 }),
    );
    const response = await http.stream().get("https://x.test/big");

    // The body has not been drained: the point of stream() is that a 2 GB
    // download never lands in memory just because it was requested. At
    // most one chunk is resident, and that one is the ReadableStream's own
    // default highWaterMark pre-pull, not us buffering.
    expect(pulled).toBeLessThanOrEqual(1);

    const text = await new Response(response.stream()).text();
    expect(text).toHaveLength(3 * 1024);
    expect(pulled).toBe(4);
  });

  it("buffers the whole body when stream() was not requested", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;

        if (pulled > 3) {
          controller.close();

          return;
        }

        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
    });

    const http = new PendingRequest().withTransport(
      async () => new Response(body, { status: 200 }),
    );
    const response = await http.get("https://x.test/big");

    // The contrast that makes the test above meaningful.
    expect(response.body()).toHaveLength(3 * 1024);
  });

  it("status and headers are still available on a streamed response", async () => {
    const http = new PendingRequest().withTransport(
      async () => new Response("x", { status: 206, headers: { "content-range": "bytes 0-1/2" } }),
    );

    const response = await http.stream().get("https://x.test/big");
    expect(response.status).toBe(206);
    expect(response.header("content-range")).toBe("bytes 0-1/2");
  });
});
