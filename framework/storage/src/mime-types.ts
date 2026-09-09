/**
 * Best-effort extension→MIME guess from a file name. Deliberately small:
 * a disk has no real content-type concept (`get()` returns a bare
 * `Buffer`), so this only has to cover what the framework itself serves
 * and reports. Returns `undefined` for an unknown extension; callers that
 * need a concrete header fall back to `application/octet-stream`.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  pdf: "application/pdf",
};

export function guessMimeType(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  return EXTENSION_MIME_TYPES[ext];
}
