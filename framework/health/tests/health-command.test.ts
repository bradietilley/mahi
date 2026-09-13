import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "@mahiframework/core";
import { Tui, type FakeTuiHandle } from "@mahiframework/tui";
import { HealthCommand } from "../src/commands/health.js";
import { HealthRegistry } from "../src/health-registry.js";
import { HEALTH_TOKEN } from "../src/health-service-provider.js";
import type { HealthCheck } from "../src/health-check.js";

let tui: FakeTuiHandle;
let stdout: string[];
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  tui = Tui.fake();
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));

    return true;
  });
  // Saved and restored so a failing-report test can't leak a non-zero
  // exit code into the vitest run itself.
  originalExitCode = process.exitCode;
});

afterEach(() => {
  tui.restore();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

function appWith(...checks: HealthCheck[]): Application {
  const app = new Application();
  app.singleton(HEALTH_TOKEN, (resolved) => new HealthRegistry(resolved).register(...checks));

  return app;
}

/** A mixed report: one pass, one skip, one failure, across two groups. */
function mixedApp(): Application {
  return appWith(
    { name: "cache", group: "core", run: () => {} },
    { name: "filesystem", group: "core", run: () => null },
    { name: "stripe", run: () => "Failed to connect" },
  );
}

describe("./artisan health (table output)", () => {
  it("renders a row per check with its group and status", async () => {
    await new HealthCommand(mixedApp()).handle({});
    const output = tui.strippedOutput();

    expect(output).toContain("Group");
    expect(output).toContain("Check");
    expect(output).toContain("Status");
    expect(output).toMatch(/core\s*│\s*cache\s*│\s*✔ ok/);
    expect(output).toMatch(/core\s*│\s*filesystem\s*│\s*○ skipped/);
    expect(output).toMatch(/app\s*│\s*stripe\s*│\s*✘ Failed to connect/);
  });

  it("summarises the count, the failures, and the duration", async () => {
    await new HealthCommand(mixedApp()).handle({});

    expect(tui.strippedOutput()).toMatch(/3 checks, 1 failed \(\d+ms\)/);
  });

  it("summarises a fully healthy run without a failure count", async () => {
    await new HealthCommand(appWith({ name: "cache", group: "core", run: () => {} })).handle({});
    const output = tui.strippedOutput();

    expect(output).toMatch(/1 check, all passing \(\d+ms\)/);
    expect(output).not.toContain("failed");
  });

  it("shows the real failure message even in production", async () => {
    // The CLI runs inside the trust boundary; an operator SSH'd into the
    // box needs the actual driver error, not "Check failed".
    const app = appWith({ name: "db", run: () => "connect ECONNREFUSED 10.0.1.4:5432" });
    app.useEnvironment("production");

    await new HealthCommand(app).handle({});

    expect(tui.strippedOutput()).toContain("connect ECONNREFUSED 10.0.1.4:5432");
    expect(tui.strippedOutput()).not.toContain("Check failed");
  });

  it("says so when nothing is registered", async () => {
    await new HealthCommand(appWith()).handle({});

    expect(tui.strippedOutput()).toContain("No health checks registered.");
  });

  it("defaults to the table when no options are passed at all", async () => {
    await new HealthCommand(mixedApp()).handle();

    expect(tui.strippedOutput()).toContain("Group");
    expect(stdout).toHaveLength(0);
  });
});

describe("./artisan health --json", () => {
  it("emits exactly JSON.stringify(report.results)", async () => {
    await new HealthCommand(mixedApp()).handle({ json: true });

    expect(stdout.join("")).toBe(
      `${JSON.stringify({
        core: { cache: true, filesystem: null },
        app: { stripe: "Failed to connect" },
      })}\n`,
    );
  });

  it("emits the same payload the HTTP route serializes", async () => {
    const app = mixedApp();
    const report = await app.make<HealthRegistry>(HEALTH_TOKEN).run();

    await new HealthCommand(app).handle({ json: true });

    expect(JSON.parse(stdout.join(""))).toEqual(report.results);
  });

  it("is parseable and free of ANSI escape codes", async () => {
    await new HealthCommand(mixedApp()).handle({ json: true });
    const raw = stdout.join("");

    // `./artisan health --json | jq` must receive clean JSON.
    expect(raw).not.toMatch(/\u001b\[/);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("writes no table alongside the JSON", async () => {
    await new HealthCommand(mixedApp()).handle({ json: true });

    expect(tui.strippedOutput()).toBe("");
  });

  it("emits an empty object for an empty registry", async () => {
    await new HealthCommand(appWith()).handle({ json: true });

    expect(stdout.join("")).toBe("{}\n");
  });

  it("does not serialize durationMs", async () => {
    await new HealthCommand(mixedApp()).handle({ json: true });

    expect(stdout.join("")).not.toContain("durationMs");
  });
});

describe("exit code", () => {
  it("is left untouched when every check passes", async () => {
    process.exitCode = undefined;

    await new HealthCommand(appWith({ name: "a", run: () => {} })).handle({});

    expect(process.exitCode).toBeUndefined();
  });

  it("is left untouched when checks are only skipped", async () => {
    process.exitCode = undefined;

    await new HealthCommand(appWith({ name: "a", run: () => null })).handle({});

    expect(process.exitCode).toBeUndefined();
  });

  it("is set to 1 when any check fails", async () => {
    process.exitCode = undefined;

    await new HealthCommand(appWith({ name: "a", run: () => "down" })).handle({});

    expect(process.exitCode).toBe(1);
  });

  it("is set to 1 on a failing --json run too", async () => {
    process.exitCode = undefined;

    await new HealthCommand(appWith({ name: "a", run: () => "down" })).handle({ json: true });

    expect(process.exitCode).toBe(1);
  });

  it("does not call process.exit()", async () => {
    // `process.exit()` truncates in-flight stdout writes, on a --json
    // run that means truncated JSON, and would take the test runner
    // down with it.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await new HealthCommand(appWith({ name: "a", run: () => "down" })).handle({ json: true });

    expect(exit).not.toHaveBeenCalled();
  });
});

describe("command metadata", () => {
  it("is registered as `health`", () => {
    const command = new HealthCommand(new Application());

    expect(command.signature).toBe("health");
    expect(command.description).toBe("Run every registered health check.");
  });

  it("declares the --json flag", () => {
    const options: Array<[string, string]> = [];
    const program = {
      option(flag: string, description: string) {
        options.push([flag, description]);

        return this;
      },
    };

    new HealthCommand(new Application()).configure(program as never);

    expect(options).toEqual([["--json", "Output the raw JSON payload instead of a table."]]);
  });

  it("is not dev-only. It must exist in a compiled binary", () => {
    expect(HealthCommand.devOnly).toBe(false);
  });
});
