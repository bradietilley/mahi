import { DateTime } from "@mahiframework/datetime";
import { Session } from "../models/session.js";
import type { SessionRecord, SessionStore } from "./session-store.js";

/**
 * Sessions in a `sessions` table. The default store: survives process
 * restarts, works across multiple processes, and is queryable (so "log
 * this user out everywhere" is one statement).
 *
 * Has no automatic expiry mechanism, so `gc()` must be run periodically.
 * See the `auth:gc` command.
 */
export class DatabaseSessionStore implements SessionStore {
  async read(id: string): Promise<SessionRecord | null> {
    const row = await Session.find(id);

    if (row === undefined) {
      return null;
    }

    // Expiry is enforced on read rather than relying on gc() having run,
    // gc() is a cleanup job, not a correctness guarantee. Treating a
    // stale row as valid because the cron hasn't fired would be a real
    // vulnerability.
    if (row.expires_at.isPast()) {
      return null;
    }

    // `SessionRecord.expiresAt` is ISO text on the wire (it crosses into
    // the cookie/driver-agnostic session layer), so it is serialised
    // here rather than leaking a `DateTime` through that contract.
    return { id: row.id, userId: row.user_id, expiresAt: row.expires_at.toISOString() };
  }

  async write(id: string, userId: string, expiresAt: string): Promise<void> {
    const now = DateTime.now();
    await Session.create({
      id,
      user_id: userId,
      expires_at: DateTime.fromISO(expiresAt),
      created_at: now,
      last_active_at: now,
    });
  }

  async touch(id: string, expiresAt: string): Promise<void> {
    await Session.update(id, {
      expires_at: DateTime.fromISO(expiresAt),
      last_active_at: DateTime.now(),
    });
  }

  async destroy(id: string): Promise<void> {
    await Session.delete(id);
  }

  async destroyForUser(userId: string): Promise<void> {
    await Session.query().where("user_id", userId).delete();
  }

  async destroyForUserExcept(userId: string, exceptId: string): Promise<void> {
    await Session.query().where("user_id", userId).where("id", "!=", exceptId).delete();
  }

  async gc(): Promise<number> {
    return Session.query().where("expires_at", "<=", DateTime.now()).delete();
  }
}
