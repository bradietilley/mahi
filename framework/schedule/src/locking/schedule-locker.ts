/**
 * What `withoutOverlapping()` needs from a lock: take it if free, release
 * it afterwards. Deliberately narrower than a general mutex. There is no
 * "wait until available", because a scheduled task that is already running
 * should be *skipped* this tick, not queued up behind itself.
 *
 * `acquire()` returns a boolean rather than throwing so the caller can
 * distinguish "someone else has it" (normal, log at warning, move on) from
 * a real failure (a broken lock directory, an unreachable cache), which
 * still throws.
 *
 * Two implementations ship: `ScheduleLock` (lock files, the default, one
 * machine) and `CacheScheduleLocker` (any `CacheStore`, which over Redis
 * gives an overlap lock shared across every host running the scheduler).
 */
export interface ScheduleLocker {
  /**
   * Take the lock for `key`, if it's free. Returns `true` when acquired,
   * `false` when it is already held by a live holder.
   *
   * `expiresAfterMs` bounds how long the lock survives if it is never
   * released. A crashed process must not block its task forever. Every
   * implementation must make this atomic with respect to other processes
   * sharing the same backing store; a check-then-set does not qualify.
   */
  acquire(key: string, expiresAfterMs: number): Promise<boolean>;

  /** Release the lock for `key`. A no-op if it isn't held. */
  release(key: string): Promise<void>;
}
