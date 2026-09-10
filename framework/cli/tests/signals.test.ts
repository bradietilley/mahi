import { afterEach, describe, expect, it, vi } from "vitest";
import { trap } from "../src/signals.js";

describe("trap", () => {
  afterEach(() => {
    // Belt-and-suspenders: make sure no test leaks a listener that
    // fires (and potentially throws) during a later test's run.
    process.removeAllListeners("SIGUSR2");
  });

  it("registers a callback for a single signal", () => {
    const callback = vi.fn();
    const untrap = trap("SIGUSR2", callback);

    process.emit("SIGUSR2");
    expect(callback).toHaveBeenCalledWith("SIGUSR2");

    untrap();
  });

  it("registers a callback for multiple signals", () => {
    const callback = vi.fn();
    const untrap = trap(["SIGUSR2"], callback);

    process.emit("SIGUSR2");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("SIGUSR2");

    untrap();
  });

  it("stops receiving signals after untrap() is called", () => {
    const callback = vi.fn();
    const untrap = trap("SIGUSR2", callback);
    untrap();

    process.emit("SIGUSR2");
    expect(callback).not.toHaveBeenCalled();
  });

  it("only removes the listeners it registered, leaving others intact", () => {
    const other = vi.fn();
    process.on("SIGUSR2", other);

    const callback = vi.fn();
    const untrap = trap("SIGUSR2", callback);
    untrap();

    process.emit("SIGUSR2");
    expect(other).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();

    process.off("SIGUSR2", other);
  });
});
