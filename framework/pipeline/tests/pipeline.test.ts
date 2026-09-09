import { describe, expect, it } from "vitest";
import { Pipeline, type PipeObject, type Next } from "../src/pipeline.js";

describe("Pipeline", () => {
  it("runs pipes in order, forwarding the passable, and reaches the destination", async () => {
    const order: string[] = [];

    const result = await new Pipeline<number>()
      .send(1)
      .through([
        async (n, next) => {
          order.push("a");

          return next(n + 1);
        },
        async (n, next) => {
          order.push("b");

          return next(n + 1);
        },
      ])
      .run((n) => {
        order.push("destination");

        return n + 1;
      });

    expect(order).toEqual(["a", "b", "destination"]);
    expect(result).toBe(4);
  });

  it("lets a pipe modify the passable before forwarding", async () => {
    const result = await new Pipeline<string>()
      .send("hello")
      .through([(s, next) => next(s.toUpperCase()), (s, next) => next(`${s}!`)])
      .run((s) => s);

    expect(result).toBe("HELLO!");
  });

  it("short-circuits when a pipe returns without calling next()", async () => {
    const destinationCalls: number[] = [];

    const result = await new Pipeline<number, string>()
      .send(5)
      .through([
        (n, _next) => `short-circuited at ${n}`,
        (_n, next) => next(999), // never reached
      ])
      .run((n) => {
        destinationCalls.push(n);

        return `reached destination with ${n}`;
      });

    expect(result).toBe("short-circuited at 5");
    expect(destinationCalls).toEqual([]);
  });

  it("supports an empty pipe stack, calling the destination directly", async () => {
    const result = await new Pipeline<number>()
      .send(10)
      .through([])
      .run((n) => n * 2);

    expect(result).toBe(20);
  });

  it("supports object pipes with a handle() method, preserving `this`", async () => {
    class Multiplier implements PipeObject<number, number> {
      constructor(private factor: number) {}

      async handle(n: number, next: Next<number, number>): Promise<number> {
        return next(n * this.factor);
      }
    }

    const result = await new Pipeline<number>()
      .send(2)
      .through([new Multiplier(3), new Multiplier(10)])
      .run((n) => n);

    expect(result).toBe(60);
  });

  it("supports mixing function pipes and object pipes in the same stack", async () => {
    class AddOne implements PipeObject<number, number> {
      async handle(n: number, next: Next<number, number>): Promise<number> {
        return next(n + 1);
      }
    }

    const result = await new Pipeline<number>()
      .send(0)
      .through([new AddOne(), (n, next) => next(n * 10), new AddOne()])
      .run((n) => n);

    expect(result).toBe(11);
  });

  it("pipe() appends a single pipe to the stack", async () => {
    const result = await new Pipeline<number>()
      .send(1)
      .pipe((n, next) => next(n + 1))
      .pipe((n, next) => next(n + 1))
      .run((n) => n);

    expect(result).toBe(3);
  });

  it("through() replaces any previously set pipe stack", async () => {
    const result = await new Pipeline<number>()
      .send(1)
      .pipe((n, next) => next(n + 100))
      .through([(n, next) => next(n + 1)])
      .run((n) => n);

    expect(result).toBe(2);
  });

  it("thenReturn() runs with an identity destination", async () => {
    const result = await new Pipeline<number>()
      .send(1)
      .through([(n, next) => next(n + 1)])
      .thenReturn();

    expect(result).toBe(2);
  });

  it("throws if run() is called without send()", async () => {
    await expect(
      new Pipeline<number>().through([(n, next) => next(n)]).run((n) => n),
    ).rejects.toThrow("Pipeline.send() must be called before run().");
  });

  it("is not a thenable — awaiting an instance never runs it", async () => {
    const ran: string[] = [];
    const pipeline = new Pipeline<number>().send(1).through([
      (n, next) => {
        ran.push("pipe");

        return next(n);
      },
    ]);

    // `await`ing the instance must not execute the pipes. If `Pipeline`
    // exposed a `then` method it would be treated as a thenable and run
    // here with `resolve` as the destination.
    const awaited = await pipeline;

    expect(ran).toEqual([]);
    expect(awaited).toBe(pipeline);
    expect((pipeline as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("a Hub factory that forgets to run the pipeline resolves to the bare pipeline, not a result", async () => {
    // Forgetting the terminal `.run()`/`.thenReturn()` must not hang
    // forever on an un-`send()`'d thenable; it simply yields the un-run
    // pipeline.
    const factory = (pipeline: Pipeline<number>, passable: number) =>
      pipeline.send(passable).through([(n, next) => next(n + 1)]) as unknown as number;

    const result = await factory(new Pipeline<number>(), 1);
    expect(result).toBeInstanceOf(Pipeline);
  });

  it("allows pipes to run async work before forwarding", async () => {
    const result = await new Pipeline<number>()
      .send(1)
      .through([
        async (n, next) => {
          await new Promise((resolve) => setTimeout(resolve, 1));

          return next(n + 1);
        },
      ])
      .run((n) => n);

    expect(result).toBe(2);
  });

  it("propagates a thrown error from a pipe, skipping remaining pipes and the destination", async () => {
    const destinationCalls: number[] = [];

    await expect(
      new Pipeline<number>()
        .send(1)
        .through([
          (_n, _next) => {
            throw new Error("boom");
          },
          (n, next) => next(n),
        ])
        .run((n) => {
          destinationCalls.push(n);

          return n;
        }),
    ).rejects.toThrow("boom");

    expect(destinationCalls).toEqual([]);
  });
});
