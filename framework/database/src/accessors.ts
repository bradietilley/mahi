/**
 * Computed-attribute (accessor) definitions — the runtime behind a model's
 * `static accessors` map and the `Computed<T>` markers in its attributes
 * interface.
 *
 *   interface PostAttributes {
 *     …
 *     excerpt: Computed<string>;
 *   }
 *
 *   class Post extends Model<PostAttributes>()({ …, appends: ["excerpt"] }) {
 *     static override accessors = {
 *       excerpt: accessor((post) => post.body.slice(0, 120)),
 *     };
 *   }
 *
 * `post.excerpt` reads through the getter; `appends` decides whether it is
 * included in `toJSON()`. An optional setter lets `post.full_name = "…"`
 * write back to real columns.
 */

/** A resolved accessor definition — a getter, plus an optional setter. */
export interface AccessorDefinition<M, T> {
  get(model: M): T;
  set?(model: M, value: T): void;
}

/** The `static accessors` map's shape for an instance type `M` and computed keys. */
export type AccessorMap<M> = Record<string, AccessorDefinition<M, any>>;

/**
 * Declares a computed attribute. Pass a getter directly, or an object
 * with `get`/`set` for a writable accessor:
 *
 *   excerpt:   accessor((post) => post.body.slice(0, 120)),
 *   full_name: accessor({
 *     get: (u) => `${u.first} ${u.last}`,
 *     set: (u, value) => { const [f, l] = value.split(" "); u.first = f; u.last = l ?? ""; },
 *   }),
 */
export function accessor<M, T>(get: (model: M) => T): AccessorDefinition<M, T>;
export function accessor<M, T>(definition: AccessorDefinition<M, T>): AccessorDefinition<M, T>;
export function accessor<M, T>(
  getOrDefinition: ((model: M) => T) | AccessorDefinition<M, T>,
): AccessorDefinition<M, T> {
  return typeof getOrDefinition === "function" ? { get: getOrDefinition } : getOrDefinition;
}
