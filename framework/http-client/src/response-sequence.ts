import { readFile } from "node:fs/promises";
import { normalizeStub, type StubResponse } from "./stub.js";

/** A queued sequence entry: a stub, or a marker to fail the connection. */
type SequenceEntry =
  { kind: "response"; stub: StubResponse } | { kind: "connection-failure"; message: string };

/**
 * A FIFO queue of stubbed responses for one pattern, port of Laravel's
 * `Illuminate\Http\Client\ResponseSequence`. Each matching request drains
 * the next entry, which is how you stub "fails twice, then succeeds" for a
 * retry test.
 *
 *   Http.fake({
 *     "api.example.com/*": Http.sequence()
 *       .pushStatus(500)
 *       .pushStatus(500)
 *       .push({ ok: true }),
 *   });
 *
 * Draining an empty sequence throws, so a test that sends more requests
 * than it stubbed fails loudly. `whenEmpty()` / `dontFailWhenEmpty()` opt
 * out of that.
 */
export class ResponseSequence {
  private readonly entries: SequenceEntry[] = [];
  private emptyResponse?: StubResponse;
  private failWhenEmpty = true;

  /** Queue a response, same coercions as `Http.response()`. */
  push(body?: unknown, status = 200, headers: Record<string, string> = {}): this {
    this.entries.push({ kind: "response", stub: { body, status, headers } });

    return this;
  }

  /** Queue a bare status code with an empty body. */
  pushStatus(status: number, headers: Record<string, string> = {}): this {
    this.entries.push({ kind: "response", stub: { status, headers } });

    return this;
  }

  /** Queue a response whose body is the contents of `path`, read at drain time. */
  pushFile(path: string, status = 200, headers: Record<string, string> = {}): this {
    this.entries.push({ kind: "response", stub: { body: { __file: path }, status, headers } });

    return this;
  }

  /** Queue a transport failure, surfacing as a `ConnectionError`. */
  pushFailedConnection(message = "Connection failed."): this {
    this.entries.push({ kind: "connection-failure", message });

    return this;
  }

  /** Respond with `response` once the queue is drained, instead of throwing. */
  whenEmpty(response: StubResponse): this {
    this.emptyResponse = response;
    this.failWhenEmpty = false;

    return this;
  }

  /** Respond with an empty 200 once drained, instead of throwing. */
  dontFailWhenEmpty(): this {
    this.failWhenEmpty = false;

    return this;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Takes the next entry. Returns a `Response`, or a connection-failure
   * marker the stub transport turns into a rejection.
   */
  async next(): Promise<Response | { connectionFailure: string }> {
    const entry = this.entries.shift();

    if (!entry) {
      if (this.failWhenEmpty) {
        throw new Error(
          "A request was made but the response sequence is empty. Queue more responses, or call " +
            "whenEmpty()/dontFailWhenEmpty() on the sequence.",
        );
      }

      return this.emptyResponse === undefined
        ? new Response(null, { status: 200 })
        : normalizeStub(this.emptyResponse);
    }

    if (entry.kind === "connection-failure") {
      return { connectionFailure: entry.message };
    }

    return normalizeStub(await resolveFileBody(entry.stub));
  }
}

/**
 * Resolves the `pushFile` placeholder into the file's bytes. Deferred to
 * drain time so a sequence can be built before the file exists, and so a
 * queued-but-never-drained entry never touches the disk.
 */
async function resolveFileBody(stub: StubResponse): Promise<StubResponse> {
  if (typeof stub !== "object" || stub === null || !("body" in stub)) {
    return stub;
  }

  const body = (stub as { body?: unknown }).body;

  if (typeof body !== "object" || body === null || !("__file" in body)) {
    return stub;
  }

  const contents = await readFile((body as { __file: string }).__file);

  return { ...(stub as object), body: new Uint8Array(contents) } as StubResponse;
}
