import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientResponse } from "../src/client-response.js";
import { ConnectionError, RequestFailedError } from "../src/errors.js";
import { Http } from "../src/http.js";
import { PendingRequest } from "../src/pending-request.js";
import type { Transport } from "../src/transport.js";

afterEach(() => {
  Http.restore();
  vi.useRealTimers();
});

/**
 * A transport answering from a queue of statuses, counting attempts. A
 * `"fail"` entry rejects, standing in for a transport-level failure.
 */
function queued(...statuses: Array<number | "fail">): {
  transport: Transport;
  attempts: () => number;
} {
  let attempt = 0;

  return {
    transport: async () => {
      const status = statuses[attempt++] ?? statuses.at(-1) ?? 200;

      if (status === "fail") {
        throw new Error("connection refused");
      }

      return new Response(`attempt ${attempt}`, { status });
    },
    attempts: () => attempt,
  };
}

/** Runs `run()` with timers faked, auto-advancing so backoff never really sleeps. */
async function withoutSleeping<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const promise = run();
  await vi.runAllTimersAsync();
  const result = await promise;
  vi.useRealTimers();

  return result;
}

describe("attempt counts", () => {
  it("stops after the first attempt on success", async () => {
    const { transport, attempts } = queued(200);
    const response = await new PendingRequest()
      .withTransport(transport)
      .retry(3)
      .get("https://x.test/");

    expect(attempts()).toBe(1);
    expect(response.status).toBe(200);
  });

  it("stops as soon as an attempt succeeds", async () => {
    const { transport, attempts } = queued(500, 500, 200);
    const response = await new PendingRequest()
      .withTransport(transport)
      .retry(5)
      .get("https://x.test/");

    expect(attempts()).toBe(3);
    expect(response.status).toBe(200);
  });

  it("makes exactly `times` attempts before giving up", async () => {
    const { transport, attempts } = queued(500, 500, 500, 500);
    await new PendingRequest().withTransport(transport).retry(3).get("https://x.test/");

    // The first call counts as an attempt, matching @mahi/core's retry().
    expect(attempts()).toBe(3);
  });

  it("does not retry at all without retry()", async () => {
    const { transport, attempts } = queued(500, 200);
    const response = await new PendingRequest().withTransport(transport).get("https://x.test/");

    expect(attempts()).toBe(1);
    expect(response.status).toBe(500);
  });
});

describe("what is retryable by default", () => {
  // Every failed status retries — no allow-list. A 401 is genuinely
  // retryable when middleware refreshes a token between attempts, and a
  // 409 is against an optimistic-locking API; a client cannot tell those
  // from the status alone. Predictability beats saved round trips.
  const statuses = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503];

  it.each(statuses)("retries a %i by default", async (status) => {
    const { transport, attempts } = queued(status, 200);
    await new PendingRequest().withTransport(transport).retry(2).get("https://x.test/");
    expect(attempts()).toBe(2);
  });

  it("retries a ConnectionError", async () => {
    const { transport, attempts } = queued("fail", "fail", 200);
    const response = await new PendingRequest()
      .withTransport(transport)
      .retry(3)
      .get("https://x.test/");

    expect(attempts()).toBe(3);
    expect(response.status).toBe(200);
  });

  it("does not retry a 3xx, which is not a failure", async () => {
    const { transport, attempts } = queued(301, 200);
    const response = await new PendingRequest()
      .withTransport(transport)
      .retry(3)
      .get("https://x.test/");

    expect(attempts()).toBe(1);
    expect(response.status).toBe(301);
  });
});

describe("narrowing with `when`", () => {
  it("the documented 5xx-only recipe skips a 4xx", async () => {
    const { transport, attempts } = queued(422, 200);

    const response = await new PendingRequest()
      .withTransport(transport)
      .retry(
        3,
        0,
        (error, response) => error instanceof ConnectionError || (response?.serverError() ?? false),
      )
      .get("https://x.test/");

    expect(attempts()).toBe(1);
    expect(response.status).toBe(422);
  });

  it("the same recipe still retries a 5xx", async () => {
    const { transport, attempts } = queued(503, 200);

    await new PendingRequest()
      .withTransport(transport)
      .retry(
        3,
        0,
        (error, response) => error instanceof ConnectionError || (response?.serverError() ?? false),
      )
      .get("https://x.test/");

    expect(attempts()).toBe(2);
  });

  it("hands the predicate a response for a failed status and an error for a transport failure", async () => {
    const seen: Array<{ hasError: boolean; status?: number }> = [];
    const { transport } = queued(500, "fail", 200);

    await new PendingRequest()
      .withTransport(transport)
      .retry(3, 0, (error, response) => {
        seen.push({ hasError: error !== undefined, status: response?.status });

        return true;
      })
      .get("https://x.test/");

    expect(seen).toEqual([
      { hasError: false, status: 500 },
      { hasError: true, status: undefined },
    ]);
  });

  it("never exposes the internal RetrySignal to the predicate", async () => {
    const { transport } = queued(500, 200);
    let leaked: unknown;

    await new PendingRequest()
      .withTransport(transport)
      .retry(2, 0, (error) => {
        leaked = error;

        return true;
      })
      .get("https://x.test/");

    // The sentinel bridging failed responses into the exception-driven
    // core retry() must never escape the module.
    expect(leaked).toBeUndefined();
  });
});

describe("backoff", () => {
  it("consumes an array of per-attempt delays", async () => {
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      fn();

      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const { transport } = queued(500, 500, 500, 200);
    await new PendingRequest()
      .withTransport(transport)
      .retry(4, [10, 20, 30])
      .get("https://x.test/");

    expect(delays).toEqual([10, 20, 30]);
    spy.mockRestore();
  });

  it("accepts a function of the attempt number", async () => {
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      fn();

      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const { transport } = queued(500, 500, 200);
    await new PendingRequest()
      .withTransport(transport)
      .retry(3, (attempt) => attempt * 100)
      .get("https://x.test/");

    expect(delays).toEqual([100, 200]);
    spy.mockRestore();
  });

  it("does not sleep when the first attempt succeeds", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const { transport } = queued(200);

    await new PendingRequest().withTransport(transport).retry(3, 1000).get("https://x.test/");

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("Retry-After", () => {
  /** Captures the delays passed to setTimeout while `run()` executes. */
  async function delaysFor(run: () => Promise<unknown>): Promise<number[]> {
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      fn();

      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    await run();
    spy.mockRestore();

    return delays;
  }

  it("honours delta-seconds on a 429, overriding the configured backoff", async () => {
    let attempt = 0;
    const transport: Transport = async () =>
      attempt++ === 0
        ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
        : new Response(null, { status: 200 });

    const delays = await delaysFor(() =>
      new PendingRequest().withTransport(transport).retry(2, 50).get("https://x.test/"),
    );

    // Laravel ignores the header entirely, which is the single most common
    // reason a retrying client gets rate-limit-banned.
    expect(delays).toEqual([2000]);
  });

  it("honours an HTTP-date on a 503", async () => {
    let attempt = 0;
    const at = new Date(Date.now() + 5_000).toUTCString();
    const transport: Transport = async () =>
      attempt++ === 0
        ? new Response(null, { status: 503, headers: { "retry-after": at } })
        : new Response(null, { status: 200 });

    const delays = await delaysFor(() =>
      new PendingRequest().withTransport(transport).retry(2, 50).get("https://x.test/"),
    );

    expect(delays[0]).toBeGreaterThan(3_000);
    expect(delays[0]).toBeLessThanOrEqual(5_000);
  });

  it("caps the delay at 60s so a hostile header cannot stall a suite", async () => {
    let attempt = 0;
    const transport: Transport = async () =>
      attempt++ === 0
        ? new Response(null, { status: 429, headers: { "retry-after": "99999" } })
        : new Response(null, { status: 200 });

    const delays = await delaysFor(() =>
      new PendingRequest().withTransport(transport).retry(2, 50).get("https://x.test/"),
    );

    expect(delays).toEqual([60_000]);
  });

  it("ignores the header on a status other than 429/503", async () => {
    let attempt = 0;
    const transport: Transport = async () =>
      attempt++ === 0
        ? new Response(null, { status: 500, headers: { "retry-after": "30" } })
        : new Response(null, { status: 200 });

    const delays = await delaysFor(() =>
      new PendingRequest().withTransport(transport).retry(2, 50).get("https://x.test/"),
    );

    expect(delays).toEqual([50]);
  });

  it("falls back to the configured backoff for an unparseable header", async () => {
    let attempt = 0;
    const transport: Transport = async () =>
      attempt++ === 0
        ? new Response(null, { status: 429, headers: { "retry-after": "soon-ish" } })
        : new Response(null, { status: 200 });

    const delays = await delaysFor(() =>
      new PendingRequest().withTransport(transport).retry(2, 50).get("https://x.test/"),
    );

    expect(delays).toEqual([50]);
  });

  it("falls back to the configured backoff for an empty header (not an immediate retry)", async () => {
    // `Number("")` is 0, so a bare `Retry-After:` must not be allowed to
    // override the backoff with a 0ms delay — a hot retry storm against a
    // server already signalling overload.
    let attempt = 0;
    const transport: Transport = async () =>
      attempt++ === 0
        ? new Response(null, { status: 429, headers: { "retry-after": "  " } })
        : new Response(null, { status: 200 });

    const delays = await delaysFor(() =>
      new PendingRequest().withTransport(transport).retry(2, 50).get("https://x.test/"),
    );

    expect(delays).toEqual([50]);
  });

  it("honours an explicit delta-seconds of 0 as an immediate retry", async () => {
    // A server that explicitly says `Retry-After: 0` means "retry now"; only
    // an ABSENT/empty value falls back to backoff. The retry happens with no
    // sleep (so no delay is recorded), rather than waiting the 50ms backoff.
    let attempt = 0;
    const transport: Transport = async () =>
      attempt++ === 0
        ? new Response(null, { status: 429, headers: { "retry-after": "0" } })
        : new Response(null, { status: 200 });

    const response = await new PendingRequest()
      .withTransport(transport)
      .retry(2, 50)
      .get("https://x.test/");

    expect(response.status).toBe(200);
    expect(attempt).toBe(2); // it retried immediately rather than giving up
  });
});

describe("exhaustion", () => {
  it("returns the final failed response rather than throwing", async () => {
    const { transport } = queued(500, 500, 503);
    const result = await new PendingRequest()
      .withTransport(transport)
      .retry(3)
      .get("https://x.test/");

    expect(result.status).toBe(503);
    expect(result.body()).toBe("attempt 3");
  });

  it("never lets a RetrySignal escape as the resolved value", async () => {
    const { transport } = queued(500, 500, 500);
    const result: ClientResponse = await new PendingRequest()
      .withTransport(transport)
      .retry(3)
      .get("https://x.test/");

    expect(result).not.toBeInstanceOf(Error);
    expect(typeof result.json).toBe("function");
    expect(result.status).toBe(500);
  });

  it("rejects with the ConnectionError when every attempt failed to connect", async () => {
    const { transport } = queued("fail", "fail", "fail");
    const caught = await new PendingRequest()
      .withTransport(transport)
      .retry(3)
      .get("https://x.test/")
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ConnectionError);
  });

  it("raises only after exhaustion when combined with throw()", async () => {
    const { transport, attempts } = queued(500, 500, 500);

    await expect(
      new PendingRequest().withTransport(transport).retry(3).throw().get("https://x.test/"),
    ).rejects.toThrow(RequestFailedError);

    expect(attempts()).toBe(3);
  });

  it("does not raise when a later attempt succeeds under throw()", async () => {
    const { transport } = queued(500, 200);
    const response = await new PendingRequest()
      .withTransport(transport)
      .retry(2)
      .throw()
      .get("https://x.test/");

    expect(response.status).toBe(200);
  });
});

describe("with fakes and real timers", () => {
  it("retries against a response sequence without sleeping", async () => {
    Http.fake({ "*": Http.sequence().pushStatus(500).pushStatus(500).push({ ok: true }) });

    const response = await withoutSleeping(() => Http.retry(3, 1_000).get("https://x.test/"));

    expect(response.json("ok")).toBe(true);
    Http.assertSentCount(3);
  });
});

describe("non-replayable bodies", () => {
  it("refuses to retry a ReadableStream body with a clear, non-retried error", async () => {
    let attempts = 0;
    const transport: Transport = async () => {
      attempts++;

      return new Response(null, { status: 500 });
    };

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });

    const send = new PendingRequest()
      .withTransport(transport)
      .retry(3)
      .withBody(body)
      .post("https://x.test/");

    await expect(send).rejects.toThrow(ConnectionError);
    await expect(send).rejects.toThrow(/ReadableStream/);
    // Refused before any attempt, rather than consumed once and then
    // mislabelled as a connection failure and retried.
    expect(attempts).toBe(0);
  });

  it("still sends a stream body once when retries are not configured", async () => {
    let attempts = 0;
    const transport: Transport = async (request) => {
      attempts++;
      await request.text();

      return new Response(null, { status: 200 });
    };

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });

    const response = await new PendingRequest()
      .withTransport(transport)
      .withBody(body)
      .post("https://x.test/");
    expect(response.status).toBe(200);
    expect(attempts).toBe(1);
  });
});
