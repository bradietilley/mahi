import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logger.js";
import { StackLogger } from "../../src/loggers/stack-logger.js";

function spyLogger(): Logger {
  return {
    emergency: vi.fn(),
    alert: vi.fn(),
    critical: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    notice: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  };
}

describe("StackLogger", () => {
  it("a message logged through a stack of two loggers reaches both", () => {
    const a = spyLogger();
    const b = spyLogger();
    const stack = new StackLogger([a, b]);

    stack.info("hello", { foo: "bar" });

    // Fans out via each constituent's generic `log()` so every level is
    // carried with a single delegation.
    expect(a.log).toHaveBeenCalledWith("info", "hello", { foo: "bar" });
    expect(b.log).toHaveBeenCalledWith("info", "hello", { foo: "bar" });
  });

  it("fans out every level (all eight PSR-3 levels), not just one", () => {
    const a = spyLogger();
    const stack = new StackLogger([a]);

    stack.debug("d");
    stack.info("i");
    stack.notice("n");
    stack.warning("w");
    stack.error("e");
    stack.critical("c");
    stack.alert("a");
    stack.emergency("em");

    expect(a.log).toHaveBeenCalledWith("debug", "d", undefined);
    expect(a.log).toHaveBeenCalledWith("info", "i", undefined);
    expect(a.log).toHaveBeenCalledWith("notice", "n", undefined);
    expect(a.log).toHaveBeenCalledWith("warning", "w", undefined);
    expect(a.log).toHaveBeenCalledWith("error", "e", undefined);
    expect(a.log).toHaveBeenCalledWith("critical", "c", undefined);
    expect(a.log).toHaveBeenCalledWith("alert", "a", undefined);
    expect(a.log).toHaveBeenCalledWith("emergency", "em", undefined);
  });

  it("an empty stack is a safe no-op", () => {
    const stack = new StackLogger([]);
    expect(() => stack.info("noop")).not.toThrow();
  });
});
