import type { Command as CommanderCommand } from "commander";
import { Command, trap } from "@mahiframework/cli";
import { Schedule } from "../schedule.js";
import { SCHEDULE_TOKEN } from "../tokens.js";
import { runDueTasks } from "../run-due-tasks.js";

/** Global-timer sleep, so vi.useFakeTimers() can drive the loop in tests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Local-dev convenience: a foreground loop that evaluates the schedule
 * once per minute — an alternative to needing a real crontab entry while
 * developing. Runs until interrupted (Ctrl+C / SIGTERM). Unlike Laravel's
 * `schedule:work` there's no per-tick child process: Node has no
 * per-invocation state-isolation need, so tasks run directly in-process
 * via the same `runDueTasks()` path `schedule:run` uses.
 */
export class ScheduleWorkCommand extends Command {
  signature = "schedule:work";
  description =
    "Run the scheduler in the foreground, firing due tasks once a minute (dev convenience).";

  configure(program: CommanderCommand): void {
    program.option(
      "--once",
      "Evaluate the schedule a single time, then exit — mainly for tests/scripts",
    );
  }

  async handle(options: { once?: boolean } = {}): Promise<void> {
    const schedule = this.app.make<Schedule>(SCHEDULE_TOKEN);

    if (options.once) {
      await runDueTasks(this.app, schedule);

      return;
    }

    let running = true;
    const untrap = trap(["SIGINT", "SIGTERM"], () => {
      running = false;
    });

    this.app.logger.info(
      "schedule:work started — evaluating the schedule every minute. Press Ctrl+C to stop.",
    );

    // Every minute this loop has already dispatched, keyed by the minute's
    // start timestamp — so a run fires at most once per wall-clock minute
    // even though the poll ticks far more often, and (unlike keying off
    // `getMinutes()`) an hour-long stall can't make minute 30 look "new"
    // again and fire a second time.
    const dispatched = new Set<number>();
    // Every tick still in flight. The loop does NOT await these: a tick
    // whose tasks take 90 seconds must not swallow the minute after it,
    // which is exactly what awaiting `runDueTasks()` inline would do —
    // 60 tasks a minute silently become 40.
    const inFlight = new Set<Promise<void>>();

    try {
      while (running) {
        const now = new Date();
        const minute = Math.floor(now.getTime() / 60_000);

        if (!dispatched.has(minute)) {
          dispatched.add(minute);

          // Bounded to an hour of minutes: this process is long-lived, and
          // an unbounded Set is a slow leak.
          if (dispatched.size > 60) {
            for (const seen of dispatched) {
              if (seen < minute - 60) {
                dispatched.delete(seen);
              }
            }
          }

          const tick = runDueTasks(this.app, schedule, now)
            .catch((error: unknown) => {
              // runDueTasks() already swallows per-task failures; this
              // guards the loop against anything it doesn't.
              this.app.logger.error("schedule:work tick failed.", {
                error: (error as Error).message,
                stack: (error as Error).stack,
              });
            })
            .finally(() => {
              inFlight.delete(tick);
            });
          inFlight.add(tick);
        }

        // Poll frequently so shutdown is responsive and we don't miss a
        // minute boundary — mirrors Laravel's ~100ms tick.
        await sleep(1000);
      }
    } finally {
      untrap();
      // Let in-flight ticks finish before returning, so the process
      // doesn't exit with tasks half-run.
      await Promise.allSettled([...inFlight]);
    }
  }
}
