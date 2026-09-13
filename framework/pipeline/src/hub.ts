import { Pipeline } from "./pipeline.js";

/**
 * Callback that builds and runs a named pipeline. Receives a fresh
 * `Pipeline` plus the passable; typically `send`s the passable,
 * `through`s a pipe list, and `run`/`thenReturn`s.
 *
 *   hub.pipeline("ingest", (pipeline, payload) =>
 *     pipeline.send(payload).through([validate, transform]).thenReturn(),
 *   );
 */
export type PipelineFactory<TPassable, TResult = TPassable> = (
  pipeline: Pipeline<TPassable, TResult>,
  passable: TPassable,
) => Promise<TResult> | TResult;

/**
 * Named-pipeline registry, Laravel's `Illuminate\Pipeline\Hub`.
 *
 * Lets independently-named pipelines ("http middleware", "notification
 * formatting") be registered once and looked up by name, rather than
 * every call site constructing a `Pipeline` from scratch. No `__call`
 * magic. Pipelines are registered with `pipeline(name, callback)` and
 * invoked with `pipe(passable, name)`.
 */
export class Hub {
  private pipelines = new Map<string, PipelineFactory<any, any>>();

  /** Register (or replace) the `"default"` pipeline. */
  defaults<TPassable, TResult = TPassable>(callback: PipelineFactory<TPassable, TResult>): this {
    return this.pipeline("default", callback);
  }

  pipeline<TPassable, TResult = TPassable>(
    name: string,
    callback: PipelineFactory<TPassable, TResult>,
  ): this {
    this.pipelines.set(name, callback);

    return this;
  }

  /**
   * Run the named pipeline (default `"default"`) over `passable`.
   * The registered callback is responsible for `send`/`through`/`run`.
   */
  async pipe<TPassable, TResult = TPassable>(
    passable: TPassable,
    name = "default",
  ): Promise<TResult> {
    const factory = this.pipelines.get(name);

    if (!factory) {
      throw new Error(`Pipeline [${name}] is not registered on this Hub.`);
    }

    return factory(new Pipeline<TPassable, TResult>(), passable);
  }

  has(name: string): boolean {
    return this.pipelines.has(name);
  }
}
