/** Thrown by `Lock.acquire()` when `maximumWaitForSeconds` elapses before the lock could be acquired. */
export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Timed out waiting to acquire lock "${key}".`);
    this.name = "LockTimeoutError";
  }
}
