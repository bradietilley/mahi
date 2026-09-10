import { describe, expect, it } from "vitest";
import { Limit, GlobalLimit, Unlimited } from "../../src/rate-limiting/limit.js";

describe("Limit", () => {
  it("perSecond() sets maxAttempts and a 1 second decay by default", () => {
    const limit = Limit.perSecond(5);
    expect(limit.maxAttempts).toBe(5);
    expect(limit.decaySeconds).toBe(1);
  });

  it("perSecond() accepts a custom decaySeconds", () => {
    const limit = Limit.perSecond(5, 2);
    expect(limit.decaySeconds).toBe(2);
  });

  it("perMinute() converts decayMinutes to seconds, defaulting to 1 minute", () => {
    const limit = Limit.perMinute(60);
    expect(limit.maxAttempts).toBe(60);
    expect(limit.decaySeconds).toBe(60);
  });

  it("perMinute() with an explicit decayMinutes", () => {
    const limit = Limit.perMinute(10, 5);
    expect(limit.decaySeconds).toBe(300);
  });

  it("perMinutes() takes decay-then-max argument order", () => {
    const limit = Limit.perMinutes(5, 10);
    expect(limit.maxAttempts).toBe(10);
    expect(limit.decaySeconds).toBe(300);
  });

  it("perHour() converts decayHours to seconds, defaulting to 1 hour", () => {
    const limit = Limit.perHour(100);
    expect(limit.decaySeconds).toBe(3600);
  });

  it("perDay() converts decayDays to seconds, defaulting to 1 day", () => {
    const limit = Limit.perDay(1000);
    expect(limit.decaySeconds).toBe(86400);
  });

  it("by() sets the key and is chainable", () => {
    const limit = Limit.perMinute(10).by("user-1");
    expect(limit.key).toBe("user-1");
  });

  it("after() sets the afterCallback and is chainable", () => {
    const cb = () => true;
    const limit = Limit.perMinute(10).after(cb);
    expect(limit.afterCallback).toBe(cb);
  });

  it("response() sets the responseCallback and is chainable", () => {
    const cb = () => "custom";
    const limit = Limit.perMinute(10).response(cb);
    expect(limit.responseCallback).toBe(cb);
  });

  it("fallbackKey() includes the key prefix when a key is set", () => {
    const limit = Limit.perMinute(10).by("user-1");
    expect(limit.fallbackKey()).toBe("user-1:attempts:10:decay:60");
  });

  it("fallbackKey() omits the prefix when no key is set", () => {
    const limit = Limit.perMinute(10);
    expect(limit.fallbackKey()).toBe("attempts:10:decay:60");
  });

  it("none() returns an Unlimited instance", () => {
    const limit = Limit.none();
    expect(limit).toBeInstanceOf(Unlimited);
  });
});

describe("GlobalLimit", () => {
  it("has an empty key regardless of what's set", () => {
    const limit = new GlobalLimit(100, 60);
    expect(limit.key).toBe("");
    expect(limit.maxAttempts).toBe(100);
    expect(limit.decaySeconds).toBe(60);
  });

  it("defaults decaySeconds to 60", () => {
    const limit = new GlobalLimit(100);
    expect(limit.decaySeconds).toBe(60);
  });

  it("is a Limit", () => {
    expect(new GlobalLimit(100)).toBeInstanceOf(Limit);
  });
});

describe("Unlimited", () => {
  it("has an effectively unbounded maxAttempts", () => {
    const limit = new Unlimited();
    expect(limit.maxAttempts).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is a GlobalLimit and a Limit", () => {
    const limit = new Unlimited();
    expect(limit).toBeInstanceOf(GlobalLimit);
    expect(limit).toBeInstanceOf(Limit);
  });
});
