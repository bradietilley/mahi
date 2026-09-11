import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ScheduleLocker } from "./schedule-locker.js";

/**
 * How long a reclaim marker may sit before it's assumed to belong to a
 * process that died mid-reclaim. The critical section it guards is two
 * filesystem operations long, so anything approaching this is certainly a
 * crash rather than slowness.
 */
const RECLAIM_STALE_MS = 30_000;

/** The JSON written into a lock file. */
interface LockRecord {
  /** When the lock was taken, as epoch milliseconds. */
  acquiredAt: number;
  /** When it becomes reclaimable, as epoch milliseconds. */
  expiresAt: number;
  /** The original (unhashed) key, so a stray lock file can be traced back to a task. */
  key: string;
  /** The PID that took it — diagnostics only; nothing keys off it. */
  pid: number;
}

/**
 * File-based lock for `withoutOverlapping()`, and the default locker.
 *
 * `schedule:run` spawns a fresh process every minute (cron), so there's no
 * persistent worker to hold "is the previous run still going" in memory —
 * that state has to outlive the process, and a file on disk is the
 * simplest zero-infrastructure thing that does.
 *
 * Two properties this deliberately has, both of which the original
 * implementation lacked:
 *
 * **Acquisition is atomic.** `open(path, "wx")` creates the file only if
 * it does not exist, in one syscall, failing with `EEXIST` otherwise.
 * A separate `isLocked()` check followed by a `writeFile()` is a
 * check-then-act race: two `schedule:run` processes started in the same
 * minute — which happens the moment a run takes longer than a minute and
 * cron fires the next one — both saw "not locked" and both ran.
 *
 * **Keys are hashed, not sanitised.** Replacing unsafe characters with `_`
 * mapped distinct keys onto one filename (`0 0 * * *` and `0-0 * * *` both
 * became `0_0______`), so unrelated tasks quietly shared a lock. A SHA-256
 * prefix can't collide by accident, and the original key is written inside
 * the file so a leftover lock is still traceable.
 *
 * Still a **single-machine** lock: the directory is local. For a lock that
 * spans hosts, configure a cache-backed locker over a shared store — see
 * `CacheScheduleLocker`.
 */
export class ScheduleLock implements ScheduleLocker {
  constructor(
    private directory: string,
    /**
     * Fallback expiry, in milliseconds, for locks taken without an
     * explicit one. A lock past its expiry is treated as abandoned — the
     * process holding it presumably crashed — and can be taken over.
     */
    private maxRuntimeMs = 60 * 60 * 1000, // 1 hour
  ) {}

  /**
   * A filename that is (a) a valid filename for any key, and (b) unique
   * per key. A truncated SHA-256 gives both; 32 hex characters is 128 bits,
   * far past any realistic collision risk for a set of keys bounded by the
   * size of one app's schedule.
   */
  private lockPath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);

    return path.join(this.directory, `${digest}.lock`);
  }

  /**
   * Take the lock for `key` if it is free, returning whether we got it.
   *
   * The fast path is a single `open(..., "wx")` — atomic, and the only
   * path that runs when nothing has crashed. `EEXIST` means someone holds
   * it: if their record is still live we simply lose; if it has expired,
   * we go through `reclaim()`, which is where the subtlety is.
   */
  async acquire(key: string, expiresAfterMs: number = this.maxRuntimeMs): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });

    if (await this.write(key, expiresAfterMs)) {
      return true;
    }

    // Held. Take it over only if the holder's record has expired.
    const record = await this.read(key);

    if (record && Date.now() < record.expiresAt) {
      return false;
    }

    return this.reclaim(key, expiresAfterMs);
  }

  /**
   * Take over a lock whose holder crashed without releasing it.
   *
   * The naive version — `rm()` the expired file, then `wx` a new one — is
   * a race with a nastier shape than the one `wx` fixes. Two processes
   * both see the expired record; A removes and creates, and then B, still
   * acting on its stale observation, removes *A's fresh lock* and creates
   * its own. Both `wx` calls succeeded, so both believe they hold the
   * lock, and the task runs twice. `wx` alone cannot prevent this, because
   * the hazard is the unconditional `rm` — and POSIX offers no
   * compare-and-delete.
   *
   * So the removal is serialised behind a second, short-lived lock file,
   * taken with the same atomic `wx`. Exactly one process is inside the
   * critical section at a time, and it **re-reads the record there**,
   * under exclusion, before deleting anything — so B, arriving after A has
   * finished, sees A's live lock and backs off instead of clobbering it.
   *
   * A reclaimer that crashes mid-section leaves its own marker behind;
   * that is cleared on age, which reintroduces a race only in the case
   * where a process crashed inside a microsecond-long critical section AND
   * another two contend more than `RECLAIM_STALE_MS` later — at which
   * point the outcome (a task running twice after a crash) is the one the
   * expiry mechanism already accepts by design.
   */
  private async reclaim(key: string, expiresAfterMs: number): Promise<boolean> {
    const reclaimPath = `${this.lockPath(key)}.reclaim`;

    if (!(await this.createMarker(reclaimPath))) {
      // Either a live reclaimer (we lose) or a crashed one (clear and try
      // once more).
      if (!(await this.clearStaleMarker(reclaimPath))) {
        return false;
      }

      if (!(await this.createMarker(reclaimPath))) {
        return false;
      }
    }

    try {
      // Under exclusion: has someone already reclaimed while we waited?
      const current = await this.read(key);

      if (current && Date.now() < current.expiresAt) {
        return false;
      }

      await rm(this.lockPath(key), { force: true });

      return await this.write(key, expiresAfterMs);
    } finally {
      await rm(reclaimPath, { force: true });
    }
  }

  /** `wx` a marker file holding only its own timestamp. `false` means someone else has it. */
  private async createMarker(markerPath: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(markerPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }

      throw error;
    }

    try {
      await handle.writeFile(String(Date.now()));
    } finally {
      await handle.close();
    }

    return true;
  }

  /** Removes a reclaim marker older than `RECLAIM_STALE_MS`. Returns whether it removed one. */
  private async clearStaleMarker(markerPath: string): Promise<boolean> {
    let writtenAt: number;
    try {
      writtenAt = Number(await readFile(markerPath, "utf-8"));
    } catch {
      // Gone already — the holder finished. Retrying is fine.
      return true;
    }

    if (Number.isFinite(writtenAt) && Date.now() - writtenAt < RECLAIM_STALE_MS) {
      return false;
    }

    await rm(markerPath, { force: true });

    return true;
  }

  /** `open(..., "wx")`: create-if-absent, atomically. `false` means someone else holds it. */
  private async write(key: string, expiresAfterMs: number): Promise<boolean> {
    const now = Date.now();
    const record: LockRecord = {
      acquiredAt: now,
      expiresAt: now + expiresAfterMs,
      key,
      pid: process.pid,
    };

    let handle;
    try {
      handle = await open(this.lockPath(key), "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }

      throw error;
    }

    try {
      await handle.writeFile(JSON.stringify(record));
    } finally {
      await handle.close();
    }

    return true;
  }

  private async read(key: string): Promise<LockRecord | undefined> {
    try {
      const contents = await readFile(this.lockPath(key), "utf-8");
      const parsed = JSON.parse(contents) as LockRecord;

      return typeof parsed?.expiresAt === "number" ? parsed : undefined;
    } catch {
      // Missing, unreadable, or not JSON — in every case there is no
      // usable record, and the caller treats that as "not a live lock".
      return undefined;
    }
  }

  /**
   * Whether a live (unexpired) lock exists for `key`.
   *
   * Diagnostic only — `acquire()` does its own check atomically, and
   * calling this before it would reintroduce exactly the race `acquire()`
   * exists to close.
   */
  async isLocked(key: string): Promise<boolean> {
    const record = await this.read(key);

    return record !== undefined && Date.now() < record.expiresAt;
  }

  async release(key: string): Promise<void> {
    await rm(this.lockPath(key), { force: true });
  }
}
