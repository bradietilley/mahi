import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Application } from "@mahiframework/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorageDriver } from "../src/drivers/local-storage-driver.js";
import { pathFromPublicUrl, joinPublicUrl, publicUrlPathname } from "../src/public-url.js";
import { servePublicDisk, serveStoredFile } from "../src/serve-stored-file.js";
import { StorageServiceProvider, STORAGE_TOKEN } from "../src/storage-service-provider.js";
import { StorageManager } from "../src/storage-manager.js";

describe("public URL helpers", () => {
  it("joinPublicUrl strips extra slashes on both sides", () => {
    expect(joinPublicUrl("/storage/", "/avatars/a.png")).toBe("/storage/avatars/a.png");
  });

  it("publicUrlPathname uses only the pathname of an absolute URL prefix", () => {
    expect(publicUrlPathname("http://localhost:8000/storage")).toBe("/storage");
    expect(publicUrlPathname("/storage/")).toBe("/storage");
  });

  it("pathFromPublicUrl strips the prefix and decodes the rest", () => {
    expect(pathFromPublicUrl("/storage/avatars/a.png", "/storage")).toBe("avatars/a.png");
    expect(pathFromPublicUrl("/storage/posts/x%20y.png", "/storage")).toBe("posts/x y.png");
    expect(pathFromPublicUrl("/media/a.png", "/storage")).toBeNull();
    expect(pathFromPublicUrl("/storage", "/storage")).toBeNull();
  });
});

describe("serveStoredFile", () => {
  let tmpDir: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-serve-test-"));
    driver = new LocalStorageDriver(tmpDir, "/storage");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the file with a guessed Content-Type", async () => {
    await driver.put("avatars/a.png", Buffer.from("png-bytes"));
    const res = await serveStoredFile(driver, "avatars/a.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength("png-bytes")));
    expect(await res.text()).toBe("png-bytes");
  });

  it("sets Cache-Control when asked", async () => {
    await driver.put("a.txt", "x");
    const res = await serveStoredFile(driver, "a.txt", {
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("404s for a missing file", async () => {
    const res = await serveStoredFile(driver, "missing.png");
    expect(res.status).toBe(404);
  });

  it("404s a path-traversal attempt rather than 500ing", async () => {
    const res = await serveStoredFile(driver, "../../etc/passwd");
    expect(res.status).toBe(404);
  });

  it("sets Last-Modified, ETag and Accept-Ranges", async () => {
    await driver.put("a.txt", "0123456789");
    const res = await serveStoredFile(driver, "a.txt");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toMatch(/^W\/"/);
    expect(res.headers.get("last-modified")).not.toBeNull();
    expect(res.headers.get("content-length")).toBe("10");
  });

  it("honours a Range request with a 206 and Content-Range", async () => {
    await driver.put("a.txt", "0123456789");
    const res = await serveStoredFile(driver, "a.txt", {
      request: { headers: new Headers({ Range: "bytes=0-4" }) },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/10");
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe("01234");
  });

  it("honours a suffix Range (last N bytes)", async () => {
    await driver.put("a.txt", "0123456789");
    const res = await serveStoredFile(driver, "a.txt", {
      request: { headers: new Headers({ Range: "bytes=-3" }) },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await res.text()).toBe("789");
  });

  it("honours an open-ended Range (start to EOF)", async () => {
    await driver.put("a.txt", "0123456789");
    const res = await serveStoredFile(driver, "a.txt", {
      request: { headers: new Headers({ Range: "bytes=5-" }) },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 5-9/10");
    expect(await res.text()).toBe("56789");
  });

  it("416s an unsatisfiable Range", async () => {
    await driver.put("a.txt", "0123456789");
    const res = await serveStoredFile(driver, "a.txt", {
      request: { headers: new Headers({ Range: "bytes=100-200" }) },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  it("304s when If-None-Match matches the ETag", async () => {
    await driver.put("a.txt", "0123456789");
    const first = await serveStoredFile(driver, "a.txt");
    const etag = first.headers.get("etag")!;

    const res = await serveStoredFile(driver, "a.txt", {
      request: { headers: new Headers({ "If-None-Match": etag }) },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("304s when If-Modified-Since is at/after the mtime", async () => {
    await driver.put("a.txt", "0123456789");
    const first = await serveStoredFile(driver, "a.txt");
    const lastModified = first.headers.get("last-modified")!;

    const res = await serveStoredFile(driver, "a.txt", {
      request: { headers: new Headers({ "If-Modified-Since": lastModified }) },
    });
    expect(res.status).toBe(304);
  });

  it("still returns 200 when If-Modified-Since is before the mtime", async () => {
    await driver.put("a.txt", "0123456789");
    const res = await serveStoredFile(driver, "a.txt", {
      request: { headers: new Headers({ "If-Modified-Since": new Date(0).toUTCString() }) },
    });
    expect(res.status).toBe(200);
  });

  it("destroys the read stream when the request signal aborts", async () => {
    await driver.put("a.txt", "0123456789");
    const controller = new AbortController();
    const res = await serveStoredFile(driver, "a.txt", {
      request: { headers: new Headers(), signal: controller.signal },
    });
    controller.abort();
    // Reading the aborted body rejects/cancels rather than yielding bytes.
    await expect(res.text()).rejects.toThrow();
  });

  it("serves an empty file as a 200 with zero length", async () => {
    await driver.put("empty.txt", "");
    const res = await serveStoredFile(driver, "empty.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect(await res.text()).toBe("");
  });
});

describe("StorageServiceProvider + servePublicDisk", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-storage-provider-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function bootApp(): Promise<Application> {
    const app = new Application();
    app.config.set("storage", {
      default: "public",
      disks: {
        local: { root: path.join(tmpDir, "private") },
        public: { root: path.join(tmpDir, "public"), url: "/storage" },
        remote: { driver: "s3", bucket: "unused" },
      },
    });
    app.register(StorageServiceProvider);
    await app.bootstrap();

    return app;
  }

  it("registers every configured local disk and skips non-local ones", async () => {
    const app = await bootApp();
    const storage = app.make<StorageManager>(STORAGE_TOKEN);

    expect(storage.disk("public")).toBeInstanceOf(LocalStorageDriver);
    expect(storage.disk("local")).toBeInstanceOf(LocalStorageDriver);
    expect(storage.url("avatars/a.png")).toBe("/storage/avatars/a.png");
    // The private "local" disk has no url, url() throws, path() gives its location.
    expect(() => storage.url("secret.txt", "local")).toThrow(/does not support retrieving URLs/);
    expect(path.isAbsolute(storage.path("secret.txt", "local"))).toBe(true);
    expect(() => storage.disk("remote")).toThrow(/not registered/);
  });

  it("servePublicDisk streams a file under the configured prefix", async () => {
    const app = await bootApp();
    const storage = app.make<StorageManager>(STORAGE_TOKEN);
    await storage.disk("public").put("avatars/a.png", Buffer.from("png-bytes"));

    const handler = servePublicDisk("public", {
      cacheControl: "public, max-age=31536000, immutable",
    });
    const res = await handler({ path: () => "/storage/avatars/a.png" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("png-bytes");
  });

  it("servePublicDisk 404s outside the prefix and for missing files", async () => {
    await bootApp();
    const handler = servePublicDisk("public");
    expect((await handler({ path: () => "/media/avatars/a.png" })).status).toBe(404);
    expect((await handler({ path: () => "/storage/missing.png" })).status).toBe(404);
  });
});
