/**
 * The name → route lookup that makes named routes (and therefore
 * `URL.route("posts.show", { post })`) possible. One `RouteRegistry` is
 * owned by the `HttpKernel` and threaded into the root `Router` and every
 * `group()` sub-router, so a `.name(...)` call anywhere registers into the
 * same shared table.
 *
 * Paths are stored in their original `{param}` form (never the Hono `:param`
 * form the router hands to Hono), because that's the form the URL generator
 * substitutes parameters into.
 */
export interface NamedRoute {
  /** HTTP method(s) this route answers, uppercased (e.g. `["GET"]`). */
  methods: string[];
  /** Full path in `{param}` form, e.g. `/posts/{post}`. */
  path: string;
}

export class RouteRegistry {
  private byName = new Map<string, NamedRoute>();

  /**
   * Register a named route. Throws if the name is already taken — route
   * names must be unique so `URL.route(name)` is unambiguous, matching
   * Laravel's duplicate-name detection.
   */
  register(name: string, route: NamedRoute): void {
    const existing = this.byName.get(name);

    if (existing) {
      throw new Error(
        `Route name "${name}" is already registered for [${existing.methods.join("|")} ${existing.path}]; ` +
          `route names must be unique.`,
      );
    }

    this.byName.set(name, route);
  }

  /** Resolve a name back to its route, or `undefined` if unknown. */
  get(name: string): NamedRoute | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Every registered name, for `route:list` and debugging. */
  all(): ReadonlyMap<string, NamedRoute> {
    return this.byName;
  }
}
