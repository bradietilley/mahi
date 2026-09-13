/**
 * Continuation passed to each pipe, call it with the (possibly modified)
 * passable to hand off to the next pipe in the stack, or to the pipeline's
 * `destination` once every pipe has run. A pipe isn't required to call
 * `next` at all: returning its own `TResult` directly short-circuits the
 * rest of the stack, exactly like Laravel's `Pipeline`.
 */
export type Next<TPassable, TResult> = (passable: TPassable) => Promise<TResult> | TResult;

/**
 * A single pipeline stage, as a plain function.
 *
 *   const pipe: PipeFn<Request, Response> = async (req, next) => {
 *     const res = await next(req);         // carry on
 *     res.headers.set("X-Traced", "1");    // post-process on the way back
 *     return res;
 *   };
 */
export type PipeFn<TPassable, TResult> = (
  passable: TPassable,
  next: Next<TPassable, TResult>,
) => Promise<TResult> | TResult;

/**
 * A single pipeline stage, as an object/class instance exposing `handle()`,
 * the class-based equivalent of `PipeFn`, for stateful or DI-constructed
 * pipes (Laravel's class-based pipes, minus container string-name
 * resolution, construct the instance yourself and pass it to `through()`).
 *
 *   class Logger implements PipeObject<Request, Response> {
 *     async handle(req: Request, next: Next<Request, Response>) {
 *       console.log(req.url);
 *       return next(req);
 *     }
 *   }
 */
export interface PipeObject<TPassable, TResult> {
  handle: PipeFn<TPassable, TResult>;
}

export type Pipe<TPassable, TResult = TPassable> =
  PipeFn<TPassable, TResult> | PipeObject<TPassable, TResult>;

function isPipeObject<TPassable, TResult>(
  pipe: Pipe<TPassable, TResult>,
): pipe is PipeObject<TPassable, TResult> {
  return typeof pipe === "object" && pipe !== null && typeof pipe.handle === "function";
}

/**
 * Laravel's `Pipeline`, sends a value (`passable`) through an ordered
 * list of pipes, each shaped `(passable, next) => result`. A pipe may:
 *
 * - call `next(passable)` (optionally with a modified passable) to carry
 *   on to the next pipe, or
 * - return its own `TResult` directly, without calling `next`, to
 *   short-circuit the remaining pipes entirely.
 *
 * The chain is built right-to-left so each pipe's `next` closes over the
 * pipe after it, terminating in `destination` (the value passed to
 * `run()`) once every pipe has forwarded.
 *
 *   const result = await new Pipeline<Request, Response>()
 *     .send(request)
 *     .through([authenticate, throttle, logRequest])
 *     .run((req) => handleRequest(req));
 *
 * NOTE: the terminal method is `run()`, **not** `then()`. A `then()` method
 * would make `Pipeline` a thenable, `await`ing an instance (or returning
 * one from an async function) would silently execute it with `resolve` as
 * the destination, and an un-`send()`'d pipeline would hang forever. Keep
 * `then` off this class.
 *
 * Framework-agnostic and has no knowledge of HTTP, `@mahiframework/http`
 * builds a Hono-specific adapter on top of this for request middleware
 * (see `HttpKernel`'s global pipeline / the `middleware()` provider hook).
 */
export class Pipeline<TPassable, TResult = TPassable> {
  private passable?: TPassable;
  private hasPassable = false;
  private pipes: Array<Pipe<TPassable, TResult>> = [];

  /** The value to send through the pipeline. Must be called before `run()`. */
  send(passable: TPassable): this {
    this.passable = passable;
    this.hasPassable = true;

    return this;
  }

  /** Replaces the pipe stack wholesale, in the order they should run. */
  through(pipes: Array<Pipe<TPassable, TResult>>): this {
    this.pipes = [...pipes];

    return this;
  }

  /** Appends a single pipe to the end of the stack. */
  pipe(pipe: Pipe<TPassable, TResult>): this {
    this.pipes.push(pipe);

    return this;
  }

  /**
   * Runs the pipeline: `passable` flows through every pipe in order,
   * finally reaching `destination` if every pipe called `next()`. Any
   * pipe returning without calling `next()` short-circuits, `destination`
   * (and every pipe after it) never runs.
   *
   * Deliberately named `run` rather than `then`: a `then` method would make
   * `Pipeline` a thenable, so `await pipeline` would run it implicitly.
   */
  async run(destination: (passable: TPassable) => Promise<TResult> | TResult): Promise<TResult> {
    if (!this.hasPassable) {
      throw new Error("Pipeline.send() must be called before run().");
    }

    const stack = this.pipes.reduceRight<Next<TPassable, TResult>>(
      (next, pipe) => (passable: TPassable) => {
        const fn = isPipeObject(pipe) ? pipe.handle.bind(pipe) : pipe;

        return fn(passable, next);
      },
      (passable: TPassable) => destination(passable),
    );

    return stack(this.passable as TPassable);
  }

  /**
   * Convenience for pipelines whose `TResult` is the same shape as
   * `TPassable` (e.g. pipes that only ever transform-and-forward, never
   * short-circuit with an unrelated result type), runs with an identity
   * destination.
   */
  async thenReturn(): Promise<TResult> {
    return this.run((passable) => passable as unknown as TResult);
  }
}
