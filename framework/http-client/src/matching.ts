import { Str } from "@mahiframework/core";

/**
 * `*`-wildcard match, the behaviour behind Laravel's
 * `Http::fake(['github.com/*' => ...])`/`assertSent('github.com/*')`,
 * which delegate to `Str::is()`. Delegates to `@mahiframework/core`'s `Str.is`
 * rather than carrying its own copy, so `?` and every other regex
 * metacharacter are literals here exactly as they are everywhere else.
 */
export function wildcardMatch(pattern: string, subject: string): boolean {
  return Str.is(pattern, subject);
}

/**
 * `wildcardMatch` with Laravel's implicit leading `*` (`Str::start($url, '*')`
 * in `PendingRequest::stubUrl`), so a stub pattern of `"github.com/*"`
 * matches `"https://api.github.com/repos"` without the caller having to
 * write the scheme and subdomain out.
 *
 * Deliberately **not** used for `allowStrayRequests()` allow-lists, which
 * match on the bare pattern, an explicit escape from the stray guard is
 * worth spelling out in full. Matches Laravel's `isAllowedRequestUrl`.
 */
export function urlMatch(pattern: string, url: string): boolean {
  return wildcardMatch(pattern.startsWith("*") ? pattern : `*${pattern}`, url);
}
