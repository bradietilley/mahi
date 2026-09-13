/**
 * Generic, reusable signal registration, port of Laravel's
 * `Illuminate\Console\Concerns\InteractsWithSignals::trap()`
 * (`$this->trap([SIGINT, SIGTERM], fn () => ...)`), simplified: PHP
 * needs `pcntl_signal()` plus a whole `Signals`/`SignalRegistry`
 * handler-stacking layer to get generic, reusable signal handling;
 * Node's `process.on(signal, callback)` already *is* that generic,
 * reusable primitive, so this is a thin convenience wrapper, not a
 * port of any real machinery.
 */

/** Any signal name Node's `process.on()`/`process.off()` accept, re-exported under a shorter name for call sites. */
export type Signal = NodeJS.Signals;

/**
 * Registers `callback` to run when any of `signals` is delivered to
 * this process. Returns an `untrap()` function that removes exactly
 * the handlers this call registered, always call it once the
 * trapped work is done (e.g. in a `finally` block) to avoid leaking
 * listeners, matching Laravel's paired `trap()`/`untrap()`.
 *
 * ```ts
 * const untrap = trap(["SIGINT", "SIGTERM"], (signal) => {
 *   console.log(`Received ${signal}, shutting down...`);
 *   running = false;
 * });
 * try {
 *   // ... long-running loop ...
 * } finally {
 *   untrap();
 * }
 * ```
 */
export function trap(signals: Signal | Signal[], callback: (signal: Signal) => void): () => void {
  const list = Array.isArray(signals) ? signals : [signals];
  const handlers = list.map((signal) => {
    const handler = () => callback(signal);
    process.on(signal, handler);

    return { signal, handler };
  });

  return function untrap(): void {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  };
}
