import { describe, expect, it } from "vitest";
import { Hub } from "../src/hub.js";

describe("Hub", () => {
  it("runs a named pipeline over a passable", async () => {
    const hub = new Hub();
    hub.pipeline("double-then-inc", (pipeline, n: number) =>
      pipeline
        .send(n)
        .through([(value, next) => next(value * 2), (value, next) => next(value + 1)])
        .thenReturn(),
    );

    await expect(hub.pipe(3, "double-then-inc")).resolves.toBe(7);
  });

  it("defaults() registers the default pipeline used by pipe() with no name", async () => {
    const hub = new Hub();
    hub.defaults((pipeline, s: string) =>
      pipeline
        .send(s)
        .through([(value, next) => next(value.toUpperCase())])
        .thenReturn(),
    );

    await expect(hub.pipe("hi")).resolves.toBe("HI");
    expect(hub.has("default")).toBe(true);
  });

  it("throws when the named pipeline is missing", async () => {
    const hub = new Hub();
    await expect(hub.pipe(1, "missing")).rejects.toThrow("Pipeline [missing] is not registered");
  });
});
