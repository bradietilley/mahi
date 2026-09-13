import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleLock } from "../../src/locking/schedule-lock.js";

const MINUTE_MS = 60_000;

describe("ScheduleLock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "schedule-lock-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("isLocked() is false when no lock file exists", async () => {
    const lock = new ScheduleLock(dir);
    expect(await lock.isLocked("my-task")).toBe(false);
  });

  it("acquire() returns true and reports the key as locked", async () => {
    const lock = new ScheduleLock(dir);
    expect(await lock.acquire("my-task", MINUTE_MS)).toBe(true);
    expect(await lock.isLocked("my-task")).toBe(true);
  });

  it("acquire() returns false while the lock is held", async () => {
    const lock = new ScheduleLock(dir);
    await lock.acquire("my-task", MINUTE_MS);
    expect(await lock.acquire("my-task", MINUTE_MS)).toBe(false);
  });

  it("release() frees the key for a later acquire()", async () => {
    const lock = new ScheduleLock(dir);
    await lock.acquire("my-task", MINUTE_MS);
    await lock.release("my-task");

    expect(await lock.isLocked("my-task")).toBe(false);
    expect(await lock.acquire("my-task", MINUTE_MS)).toBe(true);
  });

  it("release() on a key that was never locked is a no-op", async () => {
    const lock = new ScheduleLock(dir);
    await expect(lock.release("never-locked")).resolves.toBeUndefined();
  });

  it("locks are per-key, so one task's lock does not block another's", async () => {
    const lock = new ScheduleLock(dir);
    await lock.acquire("task-a", MINUTE_MS);
    expect(await lock.acquire("task-b", MINUTE_MS)).toBe(true);
  });

  it("an expired lock is reclaimed rather than blocking forever", async () => {
    const lock = new ScheduleLock(dir);
    await lock.acquire("my-task", 10); // expires in 10ms
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await lock.isLocked("my-task")).toBe(false);
    expect(await lock.acquire("my-task", MINUTE_MS)).toBe(true);
  });

  it("honours the per-call expiry over the constructor default", async () => {
    // Default says an hour; this call says 10ms, and the call wins.
    const lock = new ScheduleLock(dir, 60 * MINUTE_MS);
    await lock.acquire("my-task", 10);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await lock.acquire("my-task", MINUTE_MS)).toBe(true);
  });

  it("falls back to the constructor default when no expiry is given", async () => {
    const lock = new ScheduleLock(dir, 10);
    await lock.acquire("my-task");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await lock.isLocked("my-task")).toBe(false);
  });

  it("treats a corrupt lock file as reclaimable rather than jamming on it", async () => {
    const lock = new ScheduleLock(dir);
    await lock.acquire("my-task", MINUTE_MS);

    const [file] = await readdir(dir);
    await writeFile(path.join(dir, file!), "not json at all");

    expect(await lock.isLocked("my-task")).toBe(false);
    expect(await lock.acquire("my-task", MINUTE_MS)).toBe(true);
  });

  describe("atomicity", () => {
    // The reason `acquire()` is a single `open(..., "wx")` rather than an
    // `isLocked()` check followed by a write: two schedule:run processes
    // started in the same minute (which happens the moment a run overruns)
    // both passed the check and both ran the task.
    it("exactly one of many concurrent acquires wins", async () => {
      const lockers = Array.from({ length: 20 }, () => new ScheduleLock(dir));
      const results = await Promise.all(
        lockers.map((lock) => lock.acquire("contended", MINUTE_MS)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("exactly one wins when they all race to reclaim the SAME expired lock", async () => {
      const seed = new ScheduleLock(dir);
      await seed.acquire("contended", 5);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const lockers = Array.from({ length: 20 }, () => new ScheduleLock(dir));
      const results = await Promise.all(
        lockers.map((lock) => lock.acquire("contended", MINUTE_MS)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("a reclaimer does not clobber a lock another reclaimer just took", async () => {
      // The specific hazard: both see the SAME expired record, A removes
      // and recreates, then B, acting on its stale observation,
      // unconditionally removes A's *fresh* lock and creates its own.
      // Both would report success, and the task would run twice.
      const seed = new ScheduleLock(dir);
      await seed.acquire("contended", 5);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const a = new ScheduleLock(dir);
      const b = new ScheduleLock(dir);
      const [gotA, gotB] = await Promise.all([
        a.acquire("contended", MINUTE_MS),
        b.acquire("contended", MINUTE_MS),
      ]);

      expect([gotA, gotB].filter(Boolean)).toHaveLength(1);
      // And the winner really holds it afterwards.
      expect(await new ScheduleLock(dir).acquire("contended", MINUTE_MS)).toBe(false);
    });

    it("recovers when a previous reclaimer died mid-reclaim", async () => {
      const lock = new ScheduleLock(dir);
      await lock.acquire("k", 5);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // A marker left behind by a process that crashed inside the critical
      // section, dated well beyond the staleness threshold.
      const [lockFile] = (await readdir(dir)).filter((name) => name.endsWith(".lock"));
      const marker = path.join(dir, `${lockFile}.reclaim`);
      await writeFile(marker, String(Date.now() - 60_000));

      expect(await new ScheduleLock(dir).acquire("k", MINUTE_MS)).toBe(true);
      // The marker is cleaned up rather than accumulating.
      expect(await readdir(dir)).not.toContain(path.basename(marker));
    });

    it("backs off rather than reclaiming while another reclaim is in progress", async () => {
      const lock = new ScheduleLock(dir);
      await lock.acquire("k", 5);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // A *fresh* marker: someone is mid-reclaim right now.
      const [lockFile] = (await readdir(dir)).filter((name) => name.endsWith(".lock"));
      await writeFile(path.join(dir, `${lockFile}.reclaim`), String(Date.now()));

      expect(await new ScheduleLock(dir).acquire("k", MINUTE_MS)).toBe(false);
    });

    it("the next acquire after the winner releases succeeds", async () => {
      const a = new ScheduleLock(dir);
      const b = new ScheduleLock(dir);

      expect(await a.acquire("k", MINUTE_MS)).toBe(true);
      expect(await b.acquire("k", MINUTE_MS)).toBe(false);
      await a.release("k");
      expect(await b.acquire("k", MINUTE_MS)).toBe(true);
    });
  });

  describe("key handling", () => {
    it("keys with unsafe characters are usable", async () => {
      const lock = new ScheduleLock(dir);
      const key = "job: send report / daily";

      expect(await lock.acquire(key, MINUTE_MS)).toBe(true);
      expect(await lock.isLocked(key)).toBe(true);
      await lock.release(key);
      expect(await lock.isLocked(key)).toBe(false);
    });

    it("keys that a sanitising scheme would collapse together stay distinct", async () => {
      // Under the old `[^a-zA-Z0-9_-] -> "_"` sanitiser both of these
      // became `0_0______`, so two unrelated tasks shared one lock file
      // and silently skipped each other.
      const lock = new ScheduleLock(dir);
      expect(await lock.acquire("0 0 * * *", MINUTE_MS)).toBe(true);
      expect(await lock.acquire("0-0 * * *", MINUTE_MS)).toBe(true);

      expect(await readdir(dir)).toHaveLength(2);
    });

    it("records the original key in the lock file, so a stray lock is traceable", async () => {
      const lock = new ScheduleLock(dir);
      await lock.acquire("schedule-overlap:nightly-import", MINUTE_MS);

      const [file] = await readdir(dir);
      const record = JSON.parse(await readFile(path.join(dir, file!), "utf-8"));

      expect(record.key).toBe("schedule-overlap:nightly-import");
      expect(record.pid).toBe(process.pid);
      expect(record.expiresAt).toBeGreaterThan(record.acquiredAt);
    });
  });

  it("creates the lock directory if it does not exist", async () => {
    const nested = path.join(dir, "deeply", "nested");
    const lock = new ScheduleLock(nested);

    expect(await lock.acquire("k", MINUTE_MS)).toBe(true);
    expect(await readdir(nested)).toHaveLength(1);
  });
});
