import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "@mahiframework/core";
import { HealthRegistry } from "../src/health-registry.js";

/**
 * Fake timers throughout. This suite must never actually sleep. A test
 * that waits five real seconds to prove a five-second deadline works is a
 * test people delete.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A check that never settles on its own, only the deadline can end it. */
const never = () => new Promise<void>(() => {});

describe("per-check timeouts", () => {
  it("yields a timeout message and completes the run", async () => {
    const registry = new HealthRegistry(new Application(), { timeoutSeconds: 5 }).register({
      name: "hung",
      run: never,
    });

    const running = registry.run();
    await vi.advanceTimersByTimeAsync(5000);
    const report = await running;

    expect(report.results.app?.hung).toBe("Timed out after 5s");
    expect(report.healthy).toBe(false);
  });

  it("defaults to 5 seconds when nothing configures it", async () => {
    const registry = new HealthRegistry(new Application()).register({ name: "hung", run: never });

    const running = registry.run();
    await vi.advanceTimersByTimeAsync(4999);
    await vi.advanceTimersByTimeAsync(1);

    expect((await running).results.app?.hung).toBe("Timed out after 5s");
  });

  it("lets a check override the configured default", async () => {
    const registry = new HealthRegistry(new Application(), { timeoutSeconds: 30 }).register({
      name: "hung",
      timeoutSeconds: 1,
      run: never,
    });

    const running = registry.run();
    await vi.advanceTimersByTimeAsync(1000);

    expect((await running).results.app?.hung).toBe("Timed out after 1s");
  });

  it("does not time out a check that resolves inside its deadline", async () => {
    const registry = new HealthRegistry(new Application(), { timeoutSeconds: 5 }).register({
      name: "quick",
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
    });

    const running = registry.run();
    await vi.advanceTimersByTimeAsync(100);

    expect((await running).results.app?.quick).toBe(true);
  });

  it("times each check separately rather than the run as a whole", async () => {
    const registry = new HealthRegistry(new Application(), { timeoutSeconds: 2 }).register(
      { name: "first", run: never },
      { name: "second", run: never },
    );

    const running = registry.run();
    // Sequential: the first check's deadline has to elapse before the
    // second one even starts, so the run costs 2 x 2s.
    await vi.advanceTimersByTimeAsync(4000);
    const report = await running;

    expect(report.results.app).toEqual({
      first: "Timed out after 2s",
      second: "Timed out after 2s",
    });
  });
});

describe("timer hygiene", () => {
  it("clears the deadline timer on the success path", async () => {
    const registry = new HealthRegistry(new Application(), { timeoutSeconds: 60 }).register({
      name: "quick",
      run: () => {},
    });

    await registry.run();

    // A leaked timer keeps the Node process alive after `./artisan
    // health` has printed its table, a hang, not a slow exit.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline timer on the failure path", async () => {
    const registry = new HealthRegistry(new Application(), { timeoutSeconds: 60 }).register({
      name: "broken",
      run: () => {
        throw new Error("boom");
      },
    });

    await registry.run();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline timer after a timeout fires", async () => {
    const registry = new HealthRegistry(new Application(), { timeoutSeconds: 1 }).register({
      name: "hung",
      run: never,
    });

    const running = registry.run();
    await vi.advanceTimersByTimeAsync(1000);
    await running;

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("late resolution", () => {
  it("does not corrupt an already-built report when a check resolves after its deadline", async () => {
    let settle: (() => void) | undefined;
    const registry = new HealthRegistry(new Application(), { timeoutSeconds: 1 }).register({
      name: "late",
      run: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    });

    const running = registry.run();
    await vi.advanceTimersByTimeAsync(1000);
    const report = await running;

    expect(report.results.app?.late).toBe("Timed out after 1s");

    // The abandoned check finishes long after the report was returned.
    // `Promise.race` has already settled, so this must be inert.
    settle?.();
    await vi.advanceTimersByTimeAsync(10);

    expect(report.results.app?.late).toBe("Timed out after 1s");
    expect(report.healthy).toBe(false);
  });
});

describe("degenerate deadlines", () => {
  it("runs without a timer when the deadline is zero or negative", async () => {
    const registry = new HealthRegistry(new Application()).register({
      name: "unbounded",
      timeoutSeconds: 0,
      run: () => {},
    });

    expect((await registry.run()).results.app?.unbounded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs without a timer when the deadline is Infinity", async () => {
    const registry = new HealthRegistry(new Application()).register({
      name: "unbounded",
      timeoutSeconds: Number.POSITIVE_INFINITY,
      run: () => {},
    });

    expect((await registry.run()).results.app?.unbounded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
