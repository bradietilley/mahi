import { Readable } from "node:stream";
import { guessMimeType } from "./mime-types.js";
import { app } from "@mahiframework/core";
import { pathFromPublicUrl } from "./public-url.js";
import type { StorageDriver } from "./storage-driver.js";
import { STORAGE_TOKEN } from "./storage-service-provider.js";
import { isLocalDiskConfig, StorageManager } from "./storage-manager.js";

export interface ServeStoredFileOptions {
  cacheControl?: string;
  contentType?: string;
  /**
   * The incoming request's headers (for `Range`/`If-None-Match`/
   * `If-Modified-Since`) and abort `signal` (to destroy the read stream if
   * the client goes away). Optional — omit it and you get a plain 200 with
   * the whole body, same as before.
   */
  request?: { headers?: Headers; signal?: AbortSignal };
}

function mimeTypeForPath(path: string): string {
  return guessMimeType(path) ?? "application/octet-stream";
}

/**
 * Stream `path` off `driver` as an HTTP `Response`. Missing files and
 * path-traversal attempts are both a 404 — the status is the only signal;
 * don't leak whether the path escaped the root.
 *
 * Sets `Content-Length`, `Last-Modified`, a weak `ETag` (size+mtime) and
 * `Accept-Ranges: bytes`. When `options.request` carries request headers
 * it honours `Range` (206 / `Content-Range`, 416 on an unsatisfiable
 * range), `If-None-Match` and `If-Modified-Since` (304). The body is a
 * streamed `Readable`, so a large file is never buffered into memory; an
 * aborted request destroys the underlying read stream.
 */
export async function serveStoredFile(
  driver: StorageDriver,
  path: string,
  options: ServeStoredFileOptions = {},
): Promise<Response> {
  let size: number;
  let mtime: Date;
  try {
    if (!(await driver.exists(path))) {
      return new Response("Not Found", { status: 404 });
    }

    size = await driver.size(path);
    mtime = await driver.lastModified(path);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  const etag = weakEtag(size, mtime);
  const lastModified = mtime.toUTCString();
  const reqHeaders = options.request?.headers;

  const baseHeaders: Record<string, string> = {
    "Content-Type": options.contentType ?? mimeTypeForPath(path),
    "Last-Modified": lastModified,
    ETag: etag,
    "Accept-Ranges": "bytes",
  };

  if (options.cacheControl !== undefined) {
    baseHeaders["Cache-Control"] = options.cacheControl;
  }

  // Conditional GET — a fresh cache gets a bodyless 304.
  if (reqHeaders && isNotModified(reqHeaders, etag, mtime)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  // Range request — a single satisfiable range becomes a 206.
  const range = reqHeaders ? parseRange(reqHeaders.get("range"), size) : null;

  if (range === "invalid") {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  let stream: Readable;
  try {
    stream = size === 0 ? Readable.from([]) : await driver.readStream(path, { start, end });
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  bindAbort(stream, options.request?.signal);

  const headers: Record<string, string> = {
    ...baseHeaders,
    "Content-Length": String(length),
  };

  if (range) {
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }

  const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

  return new Response(body, { status: range ? 206 : 200, headers });
}

/** Weak validator from size + mtime — cheap and stable, no content hash. */
function weakEtag(size: number, mtime: Date): string {
  return `W/"${size.toString(16)}-${mtime.getTime().toString(16)}"`;
}

/**
 * A conditional request is "not modified" when `If-None-Match` names the
 * current ETag, or (absent that) `If-Modified-Since` is at or after the
 * file's mtime. `If-None-Match` wins when both are present (RFC 7232).
 */
function isNotModified(headers: Headers, etag: string, mtime: Date): boolean {
  const inm = headers.get("if-none-match");

  if (inm !== null) {
    return inm
      .split(",")
      .map((tag) => tag.trim())
      .some((tag) => tag === "*" || tag === etag || tag === etag.replace(/^W\//, ""));
  }

  const ims = headers.get("if-modified-since");

  if (ims !== null) {
    const since = Date.parse(ims);

    if (!Number.isNaN(since)) {
      // Compare at second granularity — HTTP dates have no sub-second part.
      return Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000);
    }
  }

  return false;
}

/**
 * Parse a single-range `Range: bytes=…` header against a known size.
 * Returns the inclusive `{ start, end }`, `null` when there is no range to
 * apply, or `"invalid"` when the range is unsatisfiable (→ 416). Only the
 * first range of a set is honoured; multipart ranges are out of scope.
 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (header === null || header.trim() === "") {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (match === null) {
    return "invalid";
  }

  const [, rawStart, rawEnd] = match;

  if (rawStart === "" && rawEnd === "") {
    return "invalid";
  }

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);

    if (suffix === 0) {
      return "invalid";
    }

    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (start > end || start >= size) {
    return "invalid";
  }

  if (end >= size) {
    end = size - 1;
  }

  return { start, end };
}

/** Destroy the read stream if the request is (or becomes) aborted. */
function bindAbort(stream: Readable, signal: AbortSignal | undefined): void {
  if (!signal) {
    return;
  }

  if (signal.aborted) {
    stream.destroy();

    return;
  }

  signal.addEventListener("abort", () => stream.destroy(), { once: true });
}

/**
 * Route handler that serves files from a named disk under that disk's
 * configured `url` prefix. Wire it with a catch-all whose path matches
 * the prefix, e.g. `router.get("/storage/*", servePublicDisk("public"))`.
 *
 * Takes a structural `{ path() }` rather than `@mahiframework/http`'s
 * `Request` so this package doesn't depend on HTTP — Node can point a
 * thin route at the storage root without Laravel's `storage:link`
 * symlink (which exists to work around PHP web-servers not serving
 * arbitrary app-directory paths).
 */
export function servePublicDisk(
  diskName: string,
  options: ServeStoredFileOptions = {},
): (request: { path(): string }) => Promise<Response> {
  return async (request) => {
    const storage = app().make<StorageManager>(STORAGE_TOKEN);
    const config = storage.diskConfig(diskName);

    if (!isLocalDiskConfig(config) || config.url === undefined || config.url === "") {
      throw new Error(`Disk [${diskName}] has no url configured — cannot serve it publicly.`);
    }

    const relative = pathFromPublicUrl(request.path(), config.url);

    if (relative === null) {
      return new Response("Not Found", { status: 404 });
    }

    return serveStoredFile(storage.disk(diskName), relative, options);
  };
}
