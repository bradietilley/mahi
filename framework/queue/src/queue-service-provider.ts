import { ServiceProvider } from "@mahi/core";
import { DatabaseManager, DATABASE_TOKEN, type RegisteredMigration } from "@mahi/database";
import createJobsTable from "./migrations/0001_create_jobs_table.js";
import queueReliability from "./migrations/0002_queue_reliability.js";
import { QueueManager, type QueueConfig } from "./queue-manager.js";
import { JobRegistry } from "./job-registry.js";
import { SyncQueueDriver } from "./drivers/sync-queue-driver.js";
import { DatabaseQueueDriver } from "./drivers/database-queue-driver.js";
import { FakeQueueDriver } from "./drivers/fake-queue-driver.js";
import { QueueWorkCommand } from "./commands/queue-work.js";
import { QueueFailedCommand } from "./commands/queue-failed.js";
import { QueueRetryCommand } from "./commands/queue-retry.js";
import { QueueForgetCommand } from "./commands/queue-forget.js";
import { QueueFlushCommand } from "./commands/queue-flush.js";
import { QueueRestartCommand } from "./commands/queue-restart.js";
import { QueueClearCommand } from "./commands/queue-clear.js";
import { EventDispatcher, EVENTS_TOKEN } from "@mahi/events";
import { MAIL_TOKEN, type MailManager } from "@mahi/mail";
import { HandleQueuedListener, QUEUED_LISTENER_JOB } from "./jobs/handle-queued-listener.js";
import { SendQueuedMail, QUEUED_MAIL_JOB } from "./jobs/send-queued-mail.js";
import { QUEUE_TOKEN, JOB_REGISTRY_TOKEN } from "./tokens.js";

export { QUEUE_TOKEN, JOB_REGISTRY_TOKEN };

/** `connections.database` in `config/queue.ts`. */
interface DatabaseQueueConnectionConfig {
  /** Which *database* connection holds the `jobs` table. The app's default when omitted. */
  connection?: string;
  /** The default named queue this connection pushes to and works. Default `"default"`. */
  queue?: string;
  /**
   * Seconds before a reserved job is presumed abandoned and reclaimed —
   * the crash-recovery window. Must exceed the longest a job can run.
   * Default 90.
   */
  retryAfter?: number;
  /** Candidate rows read per `pop()` on SQLite. Default 10. */
  popBatchSize?: number;
}

/**
 * Registers the QueueManager singleton with the two built-in connections
 * ("sync", "database") pre-registered via `extend()`, and a JobRegistry
 * singleton populated during boot from every provider's `jobs()` hook
 * (same collection pattern `EventsServiceProvider` uses for `listeners()`).
 *
 * Contributes the `jobs`/`failed_jobs` migration (`database` connection
 * only — unused if you never resolve that connection) and the `queue:work`
 * CLI command.
 *
 * List this provider after `DatabaseServiceProvider` in `config/app.ts`'s
 * `providers[]` — `DatabaseQueueDriver` resolves `DatabaseManager` from the
 * container. If `EventsServiceProvider` is also registered, this provider
 * installs the `listenQueued()` enqueue handler on `EventDispatcher` and
 * registers the built-in `events.handle-queued-listener` job.
 */
export class QueueServiceProvider extends ServiceProvider {
  private registry = new JobRegistry();

  register(): void {
    this.app.singleton(JOB_REGISTRY_TOKEN, () => this.registry);

    this.registry.register(QUEUED_LISTENER_JOB, HandleQueuedListener);
    this.registry.register(QUEUED_MAIL_JOB, SendQueuedMail);

    this.app.singleton(QUEUE_TOKEN, (app) => {
      const config = app.config.require<QueueConfig>("queue");
      const manager = new QueueManager(app, config);

      manager.extend("sync", () => new SyncQueueDriver(app, this.registry));
      manager.extend("database", () => {
        const db = app.make<DatabaseManager>(DATABASE_TOKEN);
        const settings = (manager.connectionConfig("database") ??
          {}) as DatabaseQueueConnectionConfig;
        // A named `connection` points the queue at a *database*
        // connection other than the default (a dedicated queue database);
        // omitted, it's the app's default, as before.
        const driver = db.driver(settings.connection);

        // The dialect (which selects the reservation strategy) is read
        // from the connection itself by the driver — see `dialectOf()`.
        return new DatabaseQueueDriver(driver.kysely, {
          queue: settings.queue ?? "default",
          retryAfterSeconds: settings.retryAfter ?? 90,
          ...(settings.popBatchSize !== undefined ? { popBatchSize: settings.popBatchSize } : {}),
          connectionName: "database",
        });
      });
      // Recording driver for tests — records pushes instead of running
      // them (see FakeQueueDriver). Registered here (not only in
      // @mahi/testing) so `QUEUE_CONNECTION=fake` works out of the
      // box, mirroring how "sync"/"database" are always available.
      manager.extend("fake", () => new FakeQueueDriver(this.registry));

      return manager;
    });
  }

  boot(): void {
    for (const provider of this.app.getProviders()) {
      const jobs = provider.jobs?.();

      if (!jobs) {
        continue;
      }

      for (const [name, jobClass] of Object.entries(jobs)) {
        this.registry.register(name, jobClass);
      }
    }

    if (this.app.has(EVENTS_TOKEN)) {
      const dispatcher = this.app.make<EventDispatcher>(EVENTS_TOKEN);
      dispatcher.useQueuedListenerHandler(async (payload) => {
        const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
        await manager.dispatch(new HandleQueuedListener(payload));
      });
    }

    // Same inversion as the events bridge above: `@mahi/mail` declares the
    // handler slot, this package fills it. Guarded on the token so an app
    // without mail registered is unaffected, and so neither package has to
    // care about the other's boot order.
    if (this.app.has(MAIL_TOKEN)) {
      const mail = this.app.make<MailManager>(MAIL_TOKEN);
      mail.useQueuedMailHandler(async (message, options) => {
        const manager = this.app.make<QueueManager>(QUEUE_TOKEN);
        await manager.dispatch(new SendQueuedMail(message, options.mailer), {
          ...(options.delaySeconds !== undefined ? { delaySeconds: options.delaySeconds } : {}),
          ...(options.connection !== undefined ? { connection: options.connection } : {}),
          ...(options.queue !== undefined ? { queue: options.queue } : {}),
        });
      });
    }
  }

  /**
   * Unbind the queued-mail handler, so a second `Application` in the same
   * process (a test building its own) doesn't inherit one pointing at a
   * terminated container.
   */
  shutdown(): void {
    if (this.app.has(MAIL_TOKEN)) {
      this.app.make<MailManager>(MAIL_TOKEN).useQueuedMailHandler(undefined);
    }
  }

  /**
   * Static rather than a `migrations()` directory path: a directory only
   * exists if this package is on a real filesystem, so a bundled app
   * would find no `jobs` table and get "Nothing to migrate" instead of an
   * error. The names must stay byte-identical to the filenames they
   * replace — apps migrated under the old directory form have those rows
   * in their `migrations` table already.
   */
  migrationSources(): RegisteredMigration[] {
    return [
      { name: "0001_create_jobs_table", migration: createJobsTable },
      { name: "0002_queue_reliability", migration: queueReliability },
    ];
  }

  commands() {
    return [
      QueueWorkCommand,
      QueueFailedCommand,
      QueueRetryCommand,
      QueueForgetCommand,
      QueueFlushCommand,
      QueueRestartCommand,
      QueueClearCommand,
    ];
  }
}
