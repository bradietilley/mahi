import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";

/** Where `sink()` writes a response body: a file path, or a stream to pipe into. */
export type Sink = string | WritableStream<Uint8Array>;

/**
 * Drains `response` into `sink`.
 *
 * For a real network response the body is piped straight through, so a
 * large download never lands in memory, and `undefined` is returned,
 * `body()` on the resulting `ClientResponse` is empty, which is the point
 * of asking for a sink.
 *
 * For a stub the body is already an in-memory buffer, so it is written
 * *and* returned: Laravel's stub path calls `getContents()` and thereby
 * empties the body, leaving a test asserting on a sunk response with
 * nothing to assert against. There is no reason to reproduce that.
 */
export async function writeToSink(response: Response, sink: Sink): Promise<Uint8Array | undefined> {
  const target = typeof sink === "string" ? Writable.toWeb(createWriteStream(sink)) : sink;

  if (response.body === null) {
    await target.close();

    return new Uint8Array();
  }

  // A synthesised (stubbed) Response has no `url`; buffering it costs
  // nothing since it is already resident, and keeps `body()` readable.
  if (response.url === "") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const writer = target.getWriter();
    await writer.write(bytes);
    await writer.close();

    return bytes;
  }

  await response.body.pipeTo(target as WritableStream<Uint8Array>);

  return undefined;
}
