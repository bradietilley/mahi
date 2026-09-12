import { Command } from "@mahiframework/cli";
import { Tui, colors } from "@mahiframework/tui";
import type { Command as CommanderCommand } from "commander";
import type { HealthRegistry } from "../health-registry.js";
import type { CheckOutcome, HealthReport } from "../health-check.js";
import { HEALTH_TOKEN } from "../health-service-provider.js";

/**
 * `./artisan health` — runs every registered check and reports.
 *
 * Table by default, matching every other diagnostic command in the
 * framework (`route:list`, `schedule:list`, `migrate:status`, `db:show`).
 * `--json` emits **exactly** the HTTP payload — the same `report.results`
 * object, serialized the same way — so CI and the load balancer are
 * looking at the same bytes.
 *
 * The CLI **never redacts** failure messages, unlike the HTTP route. It
 * runs inside the trust boundary, and an operator who has SSH'd into the
 * box to find out what's wrong needs the real message.
 */
export class HealthCommand extends Command {
  signature = "health";
  description = "Run every registered health check.";

  configure(program: CommanderCommand): void {
    program.option("--json", "Output the raw JSON payload instead of a table.");
  }

  async handle(options: { json?: boolean } = {}): Promise<void> {
    const report = await this.app.make<HealthRegistry>(HEALTH_TOKEN).run();

    if (options.json) {
      // `process.stdout.write`, not `Tui.note`/`Tui.info`: those add
      // formatting and may add color, and `./artisan health --json | jq`
      // must receive parseable JSON. `test`/`serve` set the precedent for
      // a command bypassing Tui when the output is machine-destined.
      process.stdout.write(`${JSON.stringify(report.results)}\n`);
    } else {
      renderTable(report);
    }

    // `process.exitCode`, never `process.exit(1)`: the latter truncates
    // in-flight stdout writes — which on a `--json` run means truncated
    // JSON — and would take the vitest runner down with it in this
    // package's own tests.
    if (!report.healthy) {
      process.exitCode = 1;
    }
  }
}

function renderTable(report: HealthReport): void {
  const rows: string[][] = [];
  let failed = 0;
  let total = 0;

  for (const [group, checks] of Object.entries(report.results)) {
    for (const [name, outcome] of Object.entries(checks)) {
      total += 1;

      if (typeof outcome === "string") {
        failed += 1;
      }

      rows.push([colors.gray(group), name, formatOutcome(outcome)]);
    }
  }

  if (total === 0) {
    Tui.info("No health checks registered.");

    return;
  }

  Tui.table(["Group", "Check", "Status"], rows);
  Tui.note(summary(total, failed, report.durationMs));
}

function formatOutcome(outcome: CheckOutcome): string {
  if (outcome === true) {
    return colors.green("\u2714 ok");
  }

  if (outcome === null) {
    return colors.gray("\u25cb skipped");
  }

  return colors.red(`\u2718 ${outcome}`);
}

function summary(total: number, failed: number, durationMs: number): string {
  const checks = `${total} ${total === 1 ? "check" : "checks"}`;
  const duration = colors.gray(`(${durationMs}ms)`);

  if (failed === 0) {
    return `${checks}, ${colors.green("all passing")} ${duration}`;
  }

  return `${checks}, ${colors.red(`${failed} failed`)} ${duration}`;
}
