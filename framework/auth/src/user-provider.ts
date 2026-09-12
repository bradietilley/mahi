/**
 * Where users come from — deliberately decoupled from how a request is
 * authenticated (`Guard`), so the token guard and the session guard share
 * one user source, and so an app can swap SQLite for an external identity
 * service without touching guard code.
 */

export interface Credentials {
  [key: string]: string;
}

export interface UserProvider<TUser = unknown> {
  retrieveById(id: string): Promise<TUser | null>;

  /**
   * Look a user up by their identifying credential (email, username, ...)
   * WITHOUT checking the secret.
   *
   * The split between this and `validateCredentials` is intentional and
   * should not be "simplified" into a single `findByCredentials` that
   * checks the password too: keeping lookup and verification separate is
   * what lets `AuthManager.attempt()` perform a constant-work password
   * hash even when no user was found, so response timing doesn't leak
   * whether an account exists.
   */
  retrieveByCredentials(credentials: Credentials): Promise<TUser | null>;

  validateCredentials(user: TUser, credentials: Credentials): Promise<boolean>;

  /**
   * Persist a new (already-hashed) password for `user`.
   *
   * Optional because not every user source is writable — an external
   * identity service might own credentials elsewhere. `PasswordBroker`
   * requires it and fails loudly if the configured provider doesn't
   * implement it, rather than silently no-op'ing a password change.
   */
  updatePassword?(user: TUser, hashedPassword: string): Promise<void>;
}

export type UserProviderFactory = (config: unknown) => UserProvider;
