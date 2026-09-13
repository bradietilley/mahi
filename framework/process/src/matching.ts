/**
 * Minimal `*`-wildcard glob matcher, port of the matching behavior
 * behind Laravel's `Process::fake(['ls *' => ...])`/`assertRan('ls *')`
 * (Laravel delegates to `Illuminate\Support\Str::is()`). Hand-rolled
 * rather than pulling in a glob-matching dependency, consistent with
 * the framework's established "minimal dependencies" pattern.
 */
export function wildcardMatch(pattern: string, subject: string): boolean {
  if (pattern === subject) {
    return true;
  }

  // Escape every regex metacharacter except `*` (which becomes `.*`
  // below). `?` in particular must be treated as a literal, Laravel's
  // `Str::is` only gives `*` special meaning, so `"git?"` matches the
  // literal string `git?`, not `gi`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  return new RegExp(`^${escaped}$`).test(subject);
}

/** Renders a command (string or argv array) down to the single string every match/log/assert operation works against. */
export function commandToString(command: string | string[]): string {
  return Array.isArray(command) ? command.join(" ") : command;
}
