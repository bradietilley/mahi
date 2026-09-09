/**
 * The parsed shape of an eager-load request — the state behind
 * `EloquentBuilder.with()` and `Model.load()`.
 *
 * ## Why a tree
 *
 * A flat queue of local relation names (`eagerLoad: string[]`) makes
 * three things impossible: a dot path (`with("author.team")` — no place
 * to hang the second segment), a constraining closure (no per-name
 * payload), and `morphWith` (no per-discriminant payload). All three are
 * properties of a *node*, not of a flat list, so the request is a tree
 * of them.
 *
 * The query-count contract: one batched query per relation **node** in
 * the tree. A three-level path is three queries no matter how many rows
 * are involved — never N+1. (`morphTo` is the documented exception at
 * O(distinct types).)
 */

/** A single relation in a parsed eager-load request. */
export interface EagerLoadNode {
  /** The local relation name — one dot-path segment, never a path itself. */
  name: string;

  /**
   * The caller's constraining closure, applied to the related model's
   * builder before the batched `whereIn` runs. For a `morphTo` node it
   * receives a `MorphToSpec` instead (per-type `constrain()`/`morphWith()`),
   * since there is no single related builder to hand over.
   */
  constrain?: (query: any) => void;

  /** Nested relations to load against whatever this node attaches. */
  children: Map<string, EagerLoadNode>;

  /**
   * Per-discriminant child trees for a `morphTo`, populated by
   * `morphWith()`. Keyed by the discriminant value the declaration's
   * `types` map uses; a type absent from the map simply loads no
   * children.
   */
  morphWith?: Map<string, Map<string, EagerLoadNode>>;
}

/** A parsed eager-load request: relation name → node. */
export type EagerLoadTree = Map<string, EagerLoadNode>;

/** What `with()`/`load()` accept: bare names/dot paths, or a `{ path: constraint }` map. */
export type EagerLoadRequest = readonly string[] | Record<string, (query: any) => void>;

function emptyNode(name: string): EagerLoadNode {
  return { name, children: new Map() };
}

/**
 * Merges one dot path into `tree`, attaching `constrain` to the path's
 * **last** segment.
 *
 * Merge semantics follow Laravel's `parseWithRelations`: a path implies
 * every prefix of itself, and repeated prefixes reuse the same node
 * rather than duplicating it. So `with("author.team")` then
 * `with("author.posts")` yields ONE `author` node with two children —
 * hence one `author` query, not two. A later constraint on an existing
 * node replaces that node's constraint (last call wins) rather than
 * silently dropping it.
 */
export function mergePath(
  tree: EagerLoadTree,
  path: string,
  constrain?: (query: any) => void,
): void {
  const segments = path.split(".");
  let level = tree;
  let node: EagerLoadNode | undefined;

  for (const segment of segments) {
    if (segment === "") {
      throw new Error(
        `with("${path}"): the path has an empty segment — check for a stray or doubled ".".`,
      );
    }

    node = level.get(segment);

    if (!node) {
      node = emptyNode(segment);
      level.set(segment, node);
    }

    level = node.children;
  }

  if (constrain && node) {
    node.constrain = constrain;
  }
}

/** Parses a `with()`/`load()` argument list into a tree, merging into `tree` if given. */
export function parseEagerLoad(
  request: EagerLoadRequest,
  tree: EagerLoadTree = new Map(),
): EagerLoadTree {
  if (Array.isArray(request)) {
    for (const path of request as readonly string[]) {
      mergePath(tree, path);
    }

    return tree;
  }

  for (const [path, constrain] of Object.entries(request as Record<string, (query: any) => void>)) {
    mergePath(tree, path, constrain);
  }

  return tree;
}

/** Whether a `with()` argument is the object (constraining) form rather than varargs names. */
export function isConstraintMap(value: unknown): value is Record<string, (query: any) => void> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-copies a tree so a `clone()`d builder can't mutate the original's nodes. */
export function cloneTree(tree: EagerLoadTree): EagerLoadTree {
  const copy: EagerLoadTree = new Map();

  for (const [name, node] of tree) {
    copy.set(name, cloneNode(node));
  }

  return copy;
}

function cloneNode(node: EagerLoadNode): EagerLoadNode {
  const copy: EagerLoadNode = {
    name: node.name,
    children: cloneTree(node.children),
  };

  if (node.constrain) {
    copy.constrain = node.constrain;
  }

  if (node.morphWith) {
    copy.morphWith = new Map();

    for (const [type, children] of node.morphWith) {
      copy.morphWith.set(type, cloneTree(children));
    }
  }

  return copy;
}

/**
 * Collects the per-type constraints and nested loads a `morphTo`'s
 * constraining callback declares.
 *
 * Split out of `MorphToBuilder` (which extends it) because the batched
 * eager loader needs the same collecting surface *without* a parent
 * instance to build against: `with({ commentable: (m) => m.morphWith(…) })`
 * is called once for the whole page of rows, long before any individual
 * row's discriminant is read. Sharing the class keeps the callback's API
 * identical whether it runs against one row or a batch.
 */
export class MorphToSpec {
  protected constraints: Record<string, (query: any) => void> = {};
  protected morphWithTrees: Map<string, EagerLoadTree> = new Map();

  /**
   * Registers per-type constraining callbacks, merged with any already
   * set. Each receives the target model's own `EloquentBuilder`, so its
   * scopes and custom builder methods are available:
   *
   *   .constrain({
   *     post:  (q) => q.where("published", 1),
   *     video: (q) => q.where("visibility", "public"),
   *   })
   *
   * Types absent from the map are left unconstrained — this filters what
   * a resolved parent must look like, it does not restrict which types
   * are resolvable.
   */
  constrain(callbacks: Record<string, (query: any) => void>): this {
    this.constraints = { ...this.constraints, ...callbacks };

    return this;
  }

  /**
   * Declares nested relations to eager-load per morph type — Laravel's
   * `morphWith()`.
   *
   *   Comment.query().with({
   *     commentable: (m) => m.morphWith({
   *       post:  ["author", "tags"],
   *       video: ["channel"],
   *     }),
   *   });
   *
   * `with("commentable.author")` can't express this: the segment after
   * the dot has to name a relation on ONE related model, and a morphTo
   * has several. Keying by discriminant is what makes it well-defined —
   * `Post` has `tags`, `Video` needn't.
   *
   * A type absent from the map loads no children (not an error — a mixed
   * page routinely contains types you have nothing extra to load for).
   * Costs no extra queries beyond the children themselves, since a
   * `morphTo` already resolves one query per distinct type.
   */
  morphWith(map: Record<string, EagerLoadRequest>): this {
    for (const [type, request] of Object.entries(map)) {
      const existing = this.morphWithTrees.get(type) ?? new Map();
      this.morphWithTrees.set(type, parseEagerLoad(request, existing));
    }

    return this;
  }

  /** The per-type constraint registered for `type`, if any. */
  constraintFor(type: string): ((query: any) => void) | undefined {
    return this.constraints[type];
  }

  /** The collected `morphWith` trees, keyed by discriminant. */
  morphWithTreesByType(): Map<string, EagerLoadTree> {
    return this.morphWithTrees;
  }
}
