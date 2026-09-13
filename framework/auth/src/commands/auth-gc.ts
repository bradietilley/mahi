import { Command } from "@mahiframework/cli";
import { Auth } from "../auth-facade.js";

/**
 * Delete expired sessions, personal access tokens, AND password-reset
 * tokens.
 *
 * Every one of those stores enforces expiry on read, so a stale row is
 * never *honoured*, but nothing deletes them either, so the tables grow
 * unboundedly without this. Kept as one `auth:gc` command (rather than a
 * per-store family) to match the "gc" naming already established.
 * Schedule it; it's a cleanup job, not a correctness guarantee.
 *
 * Every guard that can collect garbage is swept, discovered by
 * capability rather than by hardcoded name, an app naming its guards
 * `web`/`api` (Laravel's convention) has no guard called "session" at
 * all.
 */
export class AuthGcCommand extends Command {
  signature = "auth:gc";
  description = "Delete expired sessions, access tokens, and password-reset tokens.";

  async handle(): Promise<void> {
    const manager = Auth.instance();

    let collected = 0;

    for (const [name, guard] of manager.collectableGuards()) {
      const removed = await guard.gc();
      collected += removed;
      this.app.logger.info(`auth:gc removed ${removed} expired record(s) from guard "${name}".`);
    }

    if (collected === 0) {
      this.app.logger.info("auth:gc found no expired guard records.");
    }

    const resets = await manager.passwordBroker().gc();
    this.app.logger.info(`auth:gc removed ${resets} expired password-reset token(s).`);
  }
}
