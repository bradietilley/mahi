export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
}

/**
 * Server-side session storage. The session *data* never leaves the
 * server — the cookie carries only a signed id — which is what makes a
 * session revocable by deleting its row. That revocability is the same
 * argument that rules out JWT for this framework's auth.
 */
export interface SessionStore {
  /** Return the session if it exists AND has not expired, else null. */
  read(id: string): Promise<SessionRecord | null>;

  write(id: string, userId: string, expiresAt: string): Promise<void>;

  /** Extend an existing session's expiry (sliding window). No-op if absent. */
  touch(id: string, expiresAt: string): Promise<void>;

  destroy(id: string): Promise<void>;

  /** Delete every session belonging to a user ("log out everywhere"). */
  destroyForUser(userId: string): Promise<void>;

  /**
   * Delete every session belonging to a user EXCEPT the one with
   * `exceptId` ("log out everywhere else"). Backs
   * `SessionGuard.logoutOtherDevices()`.
   */
  destroyForUserExcept(userId: string, exceptId: string): Promise<void>;

  /**
   * Delete expired sessions; returns how many were removed. Driven by the
   * `auth:gc` command — a database-backed store has no automatic expiry,
   * so without this the table grows forever.
   */
  gc(): Promise<number>;
}
