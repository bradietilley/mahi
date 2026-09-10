/**
 * A model class, as a value: an ordinary constructor function.
 *
 * `abstract new` so both concrete models and abstract bases are
 * assignable — deliberately not `Function`, which would accept any
 * callable at all and let `gate.policy(someHelperFn, ...)` type-check.
 */
export type ModelClass = abstract new (...args: any[]) => unknown;

import type { AuthorizationResponse } from "./response.js";

/**
 * What an ability may return: a bare boolean, or an
 * `AuthorizationResponse` for a richer denial (custom message/status,
 * e.g. `denyAsNotFound()`) — sync or async either way.
 */
export type PolicyResult = boolean | AuthorizationResponse;

/**
 * A single ability implementation on a policy.
 *
 * `TRow` types the target the ability acts on — create-style abilities
 * take no row, hence the optional first element.
 */
export type PolicyMethod<TUser = unknown, TRow = unknown> = (
  user: TUser | null,
  ...args: [row?: TRow, ...rest: unknown[]]
) => PolicyResult | Promise<PolicyResult>;

/**
 * Per-model authorization.
 *
 * Every method takes the user FIRST — nullable, because unauthenticated
 * requests reach policies too (see `requireAuth`/`requireGuest` in
 * `guards.ts` for the two common ways to handle that) — then the target
 * row. Create-style abilities have no row yet, so they take just the user.
 *
 * Method names map to ability names verbatim: `Gate.authorize("update",
 * Todo, todo)` calls `policy.update(...)` and nothing else. No
 * snake_case/camelCase translation, so the mapping stays greppable.
 *
 * STATELESS BY CONTRACT: policies are instantiated once and cached, so
 * they must not hold per-request state — same contract as `Guard` in
 * `@mahi/auth`, and for the same reason (one long-lived
 * `Application` serves every concurrent request).
 *
 *   export class TodoPolicy extends Policy<UserRow, TodoTable> {
 *     view(user: UserRow | null, todo: TodoTable): boolean {
 *       if (todo.published) return true;
 *       return user !== null && todo.user_id === user.id;
 *     }
 *
 *     update = requireAuth<UserRow, [TodoTable]>((user, todo) => todo.user_id === user.id);
 *   }
 */
export abstract class Policy<TUser = unknown, TRow = unknown> {
  /**
   * Index signature so arbitrary ability names type-check on subclasses.
   * The `| unknown` arm is what allows non-method properties; ability
   * methods themselves are documented by `PolicyMethod<TUser, TRow>`.
   */
  [ability: string]: PolicyMethod<TUser, TRow> | unknown;
}

export type PolicyClass = new () => Policy<any, any>;
