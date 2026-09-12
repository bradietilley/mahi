import type { AnyModelClass } from "@mahiframework/database";
import type { Hasher } from "@mahiframework/encryption";
import type { Credentials, UserProvider } from "../user-provider.js";

/**
 * Read a runtime-named column off a user object. The user's type is only
 * constrained to `object` (see the note on `DatabaseUserProvider`), so the
 * indexed read goes through `unknown` — the caller narrows the result.
 */
function columnOf(user: object, column: string): unknown {
  return (user as Record<string, unknown>)[column];
}

export interface DatabaseUserProviderConfig {
  /** The model class backing users, e.g. the app's own `User`. */
  model: AnyModelClass;
  /** Column holding the login identifier. Defaults to `"email"`. */
  identifierColumn?: string;
  /** Column holding the password hash. Defaults to `"password"`. */
  passwordColumn?: string;
}

/**
 * Retrieves users from any `Model` subclass, verifying passwords with the
 * app's `Hasher` (argon2).
 *
 * Lookups go through `Model.query()`, NOT `queryWithoutScopes()`, so
 * global scopes apply — a `SoftDeletes` user model therefore stops
 * authenticating deleted users with no extra code here.
 */
// `TUser extends object`, not `Record<string, unknown>`: an `interface` has
// no implicit index signature, so `interface UserAttributes { ... }` — the
// form the model docs teach — can never satisfy a `Record` constraint,
// while an otherwise identical `type` alias can. The constraint exists only
// so a runtime-chosen column can be read off the user, which the local
// `columnOf()` helper does instead.
export class DatabaseUserProvider<
  TUser extends object = Record<string, unknown>,
> implements UserProvider<TUser> {
  constructor(
    private readonly config: DatabaseUserProviderConfig,
    private readonly hasher: Hasher,
  ) {}

  private get identifierColumn(): string {
    return this.config.identifierColumn ?? "email";
  }

  private get passwordColumn(): string {
    return this.config.passwordColumn ?? "password";
  }

  async retrieveById(id: string): Promise<TUser | null> {
    const row = await this.config.model.find(id);

    return (row as TUser | undefined) ?? null;
  }

  async retrieveByCredentials(credentials: Credentials): Promise<TUser | null> {
    const value = credentials[this.identifierColumn];

    if (value === undefined || value === "") {
      return null;
    }

    const row = await this.config.model.query().where(this.identifierColumn, value).first();

    return (row as TUser | undefined) ?? null;
  }

  async validateCredentials(user: TUser, credentials: Credentials): Promise<boolean> {
    const hash = columnOf(user, this.passwordColumn);

    if (typeof hash !== "string") {
      // Burn a hash before failing, so a user with no password (a
      // null column: SSO-only, invited-but-not-yet-registered) is
      // indistinguishable by timing from one whose password was simply
      // wrong. Returning early here made "this account has no password"
      // measurably faster than "wrong password" — an oracle for which
      // accounts can be attacked by other means.
      await this.hasher.make(credentials.password ?? "");

      return false;
    }

    return this.hasher.check(credentials.password ?? "", hash);
  }

  /**
   * Write a new (already-hashed) password back to the user's row, keyed
   * by the model's primary key. Used by `PasswordBroker.reset()`.
   */
  async updatePassword(user: TUser, hashedPassword: string): Promise<void> {
    const id = columnOf(user, this.config.model.primaryKeyColumn);
    await this.config.model.update(String(id), { [this.passwordColumn]: hashedPassword });
  }
}
