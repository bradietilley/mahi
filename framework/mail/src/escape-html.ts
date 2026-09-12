import { Str } from "@mahiframework/core";

/**
 * HTML-escape untrusted data before interpolating it into an HTML mail
 * body built by hand (`<p>Hi ${escapeHtml(user.name)}</p>`). A thin
 * re-export of `Str.escapeHtml` so mail code needn't reach into
 * `@mahiframework/core` for it — bodies are app-rendered strings (there is no
 * bundled template engine that would auto-escape), so this is the
 * framework's supported escaping primitive for that path.
 */
export function escapeHtml(value: string): string {
  return Str.escapeHtml(value);
}
