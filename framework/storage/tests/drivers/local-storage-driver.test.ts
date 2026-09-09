import { mkdtemp, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorageDriver } from "../../src/drivers/local-storage-driver.js";
import { FileNotFoundException } from "../../src/exceptions.js";

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

describe("LocalStorageDriver", () => {
  let tmpDir: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-storage-test-"));
    driver = new LocalStorageDriver(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("put()/get() round-trips a string", async () => {
    await driver.put("hello.txt", "world");
    const buf = await driver.get("hello.txt");
    expect(buf.toString("utf-8")).toBe("world");
  });

  it("put()/get() round-trips a Buffer", async () => {
    const contents = Buffer.from([1, 2, 3, 4]);
    await driver.put("bytes.bin", contents);
    const buf = await driver.get("bytes.bin");
    expect(buf).toEqual(contents);
  });

  it("exists() is false before put() and true after", async () => {
    expect(await driver.exists("a.txt")).toBe(false);
    await driver.put("a.txt", "x");
    expect(await driver.exists("a.txt")).toBe(true);
  });

  it("delete() removes the file", async () => {
    await driver.put("a.txt", "x");
    await driver.delete("a.txt");
    expect(await driver.exists("a.txt")).toBe(false);
  });

  it("delete() on a missing file does not throw (force: true)", async () => {
    await expect(driver.delete("missing.txt")).resolves.toBeUndefined();
  });

  it("put() auto-creates nested parent directories", async () => {
    await driver.put("a/b/c/nested.txt", "deep");
    expect(await driver.exists("a/b/c/nested.txt")).toBe(true);
    const buf = await driver.get("a/b/c/nested.txt");
    expect(buf.toString("utf-8")).toBe("deep");
  });

  it("url() throws for a private disk (no prefix configured), matching Laravel", async () => {
    await driver.put("a.txt", "x");
    expect(() => driver.url("a.txt")).toThrow(/does not support retrieving URLs/);
  });

  it("path() returns an absolute filesystem path under the root", async () => {
    await driver.put("a.txt", "x");
    const p = driver.path("a.txt");
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(path.resolve(tmpDir))).toBe(true);
  });

  it("path() still rejects a path-traversal attempt", () => {
    expect(() => driver.path("../../etc/passwd")).toThrow(/escapes the storage root/);
  });

  it("url() returns the configured HTTP prefix plus the relative path", async () => {
    const publicDisk = new LocalStorageDriver(tmpDir, "/storage");
    await publicDisk.put("avatars/a.txt", "x");
    expect(publicDisk.url("avatars/a.txt")).toBe("/storage/avatars/a.txt");
  });

  it("url() joins an absolute CDN prefix", async () => {
    const publicDisk = new LocalStorageDriver(tmpDir, "https://cdn.example.com/media");
    expect(publicDisk.url("posts/1.png")).toBe("https://cdn.example.com/media/posts/1.png");
  });

  it("url() percent-encodes each path segment", async () => {
    const publicDisk = new LocalStorageDriver(tmpDir, "/storage");
    expect(publicDisk.url("a b.png")).toBe("/storage/a%20b.png");
    expect(publicDisk.url("dir with space/a?b=1#c.png")).toBe(
      "/storage/dir%20with%20space/a%3Fb%3D1%23c.png",
    );
  });

  it("url() still rejects a path-traversal attempt", () => {
    const publicDisk = new LocalStorageDriver(tmpDir, "/storage");
    expect(() => publicDisk.url("../../etc/passwd")).toThrow(/escapes the storage root/);
  });

  it("rejects a path-traversal attempt that would escape the root", async () => {
    await expect(driver.get("../../etc/passwd")).rejects.toThrow(/escapes the storage root/);
  });

  it("rejects a path-traversal attempt on put() too", async () => {
    await expect(driver.put("../outside.txt", "x")).rejects.toThrow(/escapes the storage root/);
  });

  describe("symlink escape (realpath guard)", () => {
    let outsideDir: string;

    beforeEach(async () => {
      outsideDir = await mkdtemp(path.join(tmpdir(), "mahi-storage-outside-"));
    });

    afterEach(async () => {
      await rm(outsideDir, { recursive: true, force: true });
    });

    it("get() refuses to follow a symlink that resolves outside the root", async () => {
      const secret = path.join(outsideDir, "secret.txt");
      await writeFile(secret, "top secret");
      await symlink(secret, path.join(tmpDir, "link.txt"));

      await expect(driver.get("link.txt")).rejects.toThrow(/escapes the storage root/);
    });

    it("exists() reports false for a symlink escaping the root (does not leak it)", async () => {
      const secret = path.join(outsideDir, "secret.txt");
      await writeFile(secret, "top secret");
      await symlink(secret, path.join(tmpDir, "link.txt"));

      expect(await driver.exists("link.txt")).toBe(false);
    });

    it("get() refuses a file reached through a symlinked directory", async () => {
      await writeFile(path.join(outsideDir, "secret.txt"), "top secret");
      await symlink(outsideDir, path.join(tmpDir, "outlink"));

      await expect(driver.get("outlink/secret.txt")).rejects.toThrow(/escapes the storage root/);
    });

    it("put() refuses to write through a symlink pointing outside the root", async () => {
      await symlink(path.join(outsideDir, "target.txt"), path.join(tmpDir, "link.txt"));

      await expect(driver.put("link.txt", "pwned")).rejects.toThrow(/escapes the storage root/);
      // The outside target must not have been written through the symlink.
      const outsideDriver = new LocalStorageDriver(outsideDir);
      expect(await outsideDriver.exists("target.txt")).toBe(false);
    });

    it("still follows a symlink that stays inside the root", async () => {
      await driver.put("real.txt", "inside");
      await symlink(path.join(tmpDir, "real.txt"), path.join(tmpDir, "alias.txt"));

      const buf = await driver.get("alias.txt");
      expect(buf.toString("utf-8")).toBe("inside");
    });

    it("files() refuses to descend a symlinked directory escaping the root", async () => {
      await writeFile(path.join(outsideDir, "secret.txt"), "top secret");
      await symlink(outsideDir, path.join(tmpDir, "outlink"));

      await expect(driver.files("outlink")).rejects.toThrow(/escapes the storage root/);
    });

    it("readStream() refuses a symlink escaping the root", async () => {
      const secret = path.join(outsideDir, "secret.txt");
      await writeFile(secret, "top secret");
      await symlink(secret, path.join(tmpDir, "link.txt"));

      await expect(driver.readStream("link.txt")).rejects.toThrow(/escapes the storage root/);
    });
  });

  describe("listing", () => {
    beforeEach(async () => {
      await driver.put("root.txt", "r");
      await driver.put("a.txt", "a");
      await driver.put("sub/one.txt", "1");
      await driver.put("sub/two.txt", "2");
      await driver.put("sub/deep/three.txt", "3");
      await driver.makeDirectory("empty");
    });

    it("files() lists immediate files, sorted, relative, POSIX-separated", async () => {
      expect(await driver.files()).toEqual(["a.txt", "root.txt"]);
      expect(await driver.files("sub")).toEqual(["sub/one.txt", "sub/two.txt"]);
    });

    it("directories() lists immediate subdirectories", async () => {
      expect(await driver.directories()).toEqual(["empty", "sub"]);
      expect(await driver.directories("sub")).toEqual(["sub/deep"]);
    });

    it("allFiles() recurses", async () => {
      expect(await driver.allFiles()).toEqual([
        "a.txt",
        "root.txt",
        "sub/deep/three.txt",
        "sub/one.txt",
        "sub/two.txt",
      ]);
      expect(await driver.allFiles("sub")).toEqual([
        "sub/deep/three.txt",
        "sub/one.txt",
        "sub/two.txt",
      ]);
    });

    it("allDirectories() recurses", async () => {
      expect(await driver.allDirectories()).toEqual(["empty", "sub", "sub/deep"]);
    });

    it("list() returns one level of files and directories", async () => {
      expect(await driver.list()).toEqual({
        files: ["a.txt", "root.txt"],
        directories: ["empty", "sub"],
      });
    });

    it("a non-existent directory lists as empty (Laravel), not an error", async () => {
      expect(await driver.files("nope")).toEqual([]);
      expect(await driver.directories("nope")).toEqual([]);
      expect(await driver.list("nope")).toEqual({ files: [], directories: [] });
    });

    it("rejects a traversal directory argument", async () => {
      await expect(driver.files("../..")).rejects.toThrow(/escapes the storage root/);
    });
  });

  describe("streaming", () => {
    it("readStream() streams the file's bytes", async () => {
      await driver.put("a.txt", "hello world");
      const stream = await driver.readStream("a.txt");
      expect((await drain(stream)).toString("utf-8")).toBe("hello world");
    });

    it("readStream() honours start/end (inclusive) ranges", async () => {
      await driver.put("a.txt", "0123456789");
      const stream = await driver.readStream("a.txt", { start: 2, end: 5 });
      expect((await drain(stream)).toString("utf-8")).toBe("2345");
    });

    it("readStream() rejects a missing file with FileNotFoundException before any chunk", async () => {
      await expect(driver.readStream("missing.txt")).rejects.toBeInstanceOf(FileNotFoundException);
    });

    it("readStream() streams a large file without buffering it whole", async () => {
      // 8 MiB — bigger than a single fs chunk, proving it arrives in pieces.
      const big = Buffer.alloc(8 * 1024 * 1024, 7);
      await driver.put("big.bin", big);
      const stream = await driver.readStream("big.bin");
      let chunks = 0;
      let total = 0;

      for await (const chunk of stream) {
        chunks += 1;
        total += chunk.length;
      }

      expect(total).toBe(big.length);
      expect(chunks).toBeGreaterThan(1);
    });

    it("writeStream() + finish writes the bytes and creates parent dirs", async () => {
      const stream = await driver.writeStream("out/nested.txt");
      await new Promise<void>((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
        stream.end("streamed bytes");
      });
      expect((await driver.get("out/nested.txt")).toString("utf-8")).toBe("streamed bytes");
    });

    it("writeStream() leaves no partial file at the final path on error", async () => {
      const stream = await driver.writeStream("partial.txt");
      stream.write("some data");
      // Simulate a failed upload: destroy before finishing.
      await new Promise<void>((resolve) => {
        stream.on("close", () => resolve());
        stream.destroy(new Error("boom"));
      });
      expect(await driver.exists("partial.txt")).toBe(false);
      // No stray temp file either.
      expect(await driver.files()).toEqual([]);
    });

    it("writeStream({ flags: 'a' }) appends", async () => {
      await driver.put("log.txt", "first\n");
      const stream = await driver.writeStream("log.txt", { flags: "a" });
      await new Promise<void>((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
        stream.end("second\n");
      });
      expect((await driver.get("log.txt")).toString("utf-8")).toBe("first\nsecond\n");
    });

    it("putStream() drains a Node Readable", async () => {
      await driver.putStream("from-node.txt", Readable.from(["ab", "cd", "ef"]));
      expect((await driver.get("from-node.txt")).toString("utf-8")).toBe("abcdef");
    });

    it("putStream() drains a web ReadableStream", async () => {
      const body = new Response("web-body").body!;
      await driver.putStream("from-web.txt", body);
      expect((await driver.get("from-web.txt")).toString("utf-8")).toBe("web-body");
    });

    it("putStream() drains an async iterable", async () => {
      async function* gen(): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode("x");
        yield new TextEncoder().encode("y");
        yield new TextEncoder().encode("z");
      }
      await driver.putStream("from-iter.txt", gen());
      expect((await driver.get("from-iter.txt")).toString("utf-8")).toBe("xyz");
    });
  });

  describe("metadata & manipulation", () => {
    it("size() returns the byte length", async () => {
      await driver.put("a.txt", "12345");
      expect(await driver.size("a.txt")).toBe(5);
    });

    it("size() throws FileNotFoundException for a missing file", async () => {
      await expect(driver.size("nope.txt")).rejects.toBeInstanceOf(FileNotFoundException);
    });

    it("lastModified() returns a Date close to now", async () => {
      await driver.put("a.txt", "x");
      const mtime = await driver.lastModified("a.txt");
      expect(mtime).toBeInstanceOf(Date);
      expect(Date.now() - mtime.getTime()).toBeLessThan(10_000);
    });

    it("mimeType() guesses from the extension, undefined when unknown", async () => {
      expect(await driver.mimeType("a.png")).toBe("image/png");
      expect(await driver.mimeType("a.unknownext")).toBeUndefined();
    });

    it("copy() duplicates a file, creating parent dirs", async () => {
      await driver.put("a.txt", "orig");
      await driver.copy("a.txt", "backup/a.txt");
      expect((await driver.get("backup/a.txt")).toString("utf-8")).toBe("orig");
      expect(await driver.exists("a.txt")).toBe(true);
    });

    it("copy() throws FileNotFoundException when the source is missing", async () => {
      await expect(driver.copy("nope.txt", "x.txt")).rejects.toBeInstanceOf(FileNotFoundException);
    });

    it("move() renames a file", async () => {
      await driver.put("a.txt", "orig");
      await driver.move("a.txt", "moved/a.txt");
      expect(await driver.exists("a.txt")).toBe(false);
      expect((await driver.get("moved/a.txt")).toString("utf-8")).toBe("orig");
    });

    it("makeDirectory() then deleteDirectory() round-trips", async () => {
      await driver.makeDirectory("d/e/f");
      expect((await stat(driver.path("d/e/f"))).isDirectory()).toBe(true);
      await driver.put("d/e/f/x.txt", "x");
      await driver.deleteDirectory("d");
      expect(await driver.exists("d/e/f/x.txt")).toBe(false);
    });

    it("deleteDirectory() on a missing directory is a no-op", async () => {
      await expect(driver.deleteDirectory("nope")).resolves.toBeUndefined();
    });
  });
});
