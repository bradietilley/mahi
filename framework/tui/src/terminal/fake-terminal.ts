import type { KeySource } from "./raw-terminal.js";

/**
 * A `KeySource` that yields a pre-supplied list of keys one at a time
 * instead of reading real `process.stdin` — what `Tui.fake([...keys])`
 * wires up so `ask()`/`select()` can be driven deterministically in
 * tests, matching PHP's `Prompt::fake([...keys])` (`FakesInputOutput`).
 * `start()`/`stop()` are no-ops since there's no real stdin to toggle
 * raw mode on.
 */
export class FakeTerminal implements KeySource {
  private queue: string[];

  constructor(keys: string[] = []) {
    this.queue = [...keys];
  }

  start(): void {
    // no-op — nothing to wire up against a fake key source
  }

  stop(): void {
    // no-op
  }

  async nextKey(): Promise<string> {
    const key = this.queue.shift();

    if (key === undefined) {
      // Out of scripted keys — block forever rather than throwing, so a
      // prompt that (incorrectly, in a test) doesn't submit on the
      // scripted keys hangs visibly instead of silently returning
      // garbage. Matches PHP's `fakeKeyPresses` foreach loop simply
      // running out of iterations (its `runLoop`'s `terminal()->read()`
      // never returns null in the mocked path).
      return new Promise(() => {
        /* never resolves */
      });
    }

    return key;
  }
}
