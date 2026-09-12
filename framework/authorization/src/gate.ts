import { app as globalApp, AUTH_TOKEN, type Application } from "@mahiframework/core";
import { HttpError } from "@mahiframework/http";
import type { ModelClass, Policy, PolicyClass, PolicyMethod, PolicyResult } from "./policy.js";
import { AuthorizationResponse, isAuthorizationResponse } from "./response.js";

/**
 * A gate ability. The rest parameters are `any[]`, not `unknown[]`, on
 * purpose: a concretely typed ability like `(user, post: Post) => ...`
 * must be assignable here, and TypeScript's contravariant parameter check
 * rejects `Post` against `unknown`. The same rationale applies to
 * `BeforeCallback`/`AfterCallback` below and to `@mahiframework/cache`'s
 * `LimiterCallback`.
 */
export type Ability<TUser = unknown> = (
  user: TUser | null,
  ...args: any[]
) => PolicyResult | Promise<PolicyResult>;

/** Return true/false to decide immediately, or null to fall through. */
export type BeforeCallback<TUser = unknown> = (
  user: TUser | null,
  ability: string,
  ...args: any[]
) => boolean | null | Promise<boolean | null>;

export type AfterCallback<TUser = unknown> = (
  user: TUser | null,
  ability: string,
  result: boolean,
  ...args: any[]
) => boolean | null | Promise<boolean | null>;

// The token `@mahiframework/auth` binds its `AuthManager` under, resolved by
// string at runtime rather than by importing `@mahiframework/auth`, so this
// package takes NO compile-time dependency on it — authorization is useful
// against a user from anywhere (a third-party identity provider, a queue
// job, a test), and `forUser()` covers those. The token literal comes from
// `@mahiframework/core`'s `well-known-tokens` (imported above), the shared
// source of truth both this package and `@mahiframework/auth` agree on — so
// a typo can't silently diverge into a `BindingNotFoundError`. Same
// soft-dependency shape `@mahiframework/schedule` uses for `QUEUE_TOKEN`.

interface CurrentUserSource {
  userOrNull(): unknown | null;
}

/**
 * Central registry of abilities and policies.
 *
 * Deliberately NOT a `Manager<T>` package: there are no swappable
 * drivers here, and forcing the manager shape onto a single concrete
 * registry would be cargo-culting the pattern rather than using it.
 */
export class GateRegistry {
  private abilities = new Map<string, Ability>();
  private policies = new Map<ModelClass, PolicyClass>();
  private policyInstances = new Map<PolicyClass, Policy>();
  private beforeCallbacks: BeforeCallback[] = [];
  private afterCallbacks: AfterCallback[] = [];

  constructor(private readonly app?: Application) {}

  /** Register a standalone ability not tied to a model. */
  define<TUser = unknown>(ability: string, callback: Ability<TUser>): this {
    this.abilities.set(ability, callback as Ability);

    return this;
  }

  /**
   * Register a policy class against a model class.
   *
   * The model is named by CLASS, not by string: a class reference is
   * compile-checked and survives renames, whereas a typo'd string would
   * fail closed and silently (see the resolution rules below), which is
   * the worst failure mode an authorization system can have — it looks
   * like it's working.
   */
  policy(model: ModelClass, policy: PolicyClass): this {
    this.policies.set(model, policy);

    return this;
  }

  /**
   * Runs before every check. Return true/false to short-circuit, or null
   * to fall through to normal resolution. The documented seam for
   * "superadmins can do anything".
   */
  before<TUser = unknown>(callback: BeforeCallback<TUser>): this {
    this.beforeCallbacks.push(callback as BeforeCallback);

    return this;
  }

  /** Runs after a non-short-circuited check; may override the result. */
  after<TUser = unknown>(callback: AfterCallback<TUser>): this {
    this.afterCallbacks.push(callback as AfterCallback);

    return this;
  }

  has(ability: string): boolean {
    return this.abilities.has(ability);
  }

  hasPolicy(model: ModelClass): boolean {
    return this.policies.has(model);
  }

  /** A gate bound to an explicit user — for queue jobs, CLI commands, tests. */
  forUser<TUser = unknown>(user: TUser | null): UserGate {
    return new UserGate(this, user);
  }

  async allows(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.check(this.currentUser(), ability, args);
  }

  async denies(ability: string, ...args: unknown[]): Promise<boolean> {
    return !(await this.allows(ability, ...args));
  }

  /**
   * Throws when denied, honouring an `AuthorizationResponse`'s `status`
   * and `message` if the policy returned one — so `denyAsNotFound()`
   * throws a 404, a plain deny throws 403. Falls back to a generic 403
   * for a bare `false`.
   */
  async authorize(ability: string, ...args: unknown[]): Promise<void> {
    const response = await this.inspect(this.currentUser(), ability, args);
    throwIfDenied(response);
  }

  /**
   * Resolve several abilities for one target at once — for embedding a
   * `can: { update: true, delete: false }` block in an API response so a
   * detached frontend can render correctly (hide the delete button)
   * without replicating the policy logic client-side.
   */
  async abilitiesFor(
    abilities: string[],
    model: ModelClass,
    row?: unknown,
  ): Promise<Record<string, boolean>> {
    const user = this.currentUser();
    const args = row === undefined ? [model] : [model, row];

    const entries = await Promise.all(
      abilities.map(async (ability) => [ability, await this.check(user, ability, args)] as const),
    );

    return Object.fromEntries(entries);
  }

  /**
   * Boolean form of the resolution pipeline — the common case. Delegates
   * to `inspect()` and collapses the response to its `allowed` flag.
   */
  async check(user: unknown | null, ability: string, args: unknown[]): Promise<boolean> {
    return (await this.inspect(user, ability, args)).allowed;
  }

  /**
   * The resolution pipeline, shared by every entry point, returning an
   * `AuthorizationResponse` so a policy's custom message/status survives
   * all the way to `authorize()`.
   *
   * 1. `before()` hooks, in registration order — a non-null result wins
   *    immediately and skips `after()`.
   * 2. If `args[0]` is a model class WITH A REGISTERED POLICY, dispatch to
   *    `policy[ability](user, ...rest)`. A missing method denies.
   * 3. Otherwise a `define()`d ability, called with `(user, ...args)`.
   * 4. Otherwise deny.
   * 5. `after()` hooks, which may override.
   *
   * Steps 2 and 4 are deliberately FAIL-CLOSED. Throwing on an unknown
   * ability would surface typos more loudly, but a typo that 500s in
   * production is worse than one that 403s — and step 2 must not throw
   * regardless, because policies legitimately implement only a subset of
   * abilities.
   *
   * `before()`/`after()` hooks still speak plain booleans (their override
   * semantics predate rich responses and are unchanged); only the policy/
   * ability body in the middle may return an `AuthorizationResponse`.
   */
  async inspect(
    user: unknown | null,
    ability: string,
    args: unknown[],
  ): Promise<AuthorizationResponse> {
    for (const callback of this.beforeCallbacks) {
      const decided = await callback(user, ability, ...args);

      if (decided !== null && decided !== undefined) {
        return normalize(decided);
      }
    }

    let response = normalize(await this.resolve(user, ability, args));

    for (const callback of this.afterCallbacks) {
      const overridden = await callback(user, ability, response.allowed, ...args);

      if (overridden !== null && overridden !== undefined) {
        response = normalize(overridden);
      }
    }

    return response;
  }

  private async resolve(
    user: unknown | null,
    ability: string,
    args: unknown[],
  ): Promise<PolicyResult> {
    const [first, ...rest] = args;

    // Dispatch keys off the policy registry by exact identity rather than
    // inspecting the argument's shape — model classes are ordinary
    // constructor functions, so there's no heuristic guessing about what
    // "looks like" a model.
    if (typeof first === "function" && this.policies.has(first as ModelClass)) {
      const policy = this.policyFor(first as ModelClass);
      const method = policyMethod(policy, ability);

      if (method === undefined) {
        return false;
      }

      return (await method.call(policy, user, ...rest)) as PolicyResult;
    }

    const registered = this.abilities.get(ability);

    if (registered === undefined) {
      return false;
    }

    return (await registered(user, ...args)) as PolicyResult;
  }

  /** Instantiated once and cached — see `Policy`'s statelessness contract. */
  private policyFor(model: ModelClass): Policy {
    const policyClass = this.policies.get(model)!;

    const cached = this.policyInstances.get(policyClass);

    if (cached !== undefined) {
      return cached;
    }

    const instance = new policyClass();
    this.policyInstances.set(policyClass, instance);

    return instance;
  }

  /**
   * The current user from `@mahiframework/auth`'s AsyncLocalStorage scope.
   *
   * Returns null when auth isn't installed at all, so a gate can still be
   * used in an app with no authentication (every check then sees a
   * guest). It does NOT swallow `MissingAuthContextError` — being outside
   * a request scope entirely is a programming error that should surface,
   * and `forUser()` is the supported way to authorize without one.
   */
  private currentUser(): unknown | null {
    const container = this.app ?? globalApp();

    if (!container.has(AUTH_TOKEN)) {
      return null;
    }

    return container.make<CurrentUserSource>(AUTH_TOKEN).userOrNull();
  }
}

/** A `GateRegistry` bound to an explicit user, bypassing the ambient scope. */
export class UserGate {
  constructor(
    private readonly gate: GateRegistry,
    private readonly user: unknown | null,
  ) {}

  async allows(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.gate.check(this.user, ability, args);
  }

  async denies(ability: string, ...args: unknown[]): Promise<boolean> {
    return !(await this.allows(ability, ...args));
  }

  async authorize(ability: string, ...args: unknown[]): Promise<void> {
    const response = await this.gate.inspect(this.user, ability, args);
    throwIfDenied(response);
  }
}

/**
 * Names that are never abilities, however a policy is written.
 *
 * `constructor` is an own property of every class prototype, so a plain
 * lookup for it finds the class itself — `allows("constructor", Post)`
 * then called that constructor without `new` and threw a `TypeError` out
 * of the gate. The rest live on `Object.prototype` and would resolve to
 * built-ins that return nonsense (`toString` is a function, so it would
 * be *called*, and its string result treated as a policy decision).
 *
 * All of them are reachable by anyone who can influence an ability name,
 * and all of them turned an authorization check into a 500 or a
 * meaningless result where a clean deny was correct.
 */
const RESERVED_ABILITY_NAMES = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

/**
 * The policy method implementing `ability`, or undefined.
 *
 * Walks the prototype chain so an ability inherited from a shared base
 * policy still resolves, but stops at `Object.prototype` and refuses the
 * reserved names above — the two ways a lookup could escape the policy's
 * own surface. Fails closed: anything that isn't a function found on the
 * policy itself is "no such ability", i.e. a deny.
 */
function policyMethod(policy: Policy, ability: string): PolicyMethod | undefined {
  if (RESERVED_ABILITY_NAMES.has(ability)) {
    return undefined;
  }

  for (
    let target: object | null = policy;
    target !== null && target !== Object.prototype;
    target = Object.getPrototypeOf(target) as object | null
  ) {
    if (Object.hasOwn(target, ability)) {
      const candidate = (target as Record<string, unknown>)[ability];

      return typeof candidate === "function" ? (candidate as PolicyMethod) : undefined;
    }
  }

  return undefined;
}

/**
 * Coerce a policy/ability/hook return value into an `AuthorizationResponse`.
 *
 * A returned `AuthorizationResponse` passes through untouched. Everything
 * else must be STRICTLY `true` to allow — a stray truthy non-boolean (a
 * promise, an object, the string `"yes"`) is treated as denial, the same
 * fail-closed rule the boolean-only pipeline enforced before rich
 * responses existed.
 */
function normalize(result: PolicyResult): AuthorizationResponse {
  if (isAuthorizationResponse(result)) {
    return result;
  }

  return result === true ? AuthorizationResponse.allow() : AuthorizationResponse.deny();
}

/**
 * Throw the right `HttpError` for a denied response, or return quietly if
 * allowed. A response with an explicit `status`/`message` shapes the
 * error (e.g. `denyAsNotFound()` → 404); otherwise it's a generic 403.
 */
function throwIfDenied(response: AuthorizationResponse): void {
  if (response.allowed) {
    return;
  }

  if (response.status === 404) {
    throw HttpError.notFound(response.message);
  }

  if (response.status !== undefined && response.status !== 403) {
    throw new HttpError(response.status, response.message ?? "Forbidden");
  }

  throw HttpError.forbidden(response.message);
}
