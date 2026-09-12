import { Facade } from "@mahiframework/facades";
import type { MailManager, QueueMailOptions } from "./mail-manager.js";
import type { MailTransport } from "./mail-transport.js";
import type { SentMessage } from "./sent-message.js";
import type { Mailable } from "./mailable.js";
import { MAIL_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `MailManager` singleton bound at `MAIL_TOKEN`, for
 * call sites that would otherwise read
 * `app().make<MailManager>(MAIL_TOKEN).send(...)` — the mail analogue of
 * `Bus`.
 *
 *   await Mail.send(new WelcomeMailable(user));
 *   await Mail.mailer("smtp").send(rendered);
 *
 * Unlike Laravel's `Mail::to(...)->send(...)`, there is no `to()` on the
 * facade: recipients belong to the `Mailable` (its `envelope()`/`to()`),
 * keeping the "who receives this" decision in one place rather than split
 * between the facade call and the mailable. Prefer constructor-injecting
 * `MailManager` (via `MAIL_TOKEN`) where practical — reach for this only
 * where threading `app`/`MailManager` through is genuinely inconvenient,
 * same guidance as `app()` itself.
 */
export class Mail extends Facade<MailManager>(() => MAIL_TOKEN) {
  static send(mailable: Mailable, options?: { mailer?: string }): Promise<SentMessage> {
    return this.instance().send(mailable, options);
  }

  /**
   * Render now, deliver later through the queue.
   *
   * The rendered body is written to the `jobs` table in plaintext — never
   * queue a message carrying a password-reset link, magic link or one-time
   * code. See `MailManager.queue()`.
   */
  static queue(mailable: Mailable, options?: QueueMailOptions): Promise<void> {
    return this.instance().queue(mailable, options);
  }

  static mailer(name?: string): MailTransport {
    return this.instance().mailer(name);
  }
}
