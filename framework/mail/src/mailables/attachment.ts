/**
 * A single mail attachment. Deliberately narrower than Laravel's
 * `Illuminate\Mail\Attachment` (which carries a whole strategy object for
 * from-path/from-storage/from-data resolution): here an attachment is just
 * the already-resolved bytes-or-path plus its metadata, and *how* those
 * bytes were obtained (read off disk, pulled from `@mahi/storage`,
 * built in memory) is the caller's concern, not this value object's.
 *
 * Exactly one of `content` / `path` should be provided:
 *   - `content` — the raw bytes (a `Buffer`/`Uint8Array`) or a UTF-8 string.
 *   - `path`    — a filesystem path the transport reads at send time.
 * `filename` is the name the recipient sees; `contentType` overrides the
 * transport's MIME guess when set.
 */
export interface Attachment {
  filename: string;
  content?: Buffer | Uint8Array | string;
  path?: string;
  contentType?: string;
  /**
   * `cid` for inline (embedded) attachments referenced from HTML via
   * `<img src="cid:...">`. Omit for ordinary file attachments.
   */
  cid?: string;
}
