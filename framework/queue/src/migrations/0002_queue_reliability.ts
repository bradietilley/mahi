import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * Brings the `jobs`/`failed_jobs` tables up to what a crash-safe,
 * multi-worker queue needs. A separate migration rather than an edit to
 * `0001_create_jobs_table` because that name is already recorded in every
 * existing app's `migrations` table, editing it would change nothing on
 * any database that has run it.
 *
 * **`jobs.queue`**, named queues. One table, many logical queues, so
 * `queue:work --queue emails` drains only what it should instead of
 * every worker fighting over one list. Defaults to `"default"`, which is
 * exactly what pre-existing rows should be treated as.
 *
 * **`jobs (queue, available_at, id)`**, the index `pop()` lives on, and
 * its column order matters twice over.
 *
 * It keeps the hottest query in the system (every poll of every worker)
 * off a full table scan. But it also has to **match `pop()`'s ORDER BY**
 * (`available_at`, then `id`), and that part is about correctness, not
 * speed: on MySQL, a `... ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED`
 * that needs a filesort locks *every row it sorts*, so a second worker
 * running the same query skips all of them and gets nothing. Three
 * workers polling a three-job queue would come back with one job between
 * them. Satisfying the sort from the index removes the filesort, and with
 * it the false contention.
 *
 * `reserved_at` is deliberately **not** in the index. It appears in the
 * predicate only inside an `OR` (`IS NULL OR <= cutoff`), which no B-tree
 * can range-scan anyway, and putting it ahead of `available_at` is what
 * forced the filesort in the first place.
 *
 * **`failed_jobs.connection` / `.queue`**, where the job came from, so
 * `queue:retry` puts it back there instead of onto the default queue of
 * the default connection.
 *
 * **`failed_jobs.chain_json`**, the chain the job was carrying. Without
 * it a retried job runs alone and every link queued behind it is silently
 * dropped, which is the kind of bug you find in production a week later.
 *
 * **`failed_jobs (failed_at)`**, `queue:failed` orders by it and
 * `queue:flush --hours` prunes by it.
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.table("jobs", (table: Blueprint) => {
      // Non-nullable with a default: existing rows become "default"
      // queue rows, which is what they have always effectively been.
      table.string("queue").default("default");
    });

    await Schema.table("jobs", (table: Blueprint) => {
      table.index(["queue", "available_at", "id"]);
    });

    await Schema.table("failed_jobs", (table: Blueprint) => {
      table.string("connection").nullable();
      table.string("queue").nullable();
      table.text("chain_json").nullable();
    });

    await Schema.table("failed_jobs", (table: Blueprint) => {
      table.index(["failed_at"]);
    });
  },

  async down(): Promise<void> {
    await Schema.table("failed_jobs", (table: Blueprint) => {
      table.dropIndex(["failed_at"]);
      table.dropColumn("connection", "queue", "chain_json");
    });

    await Schema.table("jobs", (table: Blueprint) => {
      table.dropIndex(["queue", "available_at", "id"]);
      table.dropColumn("queue");
    });
  },
};

export default migration;
