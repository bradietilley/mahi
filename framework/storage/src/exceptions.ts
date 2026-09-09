/**
 * Thrown when a read-oriented operation (`readStream`, `size`,
 * `lastModified`, `copy`/`move` source, …) targets a path that does not
 * exist on the disk. Laravel raises a `FileNotFoundException` in the same
 * situations; the point of a typed error is that a caller can distinguish
 * "no such file" from a path-traversal rejection (a plain `Error`) or a
 * late `ENOENT` surfacing mid-stream.
 *
 * `readStream()` in particular `stat`s up front and rejects with this
 * *before* handing back a `Readable`, so consumers never have to attach an
 * error handler just to learn the file was missing.
 */
export class FileNotFoundException extends Error {
  constructor(path: string) {
    super(`File [${path}] does not exist.`);
    this.name = "FileNotFoundException";
  }
}
