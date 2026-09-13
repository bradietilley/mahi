import { Facade } from "@mahiframework/facades";
import type { DispatchOptions, QueueManager } from "./queue-manager.js";
import type { Job } from "./job.js";
import { QUEUE_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `QueueManager` singleton bound at `QUEUE_TOKEN`,
 * for call sites that would otherwise read
 * `app().make<QueueManager>(QUEUE_TOKEN).dispatch(...)`.
 *
 *   await Bus.dispatch(new WelcomePostAuthorJob(author, post));
 *
 * Jobs are dispatched by INSTANCE, the job carries its payload as its own
 * fields and `handle()` reads them off `this`. The job's class must be
 * registered (via a provider's `jobs()` hook) so a worker can reconstruct
 * it by name; see `QueueManager.dispatch()` and `JobRegistry`.
 *
 * Prefer constructor-injecting `QueueManager` (via `QUEUE_TOKEN`) where
 * that's practical (e.g. inside a `ServiceProvider`/`Command` that
 * already receives `app`), use this only at call sites where
 * threading `app`/`QueueManager` through is genuinely inconvenient, same
 * guidance as `app()` itself.
 */
export class Bus extends Facade<QueueManager>(() => QUEUE_TOKEN) {
  /**
   * Dispatch a job instance. Resolves to `true` when the job was
   * enqueued, or `false` when a `ShouldBeUnique` duplicate was silently
   * dropped because an identical job is already queued (or running). Every
   * non-unique dispatch resolves `true`.
   */
  static dispatch(job: Job, options?: DispatchOptions): Promise<boolean> {
    return this.instance().dispatch(job, options);
  }

  /**
   * Dispatch an ordered chain of job instances. Each runs only after the
   * previous one succeeds. See `QueueManager.chain()`.
   *
   *   await Bus.chain([
   *     new ChargeOrderJob(order),
   *     new ShipOrderJob(order),
   *   ]);
   */
  static chain(jobs: Job[], options?: Omit<DispatchOptions, "chain">): Promise<void> {
    return this.instance().chain(jobs, options);
  }
}
