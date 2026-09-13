import { createHash, randomBytes } from "node:crypto";
import { numericValue } from "./numeric-value.js";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CacheStore } from "../cache-store.js";
import { remember, rememberViaLock, lock } from "../cache-store-helpers.js";
import type { Lock, LockOptions } from "../locking/lock.js";

/** The on-disk shape of one cache entry. `expiresAt` is epoch ms, or `null` for "no expiry". */
interface Entry {
  /** The original cache key. Not read back by this store, kept so a cache directory is debuggable by hand. */
  key: string;
  value: unknown;
  expiresAt: number | null;
}

/**
 * A durable `CacheStore` that keeps **one file per key** under a
 * directory, and is safe for several processes to share.
 *
 * That combination is the whole point. It is the only non-Redis store
 * that survives a restart, so it is what a multi-process app without
 * Redis reaches for, a web server plus `queue:work` plus a
 * `schedule:run` cron invocation, all pointed at the same directory. The
 * obvious alternative, a single JSON file rewritten in full on every
 * operation, serialized only by an **in-process** promise chain, fails
 * exactly those users:
 *
 *   - **lost updates.** Two processes each do an unsynchronised
 *     read-modify-write of the whole file; the last writer wins and the
 *     other's changes vanish. `increment()` under a `RateLimiter`
 *     undercounts, and `add()` returns `true` in two processes at once,
 *     so `Lock`, `WithoutOverlapping` and `rememberViaLock()` guard
 *     nothing.
 *   - **a store one crash away from unreadable.** A plain `writeFile()`
 *     killed mid-write leaves truncated JSON, and every subsequent read
 *     of *every* key throws.
 *   - **a write on every read.** If `get()`/`has()` re-persist the entire
 *     file to prune expired entries, a 10MB cache costs a 10MB write per
 *     cache hit.
 *
 * ## The layout
 *
 * ```
 * <directory>/ab/cd/abcd…            one file, JSON, per key
 * <directory>/ab/cd/abcd….lock       transient, only while a
 *                                    read-modify-write is in flight
 * ```
 *
 * The path is `sha1(key)` split into two 2-character directory levels,
 * matching Laravel's file store. Hashing gives a filesystem-safe name for
 * any key (`user:1/profile`, a URL, a 300-character key); fanning out
 * over 65,536 directories keeps any one of them small enough that
 * `readdir` and the kernel's directory index stay fast.
 *
 * ## What makes it safe
 *
 * Three filesystem guarantees, all POSIX, none of them a lock the process
 * has to remember to drop:
 *
 *   - **`rename()` is atomic.** Every write goes to a temp file in the
 *     same directory and is then renamed over the target, so a reader
 *     sees either the whole old entry or the whole new one, never a
 *     partial write, and a crash mid-write leaves the previous entry
 *     intact rather than a truncated file. One corrupt entry cannot take
 *     the whole cache down with it: there is no "whole cache" file to
 *     corrupt.
 *   - **`open(path, "wx")` is atomic create-if-absent.** That is exactly
 *     `add()`'s contract, so the common path is a single syscall with no
 *     lock at all, and it is genuinely exclusive across processes, which
 *     is what makes a `Lock` on this store work between the web server
 *     and a worker.
 *   - **an `O_EXCL` lock file** for the two operations that are
 *     unavoidably read-modify-write (`increment()`, and the `add()` case
 *     where a key exists but has expired). Held for microseconds, and
 *     reclaimed by the next caller if it is older than
 *     `STALE_LOCK_MS`, a process killed while holding one cannot wedge
 *     a key permanently.
 *
 * **Reads never write.** `get()`/`has()` read one file. The only write on
 * the read path is unlinking an entry that has expired.
 *
 * ## The caveat
 *
 * `O_EXCL` and `rename()` are atomic on a local filesystem. On NFS they
 * historically are not, and on a network filesystem this store's
 * cross-process guarantees do not hold, use Redis. Nothing here detects
 * that for you.
 */
export class FileCacheStore implements CacheStore {
  /** Give up acquiring an entry's lock file after this long, and throw. */
  static readonly LOCK_TIMEOUT_MS = 5_000;
  /**
   * A lock file older than this is assumed abandoned by a dead process and
   * is reclaimed.
   *
   * Must stay comfortably ABOVE `LOCK_TIMEOUT_MS`. When the two were equal,
   * a waiter that had been descheduled for the whole timeout could decide a
   * still-live holder was stale and unlink its lock, so both processes
   * believed they held it and `add()` returned true twice. The critical
   * section is microseconds of real work, so the gap only has to cover
   * scheduler starvation, not legitimate slowness.
   */
  static readonly STALE_LOCK_MS = 30_000;

  /**
   * @param directory Where entry files live. A **directory**, not a file,
   * the pre-`one-file-per-key` layout took the path of a single
   * `cache.json`, and a config still pointing at one is rejected with an
   * actionable error rather than a bare `ENOTDIR` (see
   * `describeDirectoryFailure()`).
   */
  constructor(private readonly directory: string) {}

  async get<T>(key: string): Promise<T | undefined> {
    const file = this.pathFor(key);
    const entry = await this.readEntry(file);

    if (entry === undefined) {
      return undefined;
    }

    if (this.hasExpired(entry)) {
      // Lazy expiry: reclaim the inode, report a miss. Best-effort,
      // another process may have unlinked it already, or be mid-`add()`
      // on the same key, and neither is an error for a reader.
      await unlink(file).catch(() => undefined);

      return undefined;
    }

    return entry.value as T;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.writeEntry(this.pathFor(key), {
      key,
      value,
      expiresAt: expiryFrom(ttlSeconds),
    });
  }

  async forget(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(ignoreMissing);
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  /**
   * Removes the whole cache directory in one `rm -rf`, rather than
   * walking and unlinking each entry: it is one syscall's worth of work
   * instead of one per key, and it cannot leave a half-cleared cache
   * behind if it is interrupted. The directory is recreated lazily by the
   * next write.
   */
  async flush(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  /**
   * Deletes every entry whose TTL has already elapsed, plus any scratch
   * file a crash left behind. Returns how many files it removed.
   *
   * Expiry is otherwise lazy, an entry is only removed when something
   * reads it, so a key space that is written far more often than it is
   * read (per-IP rate-limit counters, per-session data) accumulates dead
   * files that nothing will ever touch again. Nothing calls this
   * automatically: it is a full directory walk, whose cost belongs to a
   * scheduled task the app owns rather than to a random unlucky request.
   *
   * ```ts
   * schedule.command("cache:prune").hourly();
   * ```
   *
   * The scratch files are the other half. A process killed between
   * `writeFile()` and `rename()` leaves a `.tmp`, and one killed holding
   * an entry lock leaves a `.lock`. Neither is a correctness problem,
   * the `.tmp` is inert, and the `.lock` is reclaimed as stale by the
   * next writer of that key, but a `.lock` on a key nothing writes again
   * is never reclaimed at all, so this is where they go.
   */
  async prune(): Promise<number> {
    let removed = 0;
    const remove = async (file: string) => {
      if (
        await unlink(file).then(
          () => true,
          () => false,
        )
      ) {
        removed += 1;
      }
    };

    const { entries, scratch } = await this.walk();

    for (const file of entries) {
      const entry = await this.readEntry(file);

      // `undefined` covers an unreadable/corrupt entry as well as one
      // that vanished mid-walk, a file this store cannot parse is dead
      // weight that every future read would discard anyway.
      if (entry !== undefined && !this.hasExpired(entry)) {
        continue;
      }

      await remove(file);
    }

    for (const { file, mtimeMs } of scratch) {
      // Only ones old enough to be certainly abandoned, a `.tmp` or
      // `.lock` created a millisecond ago belongs to an operation that is
      // still running, quite possibly in another process.
      if (Date.now() - mtimeMs <= FileCacheStore.STALE_LOCK_MS) {
        continue;
      }

      await remove(file);
    }

    return removed;
  }

  /**
   * Atomic across processes via an `O_EXCL` lock file around the
   * read-modify-write. Preserves the existing entry's expiry rather than
   * resetting it, matching `ArrayCacheStore.increment()` and Redis
   * `INCRBY`, which `RateLimiter` depends on (an incrementing counter
   * that also extended its own window would turn "5 per minute" into "5
   * per minute of silence").
   *
   * Throws on a non-numeric existing value rather than coercing.
   * `"5" + 1` in JavaScript is `"51"`, which would turn a cached string
   * into nonsense and keep going; Redis rejects the same operation
   * outright, and a store that disagrees with the others about this is
   * worse than one that fails.
   */
  async increment(key: string, amount = 1): Promise<number> {
    const file = this.pathFor(key);

    return this.withEntryLock(file, async () => {
      const existing = await this.readEntry(file);
      const live = existing !== undefined && !this.hasExpired(existing) ? existing : undefined;
      const current = numericValue("FileCacheStore", key, live?.value);

      const next = current + amount;
      await this.writeEntry(file, { key, value: next, expiresAt: live?.expiresAt ?? null });

      return next;
    });
  }

  /**
   * Set only if absent (or expired), atomically, across processes, not
   * just within one. `Lock.acquire()` and `RateLimiter`'s window seeding
   * are both built directly on this.
   *
   * The common path is a single `open(path, "wx")`: the kernel either
   * creates the file or reports `EEXIST`, with no window in between for
   * another process to slip through. Only when a file already exists but
   * has **expired** does this need the slower locked path, the check and
   * the overwrite must not interleave, or two processes could both
   * observe "expired" and both claim the key.
   */
  async add<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    const file = this.pathFor(key);
    const entry: Entry = { key, value, expiresAt: expiryFrom(ttlSeconds) };

    if (await this.createExclusively(file, entry)) {
      return true;
    }

    // The file existed. Only an expired entry can be taken over, and only
    // under the lock, re-reading inside it, because it may have been
    // rewritten by whoever held the lock before us.
    const existing = await this.readEntry(file);

    if (existing !== undefined && !this.hasExpired(existing)) {
      return false;
    }

    return this.withEntryLock(file, async () => {
      const current = await this.readEntry(file);

      if (current !== undefined && !this.hasExpired(current)) {
        return false;
      }

      await this.writeEntry(file, entry);

      return true;
    });
  }

  /**
   * Compare-and-delete under the entry's lock file, the atomic release
   * path `Lock.release()` uses in preference to `get()`-then-`forget()`.
   *
   * Without it, a lock whose TTL expires between those two calls can be
   * re-acquired by another process, and the original holder's `forget()`
   * then deletes the *new* holder's lock. Two live holders of a
   * mutual-exclusion lock is the one outcome a lock exists to prevent,
   * and this store is shared across processes, so it must close that
   * window. See `CacheStore.releaseLock()`.
   */
  async releaseLock(key: string, owner: string): Promise<boolean> {
    const file = this.pathFor(key);

    return this.withEntryLock(file, async () => {
      const entry = await this.readEntry(file);

      if (entry === undefined || this.hasExpired(entry) || entry.value !== owner) {
        return false;
      }

      await unlink(file).catch(ignoreMissing);

      return true;
    });
  }

  async remember<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds: number | null = null,
  ): Promise<T> {
    return remember(this, key, callback, ttlSeconds);
  }

  async rememberViaLock<T>(
    key: string,
    callback: () => T | Promise<T>,
    ttlSeconds: number | null = null,
  ): Promise<T> {
    return rememberViaLock(this, key, callback, ttlSeconds);
  }

  lock(options: LockOptions): Lock {
    return lock(this, options);
  }

  /** `<directory>/ab/cd/<sha1>`. See the class docstring on why it is hashed and fanned out. */
  private pathFor(key: string): string {
    const hash = createHash("sha1").update(key).digest("hex");

    return path.join(this.directory, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  private hasExpired(entry: Entry): boolean {
    return entry.expiresAt !== null && entry.expiresAt < Date.now();
  }

  /**
   * Reads and parses one entry file. A missing file is a miss; so is an
   * unparseable one, which this store treats as a miss rather than an
   * error on purpose, the blast radius of a damaged file is now exactly
   * the one key it holds, and reporting it as a cache miss lets the
   * caller recompute instead of taking a 500 for a *cache*.
   */
  private async readEntry(file: string): Promise<Entry | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }

      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Entry;

      return typeof parsed === "object" && parsed !== null ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes an entry via temp file + `rename()`, which is atomic: a
   * concurrent reader sees the old entry or the new one, never a
   * half-written one, and a crash between the two steps leaves the
   * previous entry intact and one stray temp file.
   *
   * The temp file is created in the entry's own directory, because
   * `rename()` is only atomic within a single filesystem, via `/tmp` it
   * could silently degrade to a copy.
   */
  private async writeEntry(file: string, entry: Entry): Promise<void> {
    const directory = path.dirname(file);
    await this.ensureDirectory(directory);

    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(entry), "utf-8");
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /** `open(…, "wx")`: create-and-write iff absent, atomically. `false` when the file already existed. */
  private async createExclusively(file: string, entry: Entry): Promise<boolean> {
    await this.ensureDirectory(path.dirname(file));

    let handle;
    try {
      handle = await open(file, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }

      throw error;
    }

    try {
      await handle.writeFile(JSON.stringify(entry), "utf-8");
    } finally {
      await handle.close();
    }

    return true;
  }

  /**
   * Runs `fn` while holding an exclusive lock on `file`, for the two
   * operations that cannot be expressed as a single atomic syscall.
   *
   * The lock is a sibling `.lock` file created with `O_EXCL`, which is
   * the portable cross-process mutex Node exposes (there is no portable
   * `flock`). A lock older than `STALE_LOCK_MS` is assumed to belong to a
   * process that died holding it and is reclaimed, without that, a
   * `kill -9` at the wrong microsecond would make one cache key
   * permanently unwritable, which is a far worse failure than the brief
   * window of over-eager reclamation it trades for.
   */
  private async withEntryLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = `${file}.lock`;
    await this.acquireEntryLock(lockPath);
    try {
      return await fn();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async acquireEntryLock(lockPath: string): Promise<void> {
    await this.ensureDirectory(path.dirname(lockPath));
    const deadline = Date.now() + FileCacheStore.LOCK_TIMEOUT_MS;

    while (true) {
      try {
        await (await open(lockPath, "wx")).close();

        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      const age = await stat(lockPath).then(
        (stats) => Date.now() - stats.mtimeMs,
        // The holder released it between our EEXIST and this stat, retry
        // immediately rather than sleeping for a lock that is now free.
        () => Number.NaN,
      );

      if (age > FileCacheStore.STALE_LOCK_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `FileCacheStore: timed out after ${FileCacheStore.LOCK_TIMEOUT_MS}ms waiting for the lock at ${lockPath}.`,
        );
      }

      await delay(1);
    }
  }

  private async ensureDirectory(directory: string): Promise<void> {
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw this.describeDirectoryFailure(error);
    }
  }

  /**
   * `ENOTDIR`/`EEXIST` here means a component of the path is a regular
   * file, overwhelmingly because `config/cache.ts` still points
   * `stores.file.path` at the old single-file `storage/cache.json`. The
   * raw errno for that is unreadable, so say what actually happened.
   */
  private describeDirectoryFailure(error: unknown): unknown {
    const code = (error as NodeJS.ErrnoException).code;

    if (code !== "ENOTDIR" && code !== "EEXIST") {
      return error;
    }

    return new Error(
      `FileCacheStore: "${this.directory}" is a file, not a directory. This store now keeps ` +
        `one file per key under a directory; update config/cache.ts's stores.file.path to a ` +
        `directory (e.g. "storage/cache") and delete the old cache file.`,
      { cause: error },
    );
  }

  /** Walks the cache directory once, splitting real entries from `.lock`/`.tmp` leftovers. */
  private async walk(): Promise<{
    entries: string[];
    scratch: Array<{ file: string; mtimeMs: number }>;
  }> {
    let found;
    try {
      found = await readdir(this.directory, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return { entries: [], scratch: [] };
      }

      throw error;
    }

    const entries: string[] = [];
    const scratch: Array<{ file: string; mtimeMs: number }> = [];

    for (const dirent of found) {
      if (!dirent.isFile()) {
        continue;
      }

      const file = path.join(dirent.parentPath, dirent.name);

      if (!dirent.name.endsWith(".lock") && !dirent.name.endsWith(".tmp")) {
        entries.push(file);
        continue;
      }

      // Age decides whether a scratch file is abandoned or in use, and
      // a file that vanished between the readdir and the stat is simply
      // not there to clean up.
      const mtimeMs = await stat(file).then(
        (stats) => stats.mtimeMs,
        () => Number.POSITIVE_INFINITY,
      );

      if (Number.isFinite(mtimeMs)) {
        scratch.push({ file, mtimeMs });
      }
    }

    return { entries, scratch };
  }
}

function expiryFrom(ttlSeconds: number | undefined): number | null {
  return ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function ignoreMissing(error: unknown): void {
  if (!isMissing(error)) {
    throw error;
  }
}
