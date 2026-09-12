import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { Tui } from "@mahiframework/tui";
import { QueueManager } from "../../src/queue-manager.js";
import { QueueClearCommand } from "../../src/commands/queue-clear.js";
import { QueueFlushCommand } from "../../src/commands/queue-flush.js";
import { QUEUE_TOKEN } from "../../src/tokens.js";
import type { QueueDriver } from "../../src/queue-driver.js";

/**
 * `queue:clear` deletes pending jobs outright — they are gone, not failed,
 * so nothing records that they existed. `queue:flush` empties
 * `failed_jobs`, which is the forensic record you read *after* an incident.
 * Both are unrecoverable in production.
 *
 * `queue:clear` in particular used to roll its own confirmation with no
 * options, which defaulted to YES; since a prompt with no TTY resolves to
 * its default rather than blocking, an unattended production run deleted
 * every pending job silently and exited 0.
 */
describe("destructive queue commands are guarded in production", () => {
  let cleared: number;
  let flushed: number;

  /** Minimal driver implementing both optional capabilities. */
  function makeDriver(): QueueDriver {
    return {
      async push() {},
      async pop() {
        return undefined;
      },
      async release() {},
      async delete() {},
      async fail() {},
      async size() {
        return 7;
      },
      async clear() {
        cleared += 7;

        return 7;
      },
      async flush() {
        flushed += 3;

        return 3;
      },
      async listFailed() {
        return [];
      },
      async findFailed() {
        return undefined;
      },
      async forget() {
        return true;
      },
    } as unknown as QueueDriver;
  }

  function buildApp(env: string): Application {
    const app = new Application();
    app.useEnvironment(env);

    const manager = new QueueManager(app, { default: "d", connections: { d: {} } });
    manager.extend("d", () => makeDriver());
    app.instance(QUEUE_TOKEN, manager);
    setCurrentApp(app);

    return app;
  }

  function setTTY(value: boolean) {
    Tui.interactive(value);
  }

  beforeEach(() => {
    cleared = 0;
    flushed = 0;
  });

  afterEach(() => {
    clearCurrentApp();
    vi.restoreAllMocks();
    Tui.clearInteractive();
    process.exitCode = undefined;
  });

  describe("queue:clear", () => {
    it("deletes nothing unattended in production, and fails the pipeline", async () => {
      const app = buildApp("production");
      setTTY(false);

      await new QueueClearCommand(app).handle({});

      expect(cleared).toBe(0);
      expect(process.exitCode).toBe(1);
    });

    it("proceeds unattended with --force", async () => {
      const app = buildApp("production");
      setTTY(false);

      await new QueueClearCommand(app).handle({ force: true });

      expect(cleared).toBe(7);
      expect(process.exitCode).toBeUndefined();
    });

    it("defaults the production prompt to no", async () => {
      // The inverted default was the original bug: `confirm()` with no
      // options defaults to YES.
      const app = buildApp("production");
      setTTY(true);
      const confirm = vi.spyOn(Tui, "confirm").mockResolvedValue(false);

      await new QueueClearCommand(app).handle({});

      expect(confirm).toHaveBeenCalledWith(expect.any(String), { default: false });
      expect(cleared).toBe(0);
    });

    it("clears when the operator confirms", async () => {
      const app = buildApp("production");
      setTTY(true);
      vi.spyOn(Tui, "confirm").mockResolvedValue(true);

      await new QueueClearCommand(app).handle({});

      expect(cleared).toBe(7);
    });

    it("does not prompt outside production", async () => {
      const app = buildApp("local");
      setTTY(true);
      const confirm = vi.spyOn(Tui, "confirm");

      await new QueueClearCommand(app).handle({});

      expect(confirm).not.toHaveBeenCalled();
      expect(cleared).toBe(7);
    });
  });

  describe("queue:flush", () => {
    it("deletes nothing unattended in production, and fails the pipeline", async () => {
      const app = buildApp("production");
      setTTY(false);

      await new QueueFlushCommand(app).handle({});

      expect(flushed).toBe(0);
      expect(process.exitCode).toBe(1);
    });

    it("proceeds unattended with --force", async () => {
      const app = buildApp("production");
      setTTY(false);

      await new QueueFlushCommand(app).handle({ force: true });

      expect(flushed).toBe(3);
    });

    it("guards the --hours form too", async () => {
      // Narrowing the range does not make it non-destructive.
      const app = buildApp("production");
      setTTY(false);

      await new QueueFlushCommand(app).handle({ hours: "24" });

      expect(flushed).toBe(0);
    });

    it("rejects a bad --hours before prompting", async () => {
      // A typo should fail fast, not ask the operator to confirm a run
      // that was never going to work.
      const app = buildApp("production");
      setTTY(true);
      const confirm = vi.spyOn(Tui, "confirm");

      await new QueueFlushCommand(app).handle({ hours: "not-a-number" });

      expect(confirm).not.toHaveBeenCalled();
      expect(flushed).toBe(0);
    });

    it("does not prompt outside production", async () => {
      const app = buildApp("local");
      setTTY(true);
      const confirm = vi.spyOn(Tui, "confirm");

      await new QueueFlushCommand(app).handle({});

      expect(confirm).not.toHaveBeenCalled();
      expect(flushed).toBe(3);
    });
  });
});
