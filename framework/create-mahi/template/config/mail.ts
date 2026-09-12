import type { MailConfig } from "@mahiframework/mail";
import type { Env } from "./env.js";

/**
 * Mail configuration. `default` names the mailer used when
 * `MailManager.send()` is called without an explicit `{ mailer }` — kept
 * on `"log"` by default so local development and tests never attempt a real
 * SMTP connection (the log mailer writes the rendered message through
 * `app.logger`). Point `MAIL_MAILER=smtp` (with the SMTP_* vars set) in
 * production, or set it to `"array"` in tests to capture messages in memory.
 *
 * `from` is the process-wide default sender applied to any Mailable that
 * doesn't set its own `from()` — mirrors Laravel's `mail.from` global.
 *
 * `themes` configures `MailMessage` rendering. Each entry is a look a
 * message can select by name — `new MailMessage()` uses `default`,
 * `new MailMessage("alternative")` uses `alternative`. A name listed here
 * with no registered factory gets the built-in theme configured with these
 * settings, so a second look costs no code; register a factory with
 * `MailManager.extendTheme(name, ...)` when a theme needs real logic.
 */
export function mailConfig(env: Env): MailConfig {
  return {
    default: env.MAIL_MAILER,
    from: { address: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME },
    themes: {
      default: { productName: env.MAIL_FROM_NAME },
      alternative: { productName: env.MAIL_FROM_NAME, primaryColor: "#7c3aed" },
    },
    mailers: {
      log: {},
      array: {},
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } : undefined,
        pool: true,
        requireTLS: env.SMTP_REQUIRE_TLS,
      },
    },
  };
}
