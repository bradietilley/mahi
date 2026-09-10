/**
 * Run `fn`, then wait so the total elapsed time is at least `minMs`
 * regardless of which branch `fn` took.
 *
 * This is the general-purpose form of the constant-time-response trick
 * `AuthManager.attempt()` open-codes (hashing a throwaway value so a
 * missing user costs the same as a wrong password). Flows like password
 * reset need the same property but don't have a natural "hash something"
 * step to lean on — a "no such account" path can otherwise return
 * noticeably faster than the "account exists, send mail" path, leaking
 * account existence via timing.
 *
 * If `fn` itself already takes longer than `minMs`, no extra delay is
 * added. `fn`'s result (or thrown error) is preserved — the floor applies
 * to failures too, so an error path can't be distinguished by timing
 * either.
 */
export async function timebox<T>(fn: () => T | Promise<T>, minMs: number): Promise<T> {
  // Monotonic clock. `Date.now()` is wall time and can jump (NTP step,
  // manual adjustment) mid-operation, making `remaining` negative or huge
  // and defeating the floor this exists to enforce.
  const start = performance.now();

  try {
    const result = await fn();
    await waitRemaining(start, minMs);

    return result;
  } catch (error) {
    await waitRemaining(start, minMs);
    throw error;
  }
}

async function waitRemaining(start: number, minMs: number): Promise<void> {
  const remaining = minMs - (performance.now() - start);

  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
