import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCacheStore } from "../../src/stores/file-cache-store.js";

const run = promisify(execFile);

/**
 * The TTL the expiry tests write, and a sleep comfortably past it.
 *
 * These were 0.05s / 100ms, which left only a 50ms budget for the `put()`
 * and `get()` that run *before* the sleep. Idle that is about 1ms, so it
 * looked generous — but under a loaded full-monorepo run those two file
 * operations have taken 290ms+, expiring the value before the test could
 * read it back. The failure then pointed at the wrong assertion: the
 * *first* `expect` failed ("expected undefined to be 'value'"), which reads
 * like a broken write rather than a timing problem.
 *
 * A second of TTL is still fast, and no longer races disk I/O.
 */
const TTL_SECONDS = 1;

function sleepPastTtl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TTL_SECONDS * 1000 + 250));
}

describe("FileCacheStore", () => {
  let tmpDir: string;
  let directory: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-cache-test-"));
    directory = path.join(tmpDir, "cache");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("get() returns undefined for a missing key (directory doesn't exist yet)", async () => {
    const store = new FileCacheStore(directory);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("put()/get() round-trips a value", async () => {
    const store = new FileCacheStore(directory);
    await store.put("key", { a: 1 });
    expect(await store.get("key")).toEqual({ a: 1 });
  });

  it("forget() removes a key", async () => {
    const store = new FileCacheStore(directory);
    await store.put("key", "value");
    await store.forget("key");
    expect(await store.get("key")).toBeUndefined();
  });

  it("forget() on a missing key is a no-op", async () => {
    const store = new FileCacheStore(directory);
    await expect(store.forget("never-set")).resolves.toBeUndefined();
  });

  it("has() reflects presence", async () => {
    const store = new FileCacheStore(directory);
    expect(await store.has("key")).toBe(false);
    await store.put("key", "value");
    expect(await store.has("key")).toBe(true);
  });

  it("flush() clears every key", async () => {
    const store = new FileCacheStore(directory);
    await store.put("a", 1);
    await store.put("b", 2);
    await store.flush();
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBeUndefined();
  });

  it("flush() on a never-written store is a no-op", async () => {
    const store = new FileCacheStore(directory);
    await expect(store.flush()).resolves.toBeUndefined();
    await store.put("after", "still works");
    expect(await store.get("after")).toBe("still works");
  });

  it("a value with a short ttlSeconds expires", async () => {
    const store = new FileCacheStore(directory);
    await store.put("key", "value", TTL_SECONDS);
    expect(await store.get("key")).toBe("value");

    await sleepPastTtl();
    expect(await store.get("key")).toBeUndefined();
  });

  it("persists across separate FileCacheStore instances pointed at the same directory", async () => {
    const first = new FileCacheStore(directory);
    await first.put("key", "durable value");

    const second = new FileCacheStore(directory);
    expect(await second.get("key")).toBe("durable value");
  });

  it("increment() creates and increments a counter", async () => {
    const store = new FileCacheStore(directory);
    expect(await store.increment("hits")).toBe(1);
    expect(await store.increment("hits")).toBe(2);
    expect(await store.increment("hits", 3)).toBe(5);
  });

  it("increment() preserves the expiry seeded by add()", async () => {
    const store = new FileCacheStore(directory);
    await store.add("window", 0, TTL_SECONDS);
    await store.increment("window");
    expect(await store.get("window")).toBe(1);

    // Incrementing must not have pushed the expiry out — the whole basis
    // of RateLimiter's fixed window.
    await sleepPastTtl();
    expect(await store.get("window")).toBeUndefined();
  });

  it("increment() throws on a non-numeric value rather than concatenating", async () => {
    const store = new FileCacheStore(directory);
    await store.put("name", "5");

    // `"5" + 1` is `"51"` in JavaScript. Redis rejects the same
    // operation, so this store does too rather than quietly producing a
    // different answer under a different CACHE_STORE.
    await expect(store.increment("name")).rejects.toThrow(/not a number/);
  });

  it("add() only sets the key if it doesn't already exist", async () => {
    const store = new FileCacheStore(directory);
    expect(await store.add("key", "first")).toBe(true);
    expect(await store.add("key", "second")).toBe(false);
    expect(await store.get("key")).toBe("first");
  });

  it("add() takes over a key whose ttl has elapsed", async () => {
    const store = new FileCacheStore(directory);
    expect(await store.add("key", "first", TTL_SECONDS)).toBe(true);
    await sleepPastTtl();

    expect(await store.add("key", "second")).toBe(true);
    expect(await store.get("key")).toBe("second");
  });

  it("serializes concurrent increments without losing any", async () => {
    const store = new FileCacheStore(directory);

    await Promise.all(Array.from({ length: 20 }, () => store.increment("concurrent")));

    expect(await store.get("concurrent")).toBe(20);
  });

  it("rememberViaLock() reliably resolves under a concurrent stampede", async () => {
    const store = new FileCacheStore(directory);

    const callback = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));

      return "computed";
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.rememberViaLock("stampede-key", callback)),
    );

    expect(results.every((r) => r === "computed")).toBe(true);
  });

  it("creates the cache directory if it doesn't exist", async () => {
    const nested = path.join(tmpDir, "deeply", "nested", "cache");
    const store = new FileCacheStore(nested);
    await store.put("key", "value");
    expect(await store.get("key")).toBe("value");
  });

  describe("layout", () => {
    it("writes one file per key, fanned out over two directory levels", async () => {
      const store = new FileCacheStore(directory);
      await store.put("user:1", "a");
      await store.put("user:2", "b");

      const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
        (entry) => entry.isFile(),
      );
      expect(files).toHaveLength(2);

      // sha1 hex, split 2/2/rest.
      for (const file of files) {
        expect(path.relative(directory, path.join(file.parentPath, file.name))).toMatch(
          /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{40}$/,
        );
      }
    });

    it("handles keys that are not valid filenames", async () => {
      const store = new FileCacheStore(directory);
      const key = "https://example.com/a/b?c=d&e=../../etc/passwd";

      await store.put(key, "safe");

      expect(await store.get(key)).toBe("safe");
      // The traversal segments in the key must not have escaped the
      // cache directory — hashing is what guarantees that.
      const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
        (e) => e.isFile(),
      );
      expect(files).toHaveLength(1);
    });
  });

  describe("crash safety", () => {
    /**
     * The old single-file store wrote with a plain `writeFile()`, so a
     * process killed mid-write left truncated JSON — and because that one
     * file held EVERY key, the next read of any key threw. One file per
     * key plus temp-file+rename means a damaged entry is at worst one
     * cache miss.
     */
    it("a truncated entry file reads as a miss, not an exception", async () => {
      const store = new FileCacheStore(directory);
      await store.put("good", "kept");
      await store.put("damaged", { big: "value" });

      const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
        (e) => e.isFile(),
      );
      const damagedFile = await findFileFor(files, "damaged");
      await writeFile(damagedFile, '{"key":"damaged","val');

      expect(await store.get("damaged")).toBeUndefined();
      expect(await store.get("good")).toBe("kept");
    });

    it("leaves no temp files behind after a write", async () => {
      const store = new FileCacheStore(directory);
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.put(`key:${i}`, i)));

      const files = await readdir(directory, { recursive: true, withFileTypes: true });
      expect(files.filter((entry) => entry.name.endsWith(".tmp"))).toHaveLength(0);
      expect(files.filter((entry) => entry.name.endsWith(".lock"))).toHaveLength(0);
    });

    it("reclaims an abandoned lock file left by a process that died holding it", async () => {
      const store = new FileCacheStore(directory);
      await store.put("counter", 1);

      // Plant a lock file and backdate it past STALE_LOCK_MS, which is
      // what a `kill -9` mid-increment leaves on disk.
      const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
        (e) => e.isFile(),
      );
      const entryFile = await findFileFor(files, "counter");
      const lockPath = `${entryFile}.lock`;
      await writeFile(lockPath, "");
      const old = new Date(Date.now() - FileCacheStore.STALE_LOCK_MS - 1_000);
      await (await import("node:fs/promises")).utimes(lockPath, old, old);

      expect(await store.increment("counter")).toBe(2);
    });
  });

  describe("reads do not write", () => {
    /**
     * An unconditional extra write per read is not harmless: on a large
     * cache it is a full rewrite per cache hit, and on a shared cache it
     * is a chance to clobber another process's write.
     */
    it("get() on a live key leaves the file untouched", async () => {
      const store = new FileCacheStore(directory);
      await store.put("key", "value");

      const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
        (e) => e.isFile(),
      );
      const file = await findFileFor(files, "key");
      const before = await stat(file);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await store.get("key");
      await store.has("key");

      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    });
  });

  describe("prune()", () => {
    it("removes expired entries without touching live ones", async () => {
      const store = new FileCacheStore(directory);
      await store.put("live", "kept");
      await store.put("forever", "kept");
      await store.put("dead-a", "x", TTL_SECONDS);
      await store.put("dead-b", "y", TTL_SECONDS);
      await sleepPastTtl();

      expect(await store.prune()).toBe(2);

      expect(await store.get("live")).toBe("kept");
      expect(await store.get("forever")).toBe("kept");
      const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
        (e) => e.isFile(),
      );
      expect(files).toHaveLength(2);
    });

    it("is a no-op on a store that was never written to", async () => {
      expect(await new FileCacheStore(directory).prune()).toBe(0);
    });

    /**
     * A process killed between `writeFile()` and `rename()` leaves a
     * `.tmp`; one killed holding an entry lock leaves a `.lock`. The
     * `.lock` is reclaimed as stale by the next writer of *that key* —
     * but on a key nothing writes again, never. `prune()` is where they
     * go.
     */
    it("removes abandoned .tmp and .lock scratch files, but not fresh ones", async () => {
      const store = new FileCacheStore(directory);
      await store.put("key", "value");

      const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
        (e) => e.isFile(),
      );
      const entryFile = await findFileFor(files, "key");
      const { utimes } = await import("node:fs/promises");

      const abandoned = new Date(Date.now() - FileCacheStore.STALE_LOCK_MS - 1_000);

      for (const suffix of [".lock", ".tmp"]) {
        await writeFile(`${entryFile}${suffix}`, "");
        await utimes(`${entryFile}${suffix}`, abandoned, abandoned);
      }

      // In-flight, belonging to an operation still running — possibly in
      // another process. Must survive.
      await writeFile(`${entryFile}.inflight.tmp`, "");

      expect(await store.prune()).toBe(2);

      const after = await readdir(directory, { recursive: true, withFileTypes: true });
      expect(after.filter((e) => e.name.endsWith(".tmp"))).toHaveLength(1);
      expect(after.filter((e) => e.name.endsWith(".lock"))).toHaveLength(0);
      // The live entry itself is untouched.
      expect(await store.get("key")).toBe("value");
    });
  });

  describe("releaseLock()", () => {
    it("deletes the entry only when the owner matches", async () => {
      const store = new FileCacheStore(directory);
      await store.add("job_lock", "owner-a", 30);

      expect(await store.releaseLock("job_lock", "owner-b")).toBe(false);
      expect(await store.get("job_lock")).toBe("owner-a");

      expect(await store.releaseLock("job_lock", "owner-a")).toBe(true);
      expect(await store.get("job_lock")).toBeUndefined();
    });

    it("is false for a lock that never existed", async () => {
      expect(await new FileCacheStore(directory).releaseLock("nope_lock", "owner")).toBe(false);
    });
  });

  describe("misconfiguration", () => {
    it("explains itself when pointed at a file rather than a directory", async () => {
      // The pre-`one-file-per-key` config was `path: "storage/cache.json"`.
      // An app that upgrades without changing it must be told what to do,
      // not handed a bare ENOTDIR.
      const asFile = path.join(tmpDir, "cache.json");
      await writeFile(asFile, "{}");

      const store = new FileCacheStore(asFile);
      await expect(store.put("key", "value")).rejects.toThrow(/is a file, not a directory/);
    });
  });

  /**
   * The claim that makes this store usable at all for its actual audience
   * — a web server plus `queue:work` plus a `schedule:run` cron, sharing
   * `storage/cache`. Serializing only through an *in-process* promise
   * chain is not enough: two processes would do unsynchronised
   * read-modify-writes and simply lose each other's updates.
   *
   * Real child processes, because that is the only way to test this: two
   * stores in one process share the event loop, a property real
   * deployments don't have.
   */
  describe("multi-process", () => {
    const child = (source: string, dir: string) =>
      run(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...process.env, CACHE_DIR: dir },
      });

    const importStore = `
      const { FileCacheStore } = await import(${JSON.stringify(
        new URL("../../dist/stores/file-cache-store.js", import.meta.url).href,
      )});
      const store = new FileCacheStore(process.env.CACHE_DIR);
    `;

    it("two processes each doing 100 increments end at 200", async () => {
      const source = `${importStore}
        for (let i = 0; i < 100; i++) await store.increment("shared");
      `;

      await Promise.all([child(source, directory), child(source, directory)]);

      expect(await new FileCacheStore(directory).get("shared")).toBe(200);
    });

    it("only one of two processes wins add() on the same key", async () => {
      const source = `${importStore}
        process.stdout.write(String(await store.add("lock", process.pid, 30)));
      `;

      const [a, b] = await Promise.all([child(source, directory), child(source, directory)]);

      expect([a.stdout, b.stdout].filter((out) => out === "true")).toHaveLength(1);
    });

    it("a write in one process is visible in another", async () => {
      await child(`${importStore} await store.put("from-child", { ok: true });`, directory);

      expect(await new FileCacheStore(directory).get("from-child")).toEqual({ ok: true });
    });
  });
});

/** The on-disk file holding `key`, found by reading each entry back (they record their own key). */
async function findFileFor(
  files: Array<{ parentPath: string; name: string }>,
  key: string,
): Promise<string> {
  for (const entry of files) {
    const file = path.join(entry.parentPath, entry.name);
    const parsed = JSON.parse(await readFile(file, "utf-8")) as { key: string };

    if (parsed.key === key) {
      return file;
    }
  }

  throw new Error(`No cache file found for key "${key}".`);
}
