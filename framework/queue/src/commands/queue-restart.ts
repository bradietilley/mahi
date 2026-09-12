import { Command } from "@mahiframework/cli";
import { signalRestart } from "../restart-signal.js";

/**
 * `queue:restart` — tell every running worker to stop after its current
 * job, so a supervisor can start replacements running the new code.
 *
 * Workers load their job classes once at boot, so a deploy leaves them
 * executing the *old* code until they are recycled. Signalling beats
 * killing: a worker stops between jobs rather than mid-job, so nothing is
 * interrupted and nothing is left reserved.
 *
 * Needs a cache store shared by the workers (Redis in a multi-host
 * deployment) — with the per-process array store nothing else can see the
 * signal, and this command says so rather than reporting a false success.
 */
export class QueueRestartCommand extends Command {
  signature = "queue:restart";
  description = "Tell running queue workers to stop after their current job.";

  async handle(): Promise<void> {
    if (!(await signalRestart(this.app))) {
      this.error(
        "No cache store is configured, so there is nowhere to record the restart signal. " +
          "Register CacheServiceProvider (and use a shared store such as redis) first.",
      );

      return;
    }

    this.info("Broadcasting queue restart signal.");
  }
}
