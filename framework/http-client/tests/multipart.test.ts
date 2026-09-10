import { afterEach, describe, expect, it } from "vitest";
import { Http } from "../src/http.js";
import { PendingRequest } from "../src/pending-request.js";
import type { Transport } from "../src/transport.js";

afterEach(() => {
  Http.restore();
});

/** Captures the outgoing platform `Request` so its multipart body can be parsed. */
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

describe("attach()", () => {
  it("forces multipart even without asMultipart()", async () => {
    const { transport, last } = capture();
    await new PendingRequest()
      .withTransport(transport)
      .attach("document", "file contents", "doc.txt")
      .post("https://x.test/upload");

    expect(last().headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("generates a boundary in the Content-Type", async () => {
    const { transport, last } = capture();
    await new PendingRequest()
      .withTransport(transport)
      .attach("f", "x")
      .post("https://x.test/upload");

    const boundary = (last().headers.get("content-type") ?? "").split("boundary=")[1];
    expect(boundary).toBeTruthy();
    expect(await last().text()).toContain(boundary!);
  });

  it("sends the file with its name and filename", async () => {
    const { transport, last } = capture();
    await new PendingRequest()
      .withTransport(transport)
      .attach("document", "hello world", "greeting.txt")
      .post("https://x.test/upload");

    const form = await last().formData();
    const file = form.get("document");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("greeting.txt");
    expect(await (file as File).text()).toBe("hello world");
  });

  it("accepts Uint8Array contents", async () => {
    const { transport, last } = capture();
    await new PendingRequest()
      .withTransport(transport)
      .attach("bin", new Uint8Array([1, 2, 3]), "data.bin")
      .post("https://x.test/upload");

    const file = (await last().formData()).get("bin") as File;
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("accepts a Blob and a ReadableStream", async () => {
    const { transport, last } = capture();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("from stream"));
        controller.close();
      },
    });

    await new PendingRequest()
      .withTransport(transport)
      .attach("blob", new Blob(["from blob"]), "a.txt")
      .attach("stream", stream, "b.txt")
      .post("https://x.test/upload");

    const form = await last().formData();
    expect(await (form.get("blob") as File).text()).toBe("from blob");
    expect(await (form.get("stream") as File).text()).toBe("from stream");
  });

  it("applies a per-attachment Content-Type header", async () => {
    const { transport, last } = capture();
    await new PendingRequest()
      .withTransport(transport)
      .attach("doc", "{}", "a.json", { "Content-Type": "application/json" })
      .post("https://x.test/upload");

    expect(((await last().formData()).get("doc") as File).type).toBe("application/json");
  });

  it("sends multiple attachments", async () => {
    const { transport, last } = capture();
    await new PendingRequest()
      .withTransport(transport)
      .attach("first", "one", "1.txt")
      .attach("second", "two", "2.txt")
      .post("https://x.test/upload");

    const form = await last().formData();
    expect(await (form.get("first") as File).text()).toBe("one");
    expect(await (form.get("second") as File).text()).toBe("two");
  });

  it("sends attachments alongside regular fields", async () => {
    const { transport, last } = capture();
    await new PendingRequest()
      .withTransport(transport)
      .attach("avatar", "image bytes", "me.png")
      .post("https://x.test/profile", { name: "Ada", age: 36 });

    const form = await last().formData();
    expect(form.get("name")).toBe("Ada");
    expect(form.get("age")).toBe("36");
    expect(await (form.get("avatar") as File).text()).toBe("image bytes");
  });

  it("expands an array field into repeated entries", async () => {
    const { transport, last } = capture();
    await new PendingRequest()
      .withTransport(transport)
      .asMultipart()
      .post("https://x.test/", { tags: ["a", "b"] });

    expect((await last().formData()).getAll("tags")).toEqual(["a", "b"]);
  });
});

describe("hasFile()", () => {
  it("matches on name alone", async () => {
    Http.fake();
    await Http.attach("document", "contents", "doc.txt").post("https://x.test/upload");

    Http.assertSent((request) => request.hasFile("document"));
    Http.assertSent((request) => !request.hasFile("missing"));
  });

  it("matches on name and contents", async () => {
    Http.fake();
    await Http.attach("document", "the contents", "doc.txt").post("https://x.test/upload");

    Http.assertSent((request) => request.hasFile("document", "the contents"));
    Http.assertSent((request) => !request.hasFile("document", "other contents"));
  });

  it("matches on name, contents, and filename", async () => {
    Http.fake();
    await Http.attach("document", "the contents", "doc.txt").post("https://x.test/upload");

    Http.assertSent((request) => request.hasFile("document", "the contents", "doc.txt"));
    Http.assertSent((request) => !request.hasFile("document", "the contents", "other.txt"));
  });

  it("is false on a request with no multipart body", async () => {
    Http.fake();
    await Http.post("https://x.test/users", { name: "Ada" });

    Http.assertSent((request) => !request.hasFile("document"));
  });

  it("reports isMultipart() on an attached request", async () => {
    Http.fake();
    await Http.attach("f", "x").post("https://x.test/upload");

    Http.assertSent((request) => request.isMultipart());
  });
});
