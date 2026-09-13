import type { QueueConfig } from "@mahiframework/queue";
import type { Env } from "./env.js";

export function queueConfig(env: Env): QueueConfig {
  return {
    default: env.QUEUE_CONNECTION,
    connections: {
      sync: {},
      database: {
        queue: "default",
        // Seconds before a reserved job is presumed abandoned and handed
        // to another worker. This is what makes a killed worker's job run
        // again instead of being stranded, but it MUST be longer than
        // the longest a job can legitimately take (including its own
        // `timeout()`), or a still-running job gets a second worker.
        retryAfter: 90,
        // Hold every dispatch until the enclosing DB transaction commits.
        // Recommended: it removes the whole class of "worker popped the
        // job before the row it references was committed" bug. Override
        // per dispatch with `Bus.dispatch(job, { afterCommit: false })`.
        afterCommit: true,
      },
      // Redis-backed queue (requires @mahiframework/redis), worth it for
      // throughput and for cross-process locks (`WithoutOverlapping`,
      // `RateLimited`), which the array/file cache stores cannot provide.
      redis: { queue: "default", retryAfter: 90 },
    },
  };
}
