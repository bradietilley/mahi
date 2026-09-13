import { splitKeys } from "./key.js";

/**
 * A source of key-press tokens an `InteractivePrompt`'s read loop can
 * `await` over one at a time. `RawTerminal` implements this against
 * real `process.stdin`; `FakeTerminal` (in `tui.ts`, used by
 * `Tui.fake()`) implements it against a pre-supplied list of keys.
 */
export interface KeySource {
  start(): void;
  stop(): void;
  nextKey(): Promise<string>;
}

/**
 * Wraps `process.stdin` in raw mode into an async key source, port of
 * the read-loop half of `Terminal::read()` from `laravel/prompts`'
 * `Terminal.php`, adapted for Node's event-driven `'data'` stream (see
 * the plan's "Key differences" #4: PHP's blocking `fread()` doesn't
 * need a tokenizer/queue the way Node's chunked `'data'` events do).
 */
export class RawTerminal implements KeySource {
  private queue: string[] = [];
  private waiters: ((key: string) => void)[] = [];

  private onData = (chunk: string): void => {
    for (const token of splitKeys(chunk)) {
      const waiter = this.waiters.shift();

      if (waiter) {
        waiter(token);
      } else {
        this.queue.push(token);
      }
    }
  };

  start(): void {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onData);
  }

  stop(): void {
    process.stdin.off("data", this.onData);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }

  async nextKey(): Promise<string> {
    const queued = this.queue.shift();

    if (queued !== undefined) {
      return queued;
    }

    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
