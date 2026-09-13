import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Application } from "@mahiframework/core";
import { Http } from "@mahiframework/http-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTask, formatNextRun } from "../src/scheduled-task.js";

describe("ScheduledTask", () => {
  it("everyMinute() produces '* * * * *'", () => {
    expect(new ScheduledTask(() => {}).everyMinute().getCronExpression()).toBe("* * * * *");
  });

  it("everyFiveMinutes() produces '*/5 * * * *'", () => {
    expect(new ScheduledTask(() => {}).everyFiveMinutes().getCronExpression()).toBe("*/5 * * * *");
  });

  it("everyTwoMinutes()/everyThreeMinutes()/everyFourMinutes() produce the right steps", () => {
    expect(new ScheduledTask(() => {}).everyTwoMinutes().getCronExpression()).toBe("*/2 * * * *");
    expect(new ScheduledTask(() => {}).everyThreeMinutes().getCronExpression()).toBe("*/3 * * * *");
    expect(new ScheduledTask(() => {}).everyFourMinutes().getCronExpression()).toBe("*/4 * * * *");
  });

  it("everyThirtyMinutes() produces '*/30 * * * *'", () => {
    expect(new ScheduledTask(() => {}).everyThirtyMinutes().getCronExpression()).toBe(
      "*/30 * * * *",
    );
  });

  it("hourlyAt(offset) sets the minute field to the offset", () => {
    expect(new ScheduledTask(() => {}).hourlyAt(15).getCronExpression()).toBe("15 * * * *");
  });

  it("hourlyAt() rejects out-of-range offsets", () => {
    expect(() => new ScheduledTask(() => {}).hourlyAt(60)).toThrow();
    expect(() => new ScheduledTask(() => {}).hourlyAt(-1)).toThrow();
  });

  it("everyTwoHours()/everyThreeHours()/everyFourHours()/everySixHours() step the hour at minute 0", () => {
    expect(new ScheduledTask(() => {}).everyTwoHours().getCronExpression()).toBe("0 */2 * * *");
    expect(new ScheduledTask(() => {}).everyThreeHours().getCronExpression()).toBe("0 */3 * * *");
    expect(new ScheduledTask(() => {}).everyFourHours().getCronExpression()).toBe("0 */4 * * *");
    expect(new ScheduledTask(() => {}).everySixHours().getCronExpression()).toBe("0 */6 * * *");
  });

  it("hourly() produces '0 * * * *'", () => {
    expect(new ScheduledTask(() => {}).hourly().getCronExpression()).toBe("0 * * * *");
  });

  it("daily() produces '0 0 * * *'", () => {
    expect(new ScheduledTask(() => {}).daily().getCronExpression()).toBe("0 0 * * *");
  });

  it("weekly() produces '0 0 * * 0'", () => {
    expect(new ScheduledTask(() => {}).weekly().getCronExpression()).toBe("0 0 * * 0");
  });

  it("dailyAt('13:30') produces '30 13 * * *'", () => {
    expect(new ScheduledTask(() => {}).dailyAt("13:30").getCronExpression()).toBe("30 13 * * *");
  });

  it("at() is an alias for dailyAt()", () => {
    expect(new ScheduledTask(() => {}).at("06:15").getCronExpression()).toBe("15 6 * * *");
  });

  it("dailyAt() throws on a malformed time string", () => {
    expect(() => new ScheduledTask(() => {}).dailyAt("nope")).toThrow();
  });

  it("dailyAt() throws on out-of-range hour/minute", () => {
    expect(() => new ScheduledTask(() => {}).dailyAt("24:00")).toThrow();
    expect(() => new ScheduledTask(() => {}).dailyAt("12:60")).toThrow();
  });

  it("named day-of-week helpers set the day-of-week field", () => {
    expect(new ScheduledTask(() => {}).mondays().getCronExpression()).toBe("* * * * 1");
    expect(new ScheduledTask(() => {}).tuesdays().getCronExpression()).toBe("* * * * 2");
    expect(new ScheduledTask(() => {}).wednesdays().getCronExpression()).toBe("* * * * 3");
    expect(new ScheduledTask(() => {}).thursdays().getCronExpression()).toBe("* * * * 4");
    expect(new ScheduledTask(() => {}).fridays().getCronExpression()).toBe("* * * * 5");
    expect(new ScheduledTask(() => {}).saturdays().getCronExpression()).toBe("* * * * 6");
    expect(new ScheduledTask(() => {}).sundays().getCronExpression()).toBe("* * * * 0");
  });

  it("weekdays()/weekends() constrain to the right day sets", () => {
    expect(new ScheduledTask(() => {}).weekdays().getCronExpression()).toBe("* * * * 1,2,3,4,5");
    expect(new ScheduledTask(() => {}).weekends().getCronExpression()).toBe("* * * * 0,6");
  });

  it("day helpers compose with a time helper without disturbing other fields", () => {
    expect(new ScheduledTask(() => {}).dailyAt("9:00").weekdays().getCronExpression()).toBe(
      "0 9 * * 1,2,3,4,5",
    );
  });

  it("weeklyOn(day, time) sets day-of-week plus time", () => {
    expect(new ScheduledTask(() => {}).weeklyOn(1, "8:30").getCronExpression()).toBe("30 8 * * 1");
  });

  it("weeklyOn() defaults to midnight and rejects bad days", () => {
    expect(new ScheduledTask(() => {}).weeklyOn(5).getCronExpression()).toBe("0 0 * * 5");
    expect(() => new ScheduledTask(() => {}).weeklyOn(7)).toThrow();
  });

  it("monthly()/monthlyOn() set day-of-month", () => {
    expect(new ScheduledTask(() => {}).monthly().getCronExpression()).toBe("0 0 1 * *");
    expect(new ScheduledTask(() => {}).monthlyOn(15, "12:00").getCronExpression()).toBe(
      "0 12 15 * *",
    );
  });

  it("monthlyOn() rejects out-of-range days", () => {
    expect(() => new ScheduledTask(() => {}).monthlyOn(0)).toThrow();
    expect(() => new ScheduledTask(() => {}).monthlyOn(32)).toThrow();
  });

  it("lastDayOfMonth() uses the cron 'L' token in the day-of-month field", () => {
    expect(new ScheduledTask(() => {}).lastDayOfMonth().getCronExpression()).toBe("0 0 L * *");
    expect(new ScheduledTask(() => {}).lastDayOfMonth("23:59").getCronExpression()).toBe(
      "59 23 L * *",
    );
  });

  it("lastDayOfMonth() is due only on the calendar's final day", () => {
    const task = new ScheduledTask(() => {}).lastDayOfMonth();
    // February 2026 has 28 days.
    expect(task.isDueAt(new Date(2026, 1, 28, 0, 0))).toBe(true);
    expect(task.isDueAt(new Date(2026, 1, 27, 0, 0))).toBe(false);
    // January has 31.
    expect(task.isDueAt(new Date(2026, 0, 31, 0, 0))).toBe(true);
    expect(task.isDueAt(new Date(2026, 0, 30, 0, 0))).toBe(false);
  });

  it("isDueAt() reflects the configured cron expression at boundary times", () => {
    const task = new ScheduledTask(() => {}).daily();
    expect(task.isDueAt(new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(task.isDueAt(new Date(2026, 0, 1, 0, 1))).toBe(false);
    expect(task.isDueAt(new Date(2026, 0, 1, 12, 0))).toBe(false);
  });

  it("withDescription() is reflected in getDescription()", () => {
    const task = new ScheduledTask(() => {}).withDescription("prune-old-todos");
    expect(task.getDescription()).toBe("prune-old-todos");
  });

  it("getDescription() falls back to the cron expression when no description is set", () => {
    const task = new ScheduledTask(() => {}).hourly();
    expect(task.getDescription()).toBe("0 * * * *");
  });

  it("name() is reflected in getName() and getDescription()", () => {
    const task = new ScheduledTask(() => {}).name("prune-old-todos");
    expect(task.getName()).toBe("prune-old-todos");
    expect(task.getDescription()).toBe("prune-old-todos");
  });

  it("name() rejects an empty or blank name", () => {
    expect(() => new ScheduledTask(() => {}).name("")).toThrow();
    expect(() => new ScheduledTask(() => {}).name("   ")).toThrow();
  });

  it("getName() is undefined when no name was set, no cron fallback", () => {
    expect(new ScheduledTask(() => {}).hourly().getName()).toBeUndefined();
  });

  describe("withoutOverlapping()", () => {
    it("derives its key from the name", () => {
      const task = new ScheduledTask(() => {}).name("my-task").withoutOverlapping();
      expect(task.getOverlapKey()).toContain("my-task");
    });

    it("getOverlapKey() is undefined until withoutOverlapping() is called", () => {
      const task = new ScheduledTask(() => {});
      expect(task.getOverlapKey()).toBeUndefined();
    });

    it("resolves the key lazily, so chain order does not matter", () => {
      const before = new ScheduledTask(() => {}).withoutOverlapping().name("my-task");
      const after = new ScheduledTask(() => {}).name("my-task").withoutOverlapping();
      expect(before.getOverlapKey()).toBe(after.getOverlapKey());
    });

    it("a later frequency helper does not change the key of a named task", () => {
      const task = new ScheduledTask(() => {}).name("my-task").withoutOverlapping();
      const key = task.getOverlapKey();
      task.daily();
      expect(task.getOverlapKey()).toBe(key);
    });

    it("two differently-named tasks on the same schedule get different keys", () => {
      const a = new ScheduledTask(() => {}).everyMinute().name("a").withoutOverlapping();
      const b = new ScheduledTask(() => {}).everyMinute().name("b").withoutOverlapping();
      expect(a.getOverlapKey()).not.toBe(b.getOverlapKey());
    });

    it("defaults to a 60 minute expiry, and accepts an explicit one", () => {
      expect(new ScheduledTask(() => {}).withoutOverlapping().getOverlapExpiryMinutes()).toBe(60);
      expect(new ScheduledTask(() => {}).withoutOverlapping(5).getOverlapExpiryMinutes()).toBe(5);
    });

    it("rejects a non-positive expiry", () => {
      expect(() => new ScheduledTask(() => {}).withoutOverlapping(0)).toThrow();
      expect(() => new ScheduledTask(() => {}).withoutOverlapping(-1)).toThrow();
      expect(() => new ScheduledTask(() => {}).withoutOverlapping(Number.NaN)).toThrow();
    });

    it("preventsOverlaps() reports whether it was called", () => {
      expect(new ScheduledTask(() => {}).preventsOverlaps()).toBe(false);
      expect(new ScheduledTask(() => {}).withoutOverlapping().preventsOverlaps()).toBe(true);
    });
  });

  describe("runInBackground()", () => {
    it("is off by default and on once called", () => {
      expect(new ScheduledTask(() => {}).runsInBackground()).toBe(false);
      expect(new ScheduledTask(() => {}).runInBackground().runsInBackground()).toBe(true);
    });
  });

  describe("cron() validation", () => {
    it("throws at registration for an out-of-range field", () => {
      expect(() => new ScheduledTask(() => {}).cron("99 * * * *")).toThrow(/minute field/);
    });

    it("throws at registration for an unknown name", () => {
      expect(() => new ScheduledTask(() => {}).cron("0 0 * * NOPE")).toThrow(/day-of-week field/);
    });

    it("accepts names, and reports them in the expression", () => {
      const task = new ScheduledTask(() => {}).cron("0 0 * * MON");
      expect(task.getCronExpression()).toBe("0 0 * * MON");
      expect(task.isDueAt(new Date(2026, 0, 5, 0, 0))).toBe(true); // Monday
    });

    it("expands an @shorthand into the equivalent five fields", () => {
      expect(new ScheduledTask(() => {}).cron("@daily").getCronExpression()).toBe("0 0 * * *");
      expect(new ScheduledTask(() => {}).cron("@hourly").getCronExpression()).toBe("0 * * * *");
    });

    it("normalises surrounding and repeated whitespace", () => {
      expect(new ScheduledTask(() => {}).cron("  0   0  *  * *  ").getCronExpression()).toBe(
        "0 0 * * *",
      );
    });

    it("isDueAt() never throws for an expression that got past cron()", () => {
      const task = new ScheduledTask(() => {}).cron("0 0 * * 7");
      expect(() => task.isDueAt(new Date())).not.toThrow();
      expect(task.isDueAt(new Date(2026, 0, 4, 0, 0))).toBe(true); // Sunday
    });
  });

  it("run() invokes the callback with the given Application", async () => {
    const app = new Application();
    let received: Application | undefined;
    const task = new ScheduledTask((a) => {
      received = a;
    });

    await task.run(app);

    expect(received).toBe(app);
  });

  it("nextRunAt() finds the next matching minute in the future", () => {
    const task = new ScheduledTask(() => {}).cron("0 0 * * *"); // midnight daily
    const from = new Date(2026, 0, 1, 10, 0);
    const next = task.nextRunAt(from);
    expect(next?.getDate()).toBe(2);
    expect(next?.getHours()).toBe(0);
    expect(next?.getMinutes()).toBe(0);
  });

  it("nextRunAt() resolves in the task's own timezone", () => {
    const task = new ScheduledTask(() => {}).dailyAt("9:00").timezone("America/New_York");
    const next = task.nextRunAt(new Date(Date.UTC(2026, 0, 1, 0, 0)));
    // 09:00 New York on 2026-01-01 is 14:00 UTC.
    expect(next?.toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });

  it("formatNextRun() formats a date as 'YYYY-MM-DD HH:MM'", () => {
    expect(formatNextRun(new Date(2026, 0, 2, 0, 5))).toBe("2026-01-02 00:05");
  });

  it("formatNextRun() renders in the given timezone", () => {
    const noonUtc = new Date(Date.UTC(2026, 0, 1, 12, 0));
    expect(formatNextRun(noonUtc, "UTC")).toBe("2026-01-01 12:00");
    expect(formatNextRun(noonUtc, "America/New_York")).toBe("2026-01-01 07:00");
  });

  it("formatNextRun() returns 'unknown' for undefined", () => {
    expect(formatNextRun(undefined)).toBe("unknown");
    expect(formatNextRun(undefined, "UTC")).toBe("unknown");
  });

  describe("when()/skip() filters", () => {
    it("filtersPass() is true with no filters", async () => {
      const task = new ScheduledTask(() => {});
      expect(await task.filtersPass(new Application())).toBe(true);
    });

    it("when() must all pass (AND)", async () => {
      const app = new Application();
      const task = new ScheduledTask(() => {}).when(() => true).when(() => false);
      expect(await task.filtersPass(app)).toBe(false);
    });

    it("when() passing lets the task run", async () => {
      const app = new Application();
      const task = new ScheduledTask(() => {}).when(() => true);
      expect(await task.filtersPass(app)).toBe(true);
    });

    it("skip() rejects when any returns truthy (OR)", async () => {
      const app = new Application();
      const task = new ScheduledTask(() => {}).skip(() => false).skip(() => true);
      expect(await task.filtersPass(app)).toBe(false);
    });

    it("async filters are awaited", async () => {
      const app = new Application();
      const task = new ScheduledTask(() => {}).when(async () => false);
      expect(await task.filtersPass(app)).toBe(false);
    });

    it("filters receive the application", async () => {
      const app = new Application();
      let received: Application | undefined;
      const task = new ScheduledTask(() => {}).when((a) => {
        received = a;

        return true;
      });
      await task.filtersPass(app);
      expect(received).toBe(app);
    });
  });

  describe("webhook pings", () => {
    // Pings go through @mahiframework/http-client, so these assert with Http.fake()
    // rather than monkey-patching globalThis.fetch. Which is exactly what
    // that package exists for.
    afterEach(() => {
      Http.restore();
    });

    it("pingBefore()/thenPing()/pingOnSuccess() fire on a successful run", async () => {
      Http.fake();

      const task = new ScheduledTask(() => {})
        .pingBefore("https://example.test/before")
        .thenPing("https://example.test/after")
        .pingOnSuccess("https://example.test/success");

      await task.run(new Application());

      Http.assertSent("example.test/before");
      Http.assertSent("example.test/success");
      Http.assertSent("example.test/after");
    });

    it("pingOnFailure() and thenPing() fire when the task throws", async () => {
      Http.fake();

      const task = new ScheduledTask(() => {
        throw new Error("boom");
      })
        .pingOnFailure("https://example.test/failure")
        .pingOnSuccess("https://example.test/success")
        .thenPing("https://example.test/after");

      await expect(task.run(new Application())).rejects.toThrow("boom");

      Http.assertSent("example.test/failure");
      Http.assertSent("example.test/after");
      Http.assertNotSent("example.test/success");
    });

    it("pings with a GET", async () => {
      Http.fake();

      await new ScheduledTask(() => {})
        .pingBefore("https://example.test/before")
        .run(new Application());

      Http.assertSent((request) => request.method === "GET");
    });

    it("a failing ping does not fail the task", async () => {
      Http.fake({ "*": Http.failedConnection("network down") });

      const app = new Application();
      // Silenced: the failure IS logged (asserted separately below); this
      // test is about the task still completing.
      vi.spyOn(app.logger, "warning").mockImplementation(() => {});

      let ran = false;
      const task = new ScheduledTask(() => {
        ran = true;
      }).pingBefore("https://example.test/before");

      await expect(task.run(app)).resolves.toBeUndefined();
      expect(ran).toBe(true);
    });

    it("a ping returning an error status does not fail the task", async () => {
      Http.fake({ "*": 500 });

      let ran = false;
      const task = new ScheduledTask(() => {
        ran = true;
      }).pingBefore("https://example.test/before");

      await expect(task.run(new Application())).resolves.toBeUndefined();
      expect(ran).toBe(true);
    });

    it("logs a failing ping at warning rather than swallowing it silently", async () => {
      Http.fake({ "*": Http.failedConnection("network down") });

      const app = new Application();
      const warning = vi.spyOn(app.logger, "warning").mockImplementation(() => {});

      const task = new ScheduledTask(() => {})
        .name("nightly")
        .pingBefore("https://example.test/before");
      await task.run(app);

      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toContain("nightly");
      expect(warning.mock.calls[0]?.[1]?.url).toBe("https://example.test/before");
      warning.mockRestore();
    });

    it("a hanging ping endpoint does not block the task indefinitely", async () => {
      // A REAL server that accepts the connection and then never answers,
      // the failure mode a monitoring endpoint actually has, and one a
      // stubbed transport can't reproduce, because `Http.fake()` resolves
      // the stub without ever consulting the abort signal. Only a genuine
      // request exercises the `AbortSignal.timeout()` the client installs.
      const hanging = createServer(() => {
        // Deliberately never responds.
      });
      await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
      const { port } = hanging.address() as AddressInfo;

      const app = new Application();
      // 300ms rather than the 5s default, to keep the test quick. The
      // point is that SOME bound applies, not its exact value.
      app.config.set("schedule", { pingTimeoutMs: 300 });
      const warning = vi.spyOn(app.logger, "warning").mockImplementation(() => {});

      let ran = false;
      const task = new ScheduledTask(() => {
        ran = true;
      }).pingBefore(`http://127.0.0.1:${port}/hangs`);

      const startedAt = Date.now();
      try {
        await task.run(app);
      } finally {
        await new Promise<void>((resolve) => hanging.close(() => resolve()));
      }

      expect(ran).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(warning).toHaveBeenCalledOnce();
      warning.mockRestore();
    }, 15_000);

    it("fires several pings concurrently, so N slow URLs cost one timeout not N", async () => {
      const started: number[] = [];
      Http.fake(async () => {
        started.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));

        return 200;
      });

      const task = new ScheduledTask(() => {})
        .pingBefore("https://example.test/one")
        .pingBefore("https://example.test/two")
        .pingBefore("https://example.test/three");

      const startedAt = Date.now();
      await task.run(new Application());

      expect(started).toHaveLength(3);
      // Sequential would be ~150ms; concurrent is ~50ms.
      expect(Date.now() - startedAt).toBeLessThan(120);
    });
  });

  describe("timezone()", () => {
    it("is recorded and reflected in getTimezone()", () => {
      const task = new ScheduledTask(() => {}).timezone("America/New_York");
      expect(task.getTimezone()).toBe("America/New_York");
    });

    it("evaluates due-ness in the configured zone", () => {
      // 2026-01-01 12:00 UTC is 07:00 in America/New_York (UTC-5 in winter).
      const noonUtc = new Date(Date.UTC(2026, 0, 1, 12, 0));
      const task = new ScheduledTask(() => {}).dailyAt("7:00").timezone("America/New_York");
      expect(task.isDueAt(noonUtc)).toBe(true);

      const notMatching = new ScheduledTask(() => {}).dailyAt("12:00").timezone("America/New_York");
      expect(notMatching.isDueAt(noonUtc)).toBe(false);
    });
  });
});
