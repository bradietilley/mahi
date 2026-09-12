import { Application } from "@mahiframework/core";
import {
  ArrayCacheStore,
  CacheManager,
  CACHE_TOKEN,
  RateLimiter,
  Limit,
} from "@mahiframework/cache";
import { describe, expect, it } from "vitest";
import { Job } from "../../src/job.js";
import { JobRegistry } from "../../src/job-registry.js";
import { JOB_REGISTRY_TOKEN } from "../../src/tokens.js";
import { runJobThroughMiddleware } from "../../src/middleware/run-job-through-middleware.js";
import { ReleaseJobError } from "../../src/middleware/release-job-error.js";
import { RateLimited } from "../../src/middleware/rate-limited.js";
import { WithoutOverlapping } from "../../src/middleware/without-overlapping.js";
import { ThrottlesExceptions } from "../../src/middleware/throttles-exceptions.js";
import type { JobMiddleware, JobMiddlewarePassable } from "../../src/middleware/job-middleware.js";

const app = new Application();

/** A minimal job instance for middleware tests that don't care about job state. */
class DummyJob extends Job {
  handle(): void {}
}
const dummyJob = new DummyJob();

describe("runJobThroughMiddleware", () => {
  it("runs handle() directly when a job declares no middleware", async () => {
    const calls: unknown[] = [];
    class PlainJob extends Job {
      constructor(public readonly n: number) {
        super();
      }
      handle(): void {
        calls.push({ n: this.n });
      }
    }

    await runJobThroughMiddleware(app, new PlainJob(1));

    expect(calls).toEqual([{ n: 1 }]);
  });

  it("threads middleware around handle() in order, both directions", async () => {
    const order: string[] = [];

    class Tracer implements JobMiddleware {
      constructor(private label: string) {}
      async handle(
        p: JobMiddlewarePassable,
        next: (p: JobMiddlewarePassable) => Promise<void>,
      ): Promise<void> {
        order.push(`before:${this.label}`);
        await next(p);
        order.push(`after:${this.label}`);
      }
    }

    class TracedJob extends Job {
      middleware(): JobMiddleware[] {
        return [new Tracer("a"), new Tracer("b")];
      }
      handle(): void {
        order.push("handle");
      }
    }

    await runJobThroughMiddleware(app, new TracedJob());

    expect(order).toEqual(["before:a", "before:b", "handle", "after:b", "after:a"]);
  });

  it("a middleware that skips next() prevents handle() from running", async () => {
    let handled = false;
    class Blocker implements JobMiddleware {
      async handle(): Promise<void> {
        // intentionally never calls next()
      }
    }
    class BlockedJob extends Job {
      middleware(): JobMiddleware[] {
        return [new Blocker()];
      }
      handle(): void {
        handled = true;
      }
    }

    await runJobThroughMiddleware(app, new BlockedJob());

    expect(handled).toBe(false);
  });

  it("propagates a ReleaseJobError thrown from a middleware", async () => {
    class Releaser implements JobMiddleware {
      async handle(): Promise<void> {
        throw new ReleaseJobError(42);
      }
    }
    class RJob extends Job {
      middleware(): JobMiddleware[] {
        return [new Releaser()];
      }
      handle(): void {}
    }

    await expect(runJobThroughMiddleware(app, new RJob())).rejects.toMatchObject({
      name: "ReleaseJobError",
      delaySeconds: 42,
    });
  });
});

describe("RateLimited", () => {
  function setup(limit: Limit) {
    const limiter = new RateLimiter(new ArrayCacheStore());
    limiter.for("emails", () => limit);

    return limiter;
  }

  it("lets the job run while under the limit, counting each run", async () => {
    const limiter = setup(Limit.perMinute(2));
    const mw = new RateLimited(limiter, "emails");
    const passable: JobMiddlewarePassable = { app, job: dummyJob };

    let runs = 0;
    const run = () =>
      mw.handle(passable, async () => {
        runs += 1;
      });

    await run();
    await run();
    expect(runs).toBe(2);
  });

  it("releases the job (does not run it) once the limit is exceeded", async () => {
    const limiter = setup(Limit.perMinute(1));
    const mw = new RateLimited(limiter, "emails");
    const passable: JobMiddlewarePassable = { app, job: dummyJob };

    let runs = 0;
    const run = () =>
      mw.handle(passable, async () => {
        runs += 1;
      });

    await run();
    await expect(run()).rejects.toBeInstanceOf(ReleaseJobError);
    expect(runs).toBe(1);
  });

  it("fails open (runs) when the named limiter is not registered", async () => {
    const limiter = new RateLimiter(new ArrayCacheStore());
    const mw = new RateLimited(limiter, "missing");
    let ran = false;
    await mw.handle({ app, job: dummyJob }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("WithoutOverlapping", () => {
  it("runs the job and releases the lock afterward so a later run can proceed", async () => {
    const store = new ArrayCacheStore();
    let runs = 0;
    const mw = new WithoutOverlapping(store, "invoice:1");

    await mw.handle({ app, job: dummyJob }, async () => {
      runs += 1;
    });
    await mw.handle({ app, job: dummyJob }, async () => {
      runs += 1;
    });

    expect(runs).toBe(2);
  });

  it("releases an overlapping job while the lock is held", async () => {
    const store = new ArrayCacheStore();
    const mw = new WithoutOverlapping(store, "invoice:1");

    // Hold the lock by starting a job that blocks until we let it finish.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = mw.handle({ app, job: dummyJob }, async () => {
      await gate;
    });

    // A second job while the first still holds the lock is released.
    await expect(mw.handle({ app, job: dummyJob }, async () => {})).rejects.toBeInstanceOf(
      ReleaseJobError,
    );

    release();
    await first;
  });

  it("silently skips (no release) when releaseAfterSeconds is false", async () => {
    const store = new ArrayCacheStore();
    const mw = new WithoutOverlapping(store, "invoice:1", { releaseAfterSeconds: false });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = mw.handle({ app, job: dummyJob }, async () => {
      await gate;
    });

    let ran = false;
    await mw.handle({ app, job: dummyJob }, async () => {
      ran = true;
    });
    expect(ran).toBe(false);

    release();
    await first;
  });

  it("defaults to a non-zero release delay rather than an instant hot retry", async () => {
    const store = new ArrayCacheStore();
    const mw = new WithoutOverlapping(store, "invoice:1");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = mw.handle({ app, job: dummyJob }, async () => {
      await gate;
    });

    // A zero delay means the blocked job is popped, finds the lock still
    // held, and is released again immediately — a hot loop for the whole
    // duration of the first job's run.
    const error = await mw
      .handle({ app, job: dummyJob }, async () => {})
      .catch((e: unknown) => e as ReleaseJobError);
    expect(error).toBeInstanceOf(ReleaseJobError);
    expect((error as ReleaseJobError).delaySeconds).toBeGreaterThan(0);

    release();
    await first;
  });

  it("honours an explicit releaseAfterSeconds", async () => {
    const store = new ArrayCacheStore();
    const mw = new WithoutOverlapping(store, "invoice:1", { releaseAfterSeconds: 30 });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = mw.handle({ app, job: dummyJob }, async () => {
      await gate;
    });

    const error = await mw
      .handle({ app, job: dummyJob }, async () => {})
      .catch((e: unknown) => e as ReleaseJobError);
    expect((error as ReleaseJobError).delaySeconds).toBe(30);

    release();
    await first;
  });

  it("surfaces a store failure instead of mistaking it for contention", async () => {
    // A `catch {}` around acquire() made "Redis is down" indistinguishable
    // from "someone else holds the lock", so every job on every worker
    // quietly released itself forever while the real fault went unreported.
    const broken = new ArrayCacheStore();
    broken.add = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    };
    const mw = new WithoutOverlapping(broken, "invoice:1");

    await expect(mw.handle({ app, job: dummyJob }, async () => {})).rejects.toThrow("ECONNREFUSED");
  });

  it("does not share a lock between two different job classes on the same key", async () => {
    const store = new ArrayCacheStore();

    class JobA extends Job {
      handle(): void {}
    }
    class JobB extends Job {
      handle(): void {}
    }

    // JobA holds its lock on key "invoice:1"...
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = new WithoutOverlapping(store, "invoice:1");
    const first = a.handle({ app, job: new JobA() }, async () => {
      await gate;
    });

    // ...but JobB on the same key is namespaced separately, so it runs.
    const b = new WithoutOverlapping(store, "invoice:1");
    let ranB = false;
    await b.handle({ app, job: new JobB() }, async () => {
      ranB = true;
    });
    expect(ranB).toBe(true);

    release();
    await first;
  });

  it("keys on the registered job name, so classes minified to the same constructor.name don't collide", async () => {
    const store = new ArrayCacheStore();
    const registry = new JobRegistry();

    // Simulate a minifier collapsing two distinct job classes to the same
    // constructor.name ("e"). Without the registry name they would share an
    // overlap lock; with it they stay isolated.
    class JobOne extends Job {
      handle(): void {}
    }
    class JobTwo extends Job {
      handle(): void {}
    }
    Object.defineProperty(JobOne, "name", { value: "e" });
    Object.defineProperty(JobTwo, "name", { value: "e" });
    registry.register("jobs.one", JobOne);
    registry.register("jobs.two", JobTwo);

    const registryApp = new Application();
    registryApp.instance(JOB_REGISTRY_TOKEN, registry);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = new WithoutOverlapping(store, "invoice:1");
    const first = a.handle({ app: registryApp, job: new JobOne() }, async () => {
      await gate;
    });

    const b = new WithoutOverlapping(store, "invoice:1");
    let ranB = false;
    await b.handle({ app: registryApp, job: new JobTwo() }, async () => {
      ranB = true;
    });
    expect(ranB).toBe(true);

    release();
    await first;
  });

  it("shared() makes two different job classes contend on the same key", async () => {
    const store = new ArrayCacheStore();

    class JobA extends Job {
      handle(): void {}
    }
    class JobB extends Job {
      handle(): void {}
    }

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = new WithoutOverlapping(store, "invoice:1").shared();
    const first = a.handle({ app, job: new JobA() }, async () => {
      await gate;
    });

    const b = new WithoutOverlapping(store, "invoice:1").shared();
    await expect(b.handle({ app, job: new JobB() }, async () => {})).rejects.toBeInstanceOf(
      ReleaseJobError,
    );

    release();
    await first;
  });

  it("resolves the default cache store from the container when none is passed", async () => {
    const containerApp = new Application();
    const store = new ArrayCacheStore();
    const cache = new CacheManager(containerApp, { default: "array", stores: {} });
    cache.extend("array", () => store);
    containerApp.instance(CACHE_TOKEN, cache);

    const mw = WithoutOverlapping.for("invoice:1");

    let ran = false;
    await mw.handle({ app: containerApp, job: dummyJob }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);

    // Second run after release proceeds too — proving the resolved store
    // is a real, shared one that the lock was released on.
    await mw.handle({ app: containerApp, job: dummyJob }, async () => {});
  });

  it("keys the lock on the registry name, not constructor.name", async () => {
    // A minifier is free to rename two distinct job classes to the same
    // short identifier. Keying on `constructor.name` then collapses their
    // locks into one and each blocks the other — the exact cross-class
    // collision the class prefix exists to prevent. Both classes below are
    // literally named "n", as minified output would be.
    const store = new ArrayCacheStore();

    const first = class n extends Job {
      handle(): void {}
    };
    const second = class n extends Job {
      handle(): void {}
    };
    expect(first.name).toBe(second.name);

    const registry = new JobRegistry();
    registry.register("reports.daily", first);
    registry.register("reports.weekly", second);

    const registryApp = new Application();
    registryApp.instance(JOB_REGISTRY_TOKEN, registry);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = new WithoutOverlapping(store, "invoice:1");
    const held = a.handle({ app: registryApp, job: new first() }, async () => {
      await gate;
    });

    // Distinct registry names → distinct locks → the second class runs.
    const b = new WithoutOverlapping(store, "invoice:1");
    let ranB = false;
    await b.handle({ app: registryApp, job: new second() }, async () => {
      ranB = true;
    });
    expect(ranB).toBe(true);

    release();
    await held;
  });

  it("still contends when the SAME registered job overlaps itself", async () => {
    const store = new ArrayCacheStore();

    class DailyReport extends Job {
      handle(): void {}
    }

    const registry = new JobRegistry();
    registry.register("reports.daily", DailyReport);
    const registryApp = new Application();
    registryApp.instance(JOB_REGISTRY_TOKEN, registry);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = new WithoutOverlapping(store, "invoice:1");
    const held = a.handle({ app: registryApp, job: new DailyReport() }, async () => {
      await gate;
    });

    const b = new WithoutOverlapping(store, "invoice:1");
    await expect(
      b.handle({ app: registryApp, job: new DailyReport() }, async () => {}),
    ).rejects.toBeInstanceOf(ReleaseJobError);

    release();
    await held;
  });

  it("falls back to constructor.name when the job is unregistered", async () => {
    // The middleware works standalone (no queue provider), and an
    // unregistered class must not fail the job over a lock key.
    const store = new ArrayCacheStore();

    class Unregistered extends Job {
      handle(): void {}
    }

    const registryApp = new Application();
    registryApp.instance(JOB_REGISTRY_TOKEN, new JobRegistry());

    const mw = new WithoutOverlapping(store, "invoice:1");
    let ran = false;
    await mw.handle({ app: registryApp, job: new Unregistered() }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("dontRelease() drops a blocked job (fluent)", async () => {
    const store = new ArrayCacheStore();
    const mw = new WithoutOverlapping(store, "invoice:1").dontRelease();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = mw.handle({ app, job: dummyJob }, async () => {
      await gate;
    });

    let ran = false;
    await mw.handle({ app, job: dummyJob }, async () => {
      ran = true;
    });
    expect(ran).toBe(false);

    release();
    await first;
  });
});

describe("ThrottlesExceptions", () => {
  it("re-throws and counts each exception, opening the circuit past the threshold", async () => {
    const limiter = new RateLimiter(new ArrayCacheStore());
    const mw = new ThrottlesExceptions(limiter, "orders:1", { maxExceptions: 2, decayMinutes: 1 });

    const boom = () =>
      mw.handle({ app, job: dummyJob }, async () => {
        throw new Error("downstream");
      });

    // First two throws surface the real error (counted).
    await expect(boom()).rejects.toThrow("downstream");
    await expect(boom()).rejects.toThrow("downstream");

    // Circuit now open — further runs are released without executing handle().
    await expect(boom()).rejects.toBeInstanceOf(ReleaseJobError);
  });

  it("does not count successful runs and never opens on success", async () => {
    const limiter = new RateLimiter(new ArrayCacheStore());
    const mw = new ThrottlesExceptions(limiter, "orders:2", { maxExceptions: 1 });

    let runs = 0;

    for (let i = 0; i < 5; i++) {
      await mw.handle({ app, job: dummyJob }, async () => {
        runs += 1;
      });
    }

    expect(runs).toBe(5);
  });
});
